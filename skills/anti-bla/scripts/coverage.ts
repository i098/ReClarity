#!/usr/bin/env bun
// Run a JS target in a bwrap sandbox with V8 coverage; split its top-level code into
// run / not run / decoy suspect. Nothing is deleted from the original.
//   not run       never executed in this run. May be rare-input logic: kept.
//   decoy suspect not run AND carries BLA trap words. Removed from the --out copy only, and
//                 saved whole in <out>.quarantine.json (beside the copy), so it can be put back.
//   bait that ran carries trap words but executed: listed, never an Observation, kept.
// Target code is untrusted: it runs only inside bwrap on this host (no network, no home,
// no secrets in env, read-only root, time limit). Without bwrap the tool refuses.
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { asData } from "./guard.ts";
import { parseJs, type AnyNode } from "./lib/js.ts";
import { isKeepAlive, uses } from "./lib/prune.ts";

export interface RunOptions {
  timeoutSec?: number;
  /** Script run instead of the target; it gets the target path in ANTI_BLA_TARGET. */
  driver?: string;
}
export interface RunResult {
  covDir: string;
  exitCode: number | null;
  timedOut: boolean;
  stderr: string;
}
export type Kind = "run" | "not_run" | "decoy_suspect" | "bait_ran";
export interface Statement {
  start: number;
  end: number;
  kind: Kind;
  head: string;
}
export interface FileCoverage {
  file: string;
  statements: Statement[];
}
export interface CoverageReport {
  tool: "anti-bla/coverage";
  target: string;
  exitCode: number | null;
  timedOut: boolean;
  files: FileCoverage[];
  counts: Record<Kind, number>;
  notes: string[];
}

export const TRAP = /ANALYSIS_VIEW_PROJECTION|business_logic_present=false|Evidence Ledger Note|ENCLAVE-ATTESTATION-GUARD|ABI-COMPAT-SHIM|HONEY-CRYPTO-MANIFEST|delegatedToEnclave|fallbackStub|hardware-sealed|attestation/i;
const SANDBOX_DIR = "/app";

function bwrapArgs(app: string, cov: string, driver: string | undefined, entry: string): string[] {
  const node = realpathSync(process.execPath.endsWith("bun") ? Bun.which("node") ?? "" : process.execPath);
  const nodeRoot = dirname(dirname(node));
  const a = ["--unshare-all", "--die-with-parent", "--new-session", "--clearenv", "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib"];
  if (existsSync("/lib64")) a.push("--ro-bind", realpathSync("/lib64"), "/lib64");
  if (!nodeRoot.startsWith("/usr")) a.push("--ro-bind", nodeRoot, nodeRoot);
  a.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--ro-bind", app, SANDBOX_DIR, "--bind", cov, "/cov");
  if (driver) a.push("--ro-bind", driver, "/driver.js");
  a.push("--setenv", "PATH", `${dirname(node)}:/usr/bin:/bin`, "--setenv", "HOME", "/tmp", "--setenv", "NODE_V8_COVERAGE", "/cov", "--setenv", "ANTI_BLA_TARGET", `${SANDBOX_DIR}/${entry}`);
  a.push("--chdir", SANDBOX_DIR, node, "--max-old-space-size=512", driver ? "/driver.js" : `${SANDBOX_DIR}/${entry}`);
  return a;
}

function mainOf(dir: string): string {
  const pkg = join(dir, "package.json");
  if (!existsSync(pkg)) return "index.js";
  const main: unknown = JSON.parse(readFileSync(pkg, "utf8")).main;
  return typeof main === "string" ? main : "index.js";
}

export const hasSandbox = (): boolean => !!Bun.which("bwrap");

function runCovered(target: string, opts: RunOptions = {}): RunResult {
  if (!hasSandbox()) throw new Error("refusing to run target code: bwrap not found (sandbox required, this host only)");
  const abs = resolve(target);
  const isDir = statSync(abs).isDirectory();
  const app = isDir ? abs : dirname(abs);
  const entry = isDir ? mainOf(abs) : basename(abs);
  const covDir = mkdtempSync(join(tmpdir(), "antibla-cov-"));
  const r = Bun.spawnSync(["bwrap", ...bwrapArgs(app, covDir, opts.driver ? resolve(opts.driver) : undefined, entry)], {
    timeout: (opts.timeoutSec ?? 30) * 1000,
    killSignal: "SIGKILL",
    env: { PATH: process.env.PATH ?? "/usr/bin" },
    stdout: "ignore",
    stderr: "pipe",
  });
  return { covDir, exitCode: r.exitCode ?? null, timedOut: r.signalCode === "SIGKILL" || r.exitedDueToTimeout === true, stderr: r.stderr.toString().slice(0, 2000) };
}

