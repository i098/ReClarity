#!/usr/bin/env bun
// Side-by-side benchmark: plain (no preparation), LASIK (pktq/lasik) and ReClarity on the same BLA-hardened builds.
// For REA, "plain" means the hardened build goes to REA as it is. This script does not run REA or an agent: the answer
// it checks is what the build computes. A prepared copy is "correct" when the oracle (fixtures/check.cjs, check_py.py,
// the SQLite view) gives the same output as on the unhardened app. A smaller copy that changes behaviour counts as wrong.
//   bun docs/benchmark/bench-lasik.ts --bla 3.2.1=/path/to/bla --bla 3.5.9=/path/to/bla --lasik /path/to/lasik/dist/cli.js \
//       --work /tmp/bench [--seeds s1,s2] [--out docs/benchmark/results/<name>.json]
import { Database } from "bun:sqlite";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { loadavg } from "node:os";
import { openAsar } from "../../skills/anti-bla/scripts/lib/asar.ts";
import { TRAP } from "../../skills/anti-bla/scripts/lib/trap.ts";
import { prepare } from "../../skills/anti-bla/scripts/run.ts";

const HERE = import.meta.dir;
const FX = join(HERE, "fixtures");
const REPO = resolve(HERE, "../..");
const args = process.argv.slice(2);
const opts = (n: string) => args.flatMap((a, i) => (a === n ? [args[i + 1]!] : []));
const work = resolve(opts("--work")[0] ?? "/tmp/bench");
const lasik = opts("--lasik")[0];
const blas = opts("--bla").map((s) => s.split("=") as [string, string]);
const seedFilter = opts("--seeds")[0]?.split(",");
const outFile = opts("--out")[0];
if (!lasik || !blas.length) {
  console.error("usage: bun bench-lasik.ts --bla <ver>=<bla bin> [--bla ...] --lasik <lasik dist/cli.js> --work <dir> [--seeds s1,s2] [--out file.json]");
  process.exit(64);
}

const SEEDS: Record<string, string[]> = {
  s1: ["--seed", "s1"],
  s2: ["--seed", "s2"],
  s3: ["--seed", "s3"],
  s4all: ["--seed", "s4", "--self-seal", "--llm-directives", "--weave-decoys"],
  s5bal: ["--seed", "s5", "--intensity", "balanced"],
};
type Arm = "plain" | "lasik" | "reclarity";
const ARMS: Arm[] = ["plain", "lasik", "reclarity"];
export interface Cell {
  arm: Arm;
  /** equal: same output as the unhardened build. diff: runs, other output. crash: throws or exits non-zero. */
  behaviour: "equal" | "diff" | "crash" | "tool-failed";
  prepMs: number;
  bytesBefore: number;
  bytesAfter: number;
  trapWords: number;
  note?: string;
}

const sh = (cmd: string, cwd?: string, timeout = 300_000) => {
  const r = Bun.spawnSync(["bash", "-c", cmd], { cwd, stdout: "pipe", stderr: "pipe", timeout, killSignal: "SIGKILL" });
  return { code: r.exitCode ?? -1, out: r.stdout.toString(), err: r.stderr.toString() };
};
const timed = <T>(f: () => T): [T, number] => {
  const t = performance.now();
  const v = f();
  return [v, Math.round(performance.now() - t)];
};
const walkFiles = (p: string): string[] => (lstatSync(p).isDirectory() ? readdirSync(p).flatMap((e) => walkFiles(join(p, e))) : [p]);
const treeBytes = (p: string) => (existsSync(p) ? walkFiles(p).reduce((n, f) => n + (lstatSync(f).isSymbolicLink() ? 0 : statSync(f).size), 0) : 0);
const trapCount = (p: string): number => (existsSync(p) ? walkFiles(p).filter((f) => !lstatSync(f).isSymbolicLink() && statSync(f).size < 64e6).reduce((n, f) => n + (readFileSync(f).toString("latin1").match(new RegExp(TRAP.source, "gi"))?.length ?? 0), 0) : 0);

// ---- oracles ----
const baseline = (cmd: string): string => {
  const r = sh(cmd, FX);
  if (r.code !== 0 || !r.out.trim()) throw new Error(`baseline failed (${cmd}): exit ${r.code} ${r.err}`);
  return r.out.trim();
};
const baseJs = baseline(`node check.cjs app`);
const basePy = baseline(`python3 check_py.py release/engine.py`);