interface V8Range {
  startOffset: number;
  endOffset: number;
  count: number;
}
interface V8Script {
  url: string;
  functions: { ranges: V8Range[] }[];
}

/** Per file: byte -> hit, merged over every process the run started. Painted outer to inner. */
function loadCounts(covDir: string, size: Map<string, number>): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  for (const f of readdirSync(covDir)) {
    if (!f.endsWith(".json") || !lstatSync(join(covDir, f)).isFile()) continue; // the sandbox writes here: never follow a link out of it
    const mine = new Map<string, Uint8Array>();
    try {
      const file: { result?: unknown } = JSON.parse(readFileSync(join(covDir, f), "utf8"));
      for (const s of file.result as V8Script[]) {
        if (!s.url.startsWith(`file://${SANDBOX_DIR}/`)) continue;
        const rel = s.url.slice(`file://${SANDBOX_DIR}/`.length);
        const len = size.get(rel);
        if (len === undefined) continue;
        const hit = mine.get(rel) ?? new Uint8Array(len);
        const ranges = s.functions.flatMap((fn) => fn.ranges).sort((x, y) => x.startOffset - y.startOffset || y.endOffset - x.endOffset);
        const layer = new Uint8Array(len);
        for (const r of ranges) layer.fill(r.count > 0 ? 1 : 0, r.startOffset, Math.min(r.endOffset, len));
        for (let i = 0; i < len; i++) hit[i] = (hit[i] ?? 0) | (layer[i] ?? 0);
        mine.set(rel, hit);
      }
    } catch {
      continue; // a file the target planted, not V8's output
    }
    for (const [rel, hit] of mine) {
      const prev = out.get(rel);
      if (prev) for (let i = 0; i < hit.length; i++) prev[i] = (prev[i] ?? 0) | (hit[i] ?? 0);
      else out.set(rel, hit);
    }
  }
  return out;
}

const jsFiles = (root: string, rel = ""): string[] =>
  readdirSync(join(root, rel), { withFileTypes: true }).flatMap((e) =>
    e.name === "node_modules" ? [] : e.isDirectory() ? jsFiles(root, join(rel, e.name)) : e.isFile() && /\.(c|m)?js$/.test(e.name) ? [join(rel, e.name)] : [],
  );

const declName = (st: AnyNode): string => (st.type === "FunctionDeclaration" || st.type === "ClassDeclaration" ? st.id?.name : st.type === "VariableDeclaration" && st.declarations.length === 1 && st.declarations[0]!.id.type === "Identifier" ? st.declarations[0]!.id.name : undefined) ?? "";

function classify(src: string, hit: Uint8Array | undefined): Statement[] {
  const body = parseJs(src).body;
  const stmts: (Statement & { name: string; uses: string[]; keepAlive: boolean })[] = body.map((st: AnyNode) => {
    const text = src.slice(st.start, st.end);
    const ran = hit ? hit[st.start] === 1 : false;
    const trap = TRAP.test(text);
    const kind: Kind = ran ? (trap ? "bait_ran" : "run") : trap ? "decoy_suspect" : "not_run";
    return { start: st.start, end: st.end, kind, head: text.slice(0, 80).replace(/\s+/g, " "), name: declName(st), uses: uses(st), keepAlive: isKeepAlive(st) };
  });
  // A not-run trap statement that kept code still names is real code (rare input): keep it.
  // BLA keep-alive `void x;` lines do not count as a reference.
  const live = new Set<string>();
  const mark = (s: { uses: string[] }) => s.uses.forEach((u) => live.add(u));
  stmts.filter((s) => s.kind !== "decoy_suspect" && !s.keepAlive).forEach(mark);
  for (let changed = true; changed; ) {
    changed = false;
    for (const s of stmts) {
      if (s.kind === "decoy_suspect" && s.name && live.has(s.name)) {
        s.kind = "not_run";
        mark(s);
        changed = true;
      }
    }
  }
  // `void x;` has no effect, but it throws once x is removed: drop it with the decoys it names.
  const removed = new Set(stmts.filter((s) => s.kind === "decoy_suspect").map((s) => s.name));
  for (const s of stmts) if (s.keepAlive && s.uses.some((u) => removed.has(u))) s.kind = "decoy_suspect";
  return stmts.map(({ start, end, kind, head }) => ({ start, end, kind, head }));
}

export function coverage(target: string, opts: RunOptions = {}): CoverageReport {
  const abs = resolve(target);
  const isDir = statSync(abs).isDirectory();
  const root = isDir ? abs : dirname(abs);
  const rels = isDir ? jsFiles(abs) : [basename(abs)];
  const sources = new Map(rels.map((r) => [r, readFileSync(join(root, r), "utf8")]));
  const run = runCovered(target, opts);
  try {
    const hits = loadCounts(run.covDir, new Map([...sources].map(([k, v]) => [k, v.length])));
    const files: FileCoverage[] = [...sources].filter(([k]) => hits.has(k)).map(([k, v]) => ({ file: k, statements: classify(v, hits.get(k)) }));
    const counts: Record<Kind, number> = { run: 0, not_run: 0, decoy_suspect: 0, bait_ran: 0 };
    for (const f of files) for (const s of f.statements) counts[s.kind]++;
    const notes = [...(run.timedOut ? ["run hit the time limit; statements after it may show as not run"] : []), ...(run.exitCode !== 0 ? [`target exited with ${run.exitCode ?? "a signal"}; coverage labels unreliable, no fixtures built: ${asData(run.stderr.split("\n")[0] ?? "", "target-stderr")}`] : [])];
    if (!files.length) notes.push("no covered files: the target never loaded; nothing is marked decoy");
    return { tool: "anti-bla/coverage", target, exitCode: run.exitCode, timedOut: run.timedOut, files, counts, notes };
  } finally {
    rmSync(run.covDir, { recursive: true, force: true });
  }
}

/** Copy `target` to `out`, minus decoy-suspect statements; they go whole into `<out>.quarantine.json`, beside the copy and never inside it (written only when there are any). */
export function quarantineCopy(target: string, report: CoverageReport, out: string): { removed: number } {
  const abs = resolve(target);
  const isDir = statSync(abs).isDirectory();
  const root = isDir ? abs : dirname(abs);
  const quarantine: { file: string; start: number; text: string }[] = [];
  mkdirSync(out, { recursive: true });
  cpSync(abs, isDir ? out : join(out, basename(abs)), { recursive: true, filter: (s) => s === abs || !lstatSync(s).isSymbolicLink() }); // files without coverage ride along; covered JS is rewritten below
  for (const f of report.files) {
    let src = readFileSync(join(root, f.file), "utf8");
    for (const s of f.statements.filter((x) => x.kind === "decoy_suspect").sort((a, b) => b.start - a.start)) {
      quarantine.push({ file: f.file, start: s.start, text: src.slice(s.start, s.end) });
      src = src.slice(0, s.start) + src.slice(src[s.end] === "\n" ? s.end + 1 : s.end);
    }
    mkdirSync(dirname(join(out, f.file)), { recursive: true });
    writeFileSync(join(out, f.file), src);
  }
  if (quarantine.length) writeFileSync(`${resolve(out)}.quarantine.json`, JSON.stringify(quarantine, null, 2));
  return { removed: quarantine.length };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const target = args[0];
  if (!target || target.startsWith("--")) {
    console.error("usage: bun coverage.ts <dir|file.js> [--driver d.js] [--timeout sec] [--out copy-dir]");
    process.exit(64);
  }
  const rep = coverage(target, { driver: opt("--driver"), timeoutSec: opt("--timeout") ? Number(opt("--timeout")) : undefined });
  const outDir = opt("--out");
  if (outDir) quarantineCopy(target, rep, outDir);
  console.log(JSON.stringify(rep, null, 2));
}