function jsOracle(root: string): "equal" | "diff" | "crash" {
  const rt = join(work, `rt-${Math.random().toString(36).slice(2)}`);
  mkdirSync(rt, { recursive: true });
  symlinkSync(resolve(root, "src"), join(rt, "src"));
  const r = sh(`node ${join(FX, "check.cjs")} ${rt}`, rt, 60_000);
  rmSync(rt, { recursive: true, force: true });
  if (r.code !== 0) return "crash";
  return r.out.trim() === baseJs ? "equal" : "diff";
}
const pyOracle = (file: string): "equal" | "diff" | "crash" => {
  const r = sh(`python3 ${join(FX, "check_py.py")} ${file}`, undefined, 60_000);
  return r.code !== 0 ? "crash" : r.out.trim() === basePy ? "equal" : "diff";
};
function asarOracle(file: string): "equal" | "diff" | "crash" {
  const dir = join(work, `x-${Math.random().toString(36).slice(2)}`);
  try {
    const a = openAsar(file);
    for (const f of a.files) {
      // the oracle needs only the app's own sources; BLA's flood entries have paths too long for a file system
      if (f.node.link !== undefined || f.node.unpacked || !/^(src\/|package\.json$)/.test(f.path)) continue;
      mkdirSync(dirname(join(dir, f.path)), { recursive: true });
      writeFileSync(join(dir, f.path), a.read(f));
    }
    a.close();
    return jsOracle(dir);
  } catch {
    return "crash";
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
function sqliteOracle(file: string): { behaviour: "equal" | "diff" | "crash"; extraObjects: number } {
  try {
    const db = new Database(file, { readonly: true });
    const rows = JSON.stringify(db.query("select * from v").all());
    const names = (db.query("select name from sqlite_master").all() as { name: string }[]).map((r) => r.name).filter((n) => !["users", "orders", "v"].includes(n) && !n.startsWith("sqlite_autoindex"));
    db.close();
    return { behaviour: rows === JSON.stringify([{ name: "ann", s: 9.5 }, { name: "bob", s: 3.25 }]) ? "equal" : "diff", extraObjects: names.length };
  } catch {
    return { behaviour: "crash", extraObjects: -1 };
  }
}

// ---- arms ----
function runLasik(input: string, out: string): { ms: number; ok: boolean; note?: string } {
  rmSync(out, { recursive: true, force: true });
  const [r, ms] = timed(() => sh(`node ${lasik} heal ${JSON.stringify(input)} -o ${JSON.stringify(out)} --json`));
  return { ms, ok: r.code === 0 && existsSync(out), note: r.code === 0 ? undefined : `exit ${r.code}: ${r.err.slice(0, 120)}` };
}
// Python source is cleaned only with coverage (never-run code is not enough alone), so that arm runs with it.
function runReclarity(input: string, tag: string, cov = false): { ms: number; path?: string; note?: string } {
  try {
    const [p, ms] = timed(() => prepare(input, join(work, "rc"), tag, cov));
    return { ms, path: p };
  } catch (e) {
    return { ms: 0, note: e instanceof Error ? e.message.slice(0, 120) : String(e) };
  }
}

// ---- JS builds ----
function buildJs(ver: string, bla: string, seed: string): string {
  const d = join(work, ver, "js", seed);
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  const app = join(d, "app");
  cpSync(join(FX, "app"), app, { recursive: true });
  mkdirSync(join(app, "dist"));
  sh(`mv src dist/src`, app);
  const r = sh(`${bla} harden . ${SEEDS[seed]!.join(" ")}`, app);
  if (!existsSync(join(app, ".bla-hardened", "dist"))) throw new Error(`BLA build failed for ${ver} ${seed}: ${(r.out + r.err).slice(0, 200)}`);
  sh(`cp -r .bla-hardened/dist/. dist/; rm -rf .bla-hardened .blarc*; mkdir -p ../proj; mv dist ../proj/dist`, app);
  return join(d, "proj", "dist");
}

function jsRows(ver: string, bla: string): Record<string, Cell[]> {
  const rows: Record<string, Cell[]> = {};
  for (const seed of Object.keys(SEEDS).filter((s) => !seedFilter || seedFilter.includes(s))) {
    const dist = buildJs(ver, bla, seed);
    const before = treeBytes(dist);
    const cells: Cell[] = [];
    const base = (arm: Arm) => ({ arm, bytesBefore: before });
    cells.push({ ...base("plain"), behaviour: jsOracle(dist), prepMs: 0, bytesAfter: before, trapWords: trapCount(dist) });
    const l = runLasik(dist, `${dist}.lasik`);
    cells.push(l.ok ? { ...base("lasik"), behaviour: jsOracle(`${dist}.lasik`), prepMs: l.ms, bytesAfter: treeBytes(`${dist}.lasik`), trapWords: trapCount(`${dist}.lasik`) } : { ...base("lasik"), behaviour: "tool-failed", prepMs: l.ms, bytesAfter: 0, trapWords: 0, note: l.note });
    const c = runReclarity(dist, `${ver}-${seed}`);
    cells.push(c.path ? { ...base("reclarity"), behaviour: jsOracle(c.path), prepMs: c.ms, bytesAfter: treeBytes(c.path), trapWords: trapCount(c.path) } : { ...base("reclarity"), behaviour: "tool-failed", prepMs: c.ms, bytesAfter: 0, trapWords: 0, note: c.note });
    rows[seed] = cells;
    console.error(`${ver} ${seed}: ${cells.map((x) => `${x.arm}=${x.behaviour}/${x.bytesAfter}B/${x.prepMs}ms`).join("  ")}`);
  }
  return rows;
}

// ---- ASAR + Python + SQLite release ----
function releaseRows(ver: string, bla: string): Record<string, Cell[]> {
  const d = join(work, ver, "release");
  rmSync(d, { recursive: true, force: true });
  mkdirSync(join(d, "app", "build"), { recursive: true });
  cpSync(join(FX, "release"), join(d, "app", "build", "release"), { recursive: true });
  sh(`${bla} harden . --seed m1`, join(d, "app"), 1_800_000);
  const hard = join(d, "hard");
  // BLA writes the ASAR first and the Python and SQLite files last; a killed run leaves them plain, which would make every arm look equal
  for (const f of ["engine.py", "data.sqlite"]) {
    const o = join(d, "app/.bla-hardened/build/release", f);
    if (!existsSync(o) || statSync(o).size <= statSync(join(FX, "release", f)).size) throw new Error(`${ver}: bla harden did not harden ${f}`);
  }
  mkdirSync(hard, { recursive: true });
  sh(`cp -r app/build/release/. hard/; cp -r app/.bla-hardened/build/release/. hard/`, d);
  const lOut = join(d, "hard.lasik");
  const l = runLasik(hard, lOut);
  const c = runReclarity(hard, `${ver}-release`);
  const trees: [Arm, string | undefined, number, string | undefined][] = [["plain", hard, 0, undefined], ["lasik", l.ok ? lOut : undefined, l.ms, l.note], ["reclarity", c.path, c.ms, c.note]];
  const rows: Record<string, Cell[]> = { asar: [], python: [], sqlite: [] };
  const py = runReclarity(join(hard, "engine.py"), `${ver}-pycov`, true);
  const pyOut = py.path && existsSync(py.path) && statSync(py.path).isDirectory() ? join(py.path, "engine.py") : py.path;
  for (const [arm, tree, ms, note] of trees) {
    for (const [name, file, check] of [
      ["asar", "app.asar", (f: string) => asarOracle(f)],
      ["python", "engine.py", (f: string) => pyOracle(f)],
      ["sqlite", "data.sqlite", (f: string) => sqliteOracle(f).behaviour],
    ] as const) {
      const before = statSync(join(hard, file)).size;
      const p = arm === "reclarity" && name === "python" ? (pyOut && existsSync(pyOut) ? pyOut : undefined) : tree && existsSync(join(tree, file)) ? join(tree, file) : undefined;
      if (!p) {
        rows[name]!.push({ arm, behaviour: "tool-failed", prepMs: ms, bytesBefore: before, bytesAfter: 0, trapWords: 0, note: note ?? "file missing in output" });
        continue;
      }
      const cell: Cell = { arm, behaviour: check(p), prepMs: ms, bytesBefore: before, bytesAfter: statSync(p).size, trapWords: name === "asar" ? 0 : trapCount(p) };
      if (arm === "reclarity" && name === "python") cell.prepMs = py.ms;
      if (name === "sqlite") cell.note = `${sqliteOracle(p).extraObjects} non-user objects left`;
      if (name === "asar") {
        const a = openAsar(p);
        cell.note = `ASAR header ${a.headerBytes} B`;
        a.close();
      }
      rows[name]!.push(cell);
    }
    console.error(`${ver} release ${arm}: ${["asar", "python", "sqlite"].map((n) => `${n}=${rows[n]!.at(-1)!.behaviour}`).join(" ")}`);
  }
  return rows;
}

// ---- other formats: BLA fixture vs its unhardened twin (byte equality) ----
const PAIRS: [string, string][] = [
  ["app.evm", "app.bla.evm"], ["app.flutter.so", "app.bla.flutter.so"], ["app.pcap", "app.bla.pcap"], ["app.sqlite", "app.bla.sqlite"], ["go.elf", "go.bla.elf"],
  ["ledger.py", "ledger.bla.py"], ["ledger.py312.pyc", "ledger.py312.bla.pyc"], ["ledger.py314.pyc", "ledger.py314.bla.pyc"], ["ledger.py37.pyc", "ledger.py37.bla.pyc"],
  ["tiny.beam", "tiny.bla.beam"], ["tiny.gguf", "tiny.bla.gguf"], ["tiny.safetensors", "tiny.bla.safetensors"], ["tiny.wasm", "tiny.bla.wasm"],
];
function formatRows(): Record<string, { arm: Arm; result: "restored" | "changed" | "unchanged" | "tool-failed"; ms: number }[]> {
  const fx = join(REPO, "skills/anti-bla/tests/fixtures");
  const rows: Record<string, { arm: Arm; result: "restored" | "changed" | "unchanged" | "tool-failed"; ms: number }[]> = {};
  for (const [plain, bla] of PAIRS) {
    const want = readFileSync(join(fx, plain));
    const hardened = readFileSync(join(fx, bla));
    const classify = (got: Buffer | undefined) => (!got ? "tool-failed" : got.equals(want) ? "restored" : got.equals(hardened) ? "unchanged" : "changed");
    const inDir = join(work, "fmt", bla, "in");
    rmSync(join(work, "fmt", bla), { recursive: true, force: true });
    mkdirSync(inDir, { recursive: true });
    cpSync(join(fx, bla), join(inDir, bla));
    const l = runLasik(inDir, join(work, "fmt", bla, "lasik"));
    const lf = join(work, "fmt", bla, "lasik", bla);
    const c = runReclarity(join(inDir, bla), `fmt-${bla}`);
    rows[bla] = [
      { arm: "plain", result: "unchanged", ms: 0 },
      { arm: "lasik", result: classify(l.ok && existsSync(lf) ? readFileSync(lf) : undefined), ms: l.ms },
      { arm: "reclarity", result: classify(c.path && existsSync(c.path) ? readFileSync(c.path) : undefined), ms: c.ms },
    ];
    console.error(`format ${bla}: ${rows[bla]!.map((r) => `${r.arm}=${r.result}`).join(" ")}`);
  }
  return rows;
}

mkdirSync(work, { recursive: true });
const git = (d: string) => {
  const h = sh(`git -C ${d} rev-parse HEAD`);
  const s = sh(`git -C ${d} status --porcelain`);
  if (h.code !== 0 || s.code !== 0) throw new Error(`git failed in ${d}: ${h.err}${s.err}`);
  return `${h.out.trim()}${s.out.trim() ? "+dirty" : ""}`;
};
const result = {
  date: new Date().toISOString(),
  host: { node: process.version, bun: Bun.version, load1: loadavg()[0] },
  reclarity: git(REPO),
  lasik: git(dirname(dirname(lasik))),
  versions: {} as Record<string, { bla: string; js: Record<string, Cell[]>; release: Record<string, Cell[]> }>,
  formats: formatRows(),
};
for (const [ver, bla] of blas) {
  const blaVersion = sh(`${bla} --version`).out.trim();
  result.versions[ver] = { bla: blaVersion, js: jsRows(ver, bla), release: releaseRows(ver, bla) };
}
if (outFile) writeFileSync(outFile, JSON.stringify(result, null, 2) + "\n");
else console.log(JSON.stringify(result, null, 2));
