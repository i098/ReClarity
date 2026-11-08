// Fixtures: tests/fixtures/ledger.bla.py and ledger.py<ver>.bla.pyc are real `bla protect --intensity bankrupt
// --seed fixture-1 --weave-decoys` output (BLA 3.1.0) for ledger.py. The plain .pyc files are ledger.py compiled.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coverage, quarantineCopy } from "../scripts/coverage.ts";
import { PYC_STEMS } from "../scripts/lib/pytarpit.ts";
import { cleanPyc, pycMagic, pythonForMagic } from "../scripts/lib/pybox.ts";
import { prepare } from "../scripts/run.ts";
import { sanitize } from "../scripts/sanitize.ts";
import { scan } from "../scripts/scan.ts";
import { FIXTURES, readFixture } from "./fixtures/make.ts";

const sandboxWorks = !!Bun.which("bwrap") && Bun.spawnSync(["bwrap", "--ro-bind", "/", "/", "true"]).exitCode === 0;
const tmp = mkdtempSync(join(tmpdir(), "antibla-py-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const LEDGER_OUT = "total 26\ndiscount 90.0\nlicense True\n";
/** Blank lines dropped: BLA leaves its own spacing behind, which cleaning does not restore. */
const squash = (s: string): string => s.split("\n").filter((l) => l.trim()).join("\n");
const pyDir = (name: string, files: Record<string, string | Buffer>): string => {
  const d = join(tmp, name);
  mkdirSync(d, { recursive: true });
  for (const [f, body] of Object.entries(files)) writeFileSync(join(d, f), body);
  return d;
};
// BLA decoys print hash()-based numbers, so the seed is pinned
const runPy = (python: string, file: string): string => Bun.spawnSync([python, "-I", file], { stdout: "pipe", stderr: "pipe", env: { PYTHONHASHSEED: "0" } }).stdout.toString();

describe("scan: Python shapes", () => {
  test("real BLA tarpit source is flagged; the plain source scores 0", () => {
    const hard = scan(join(FIXTURES, "ledger.bla.py"));
    expect(hard.level).toBe("hardened");
    expect(hard.findings.find((f) => f.id === "python_tarpit")!.count).toBeGreaterThanOrEqual(10);
    expect(scan(join(FIXTURES, "ledger.py")).score).toBe(0);
  });

  test("a lone decoy-shaped def is not a tarpit", () => {
    const f = pyDir("lone", { "a.py": "def reduce_pipeline_shard_4575(seed: int = 0, depth: int = 0) -> int:\n    return seed\n" });
    expect(scan(f).score).toBe(0);
  });

  test("real BLA .pyc decoy code objects and honey trailer are flagged; the plain .pyc scores 0", () => {
    for (const v of ["39", "312", "314"]) {
      const hard = scan(join(FIXTURES, `ledger.py${v}.bla.pyc`));
      expect(hard.findings.map((f) => f.id)).toEqual(expect.arrayContaining(["pyc_decoy_code", "bait_text"]));
      expect(scan(join(FIXTURES, `ledger.py${v}.pyc`)).score).toBe(0);
    }
  });

  test("a PyInstaller archive gets a note: its .pyc files are not cleaned", () => {
    const exe = Buffer.concat([Buffer.from("\x7fELF"), Buffer.alloc(1 << 20), Buffer.from("MEI\x0c\x0b\x0a\x0b\x0e"), Buffer.alloc(80)]);
    const r = scan(pyDir("pyi", { app: exe }));
    expect(r.notes.join(" ")).toContain("PyInstaller");
  });

});

describe.skipIf(!sandboxWorks)("coverage.py tarpit", () => {
  test("real BLA tarpit: decoys, state, slot, weave lines and warm-up call go; real code stays and runs the same", () => {
    const app = pyDir("bla", { "main.py": readFileSync(join(FIXTURES, "ledger.bla.py")) });
    const rep = coverage(app);
    expect(rep.exitCode).toBe(0);
    expect(rep.counts.decoy_suspect + rep.counts.tarpit_ran).toBeGreaterThan(25);
    const out = join(tmp, "bla-out");
    const { removed } = quarantineCopy(app, rep, out);
    expect(removed).toBeGreaterThan(30);
    const cleaned = readFileSync(join(out, "main.py"), "utf8");
    expect(squash(cleaned)).toBe(squash(readFileSync(join(FIXTURES, "ledger.py"), "utf8")));
    expect(cleaned).not.toMatch(/enclave|attestation|BUNDLE_RECORD/i);
    expect(runPy("python3", join(out, "main.py"))).toBe(LEDGER_OUT);
    expect(readFileSync(`${out}.quarantine.json`, "utf8")).toContain("BUNDLE_RECORD_SHARED_SLOT_580A");
    expect(readFileSync(join(app, "main.py"), "utf8")).toContain("BUNDLE_RECORD"); // original untouched
  });

  test("a decoy that real code calls stays, with what it names; the rest of the tarpit still goes", () => {
    const bla = readFileSync(join(FIXTURES, "ledger.bla.py"), "utf8");
    const decoy = bla.match(/^def (\w+_[0-9a-f]{4})\(seed: int = 0, depth: int = 0\) -> int:$/m)![1]!;
    const src = bla.replace('\nif __name__ == "__main__":', `\nprint("decoy", ${decoy}(3, 0))\nif __name__ == "__main__":`);
    expect(src).not.toBe(bla);
    const app = pyDir("called", { "main.py": src });
    const rep = coverage(app);
    const out = join(tmp, "called-out");
    quarantineCopy(app, rep, out);
    const cleaned = readFileSync(join(out, "main.py"), "utf8");
    expect(cleaned).toContain(`def ${decoy}(`);
    expect(cleaned).toContain("hydrate_session_cache_1234");
    expect(cleaned.length).toBeLessThan(src.length); // the called decoy keeps the decoys it calls: that part of the tarpit stays
    const before = runPy("python3", join(app, "main.py"));
    expect(runPy("python3", join(out, "main.py"))).toBe(before);
  });

  test("a decoy another file imports stays", () => {
    const bla = readFileSync(join(FIXTURES, "ledger.bla.py"), "utf8");
    const decoy = bla.match(/^def (\w+_[0-9a-f]{4})\(seed: int = 0, depth: int = 0\) -> int:$/m)![1]!;
    const app = pyDir("imported", { "ledger.py": bla.replace('if __name__ == "__main__":', "if False:"), "main.py": `import ledger\nprint(ledger.${decoy}(1, 0))\n` });
    const out = join(tmp, "imported-out");
    quarantineCopy(app, coverage(app), out);
    expect(readFileSync(join(out, "ledger.py"), "utf8")).toContain(`def ${decoy}(`);
  });

  test("decoy-looking names without the tarpit's state, slot and count are never removed", () => {
    const src = [1, 2, 3].map((i) => `def reduce_pipeline_shard_46${i}5(seed: int = 0, depth: int = 0) -> int:\n    return seed\n`).join("\n");
    const app = pyDir("lookalike", { "main.py": `${src}\nprint("ok")\n` });
    const rep = coverage(app);
    expect(rep.counts.decoy_suspect + rep.counts.tarpit_ran).toBe(0);
    const out = join(tmp, "lookalike-out");
    expect(quarantineCopy(app, rep, out).removed).toBe(0);
    expect(readFileSync(join(out, "main.py"), "utf8")).toBe(readFileSync(join(app, "main.py"), "utf8"));
  });

  test("a target that crashes quarantines nothing", () => {
    const bla = readFileSync(join(FIXTURES, "ledger.bla.py"), "utf8");
    const app = pyDir("crash", { "main.py": bla.replace('\nif __name__ == "__main__":', '\nraise SystemExit(3)\nif __name__ == "__main__":') });
    const rep = coverage(app);
    expect(rep.exitCode).toBe(3);
    const out = join(tmp, "crash-out");
    expect(quarantineCopy(app, rep, out).removed).toBe(0);
    expect(readFileSync(join(out, "main.py"), "utf8")).toBe(readFileSync(join(app, "main.py"), "utf8"));
  });

  test("target runs without network, home files or inherited secrets", () => {
    process.env.ANTI_BLA_TEST_SECRET = "leak";
    const secret = join(tmp, "py-secret.txt");
    writeFileSync(secret, "s3cret");
    const app = pyDir("jail", {
      "main.py": `import os, socket, sys
leaked = 0
if os.environ.get("ANTI_BLA_TEST_SECRET"): leaked |= 1
try:
    open(${JSON.stringify(secret)}); leaked |= 2
except OSError: pass
try:
    open("/app/x", "w"); leaked |= 4
except OSError: pass
try:
    socket.create_connection(("1.1.1.1", 80), timeout=1); leaked |= 8
except OSError: pass
sys.exit(leaked)
`,
    });
    const r = coverage(app);
    delete process.env.ANTI_BLA_TEST_SECRET;
    expect(r.exitCode).toBe(0);
  });

  test("run.ts prepare: a Python folder with --coverage comes back clean", () => {
    const app = pyDir("prep", { "main.py": readFileSync(join(FIXTURES, "ledger.bla.py")) });
    const work = join(tmp, "prep-work");
    mkdirSync(work);
    const notes: string[] = [];
    const prepared = prepare(app, work, "a", true, notes);
    expect(scan(prepared).score).toBe(0);
    expect(runPy("python3", join(prepared, "main.py"))).toBe(LEDGER_OUT);
  });
});

describe.skipIf(!sandboxWorks)(".pyc decoys", () => {
  const versions = ["39", "312", "314"].filter((v) => pythonForMagic(pycMagic(readFixture(`ledger.py${v}.pyc`))!));

  test("an interpreter is found for at least one fixture version", () => {
    expect(versions.length).toBeGreaterThan(0);
  });

  for (const v of ["39", "312", "314"]) {
    test.skipIf(!versions.includes(v))(`py${v}: real BLA .pyc loses decoy code and honey trailer, keeps real code, runs the same`, () => {
      const src = join(FIXTURES, `ledger.py${v}.bla.pyc`);
      const py = pythonForMagic(pycMagic(readFixture(`ledger.py${v}.bla.pyc`))!)!;
      const out = join(tmp, `clean-${v}.pyc`);
      const r = cleanPyc(src, out);
      if (r.kind !== "cleaned") throw new Error(r.why);
      expect(r.removed.length).toBeGreaterThanOrEqual(20);
      expect(r.trailerDropped).toBeGreaterThan(5000);
      const text = readFileSync(out).toString("latin1");
      const names = (text.match(new RegExp(`(?:${PYC_STEMS.join("|")})_[1-9]\\d{3}`, "g")) ?? []).filter((n) => n !== "hydrate_session_cache_1234"); // that one is real code in ledger.py
      expect(names).toEqual([]);
      expect(text).not.toContain("Evidence Ledger Note");
      for (const name of ["total", "apply_discount", "check_license", "rare_export", "main", "hydrate_session_cache_1234"]) expect(text).toContain(name);
      expect(runPy(py, out)).toBe(LEDGER_OUT);
      expect(scan(out).score).toBe(0);
    });
  }

  test("a decoy-shaped code object that bytecode references is real code and stays", () => {
    const py = Bun.which("python3")!;
    const f = join(tmp, "named.py");
    writeFileSync(f, "def reduce_pipeline_shard_4575(): pass\nreduce_pipeline_shard_4575()\nprint('ran')\n");
    expect(Bun.spawnSync([py, "-I", "-c", `import py_compile;py_compile.compile(${JSON.stringify(f)}, cfile=${JSON.stringify(join(tmp, "named.pyc"))})`]).exitCode).toBe(0);
    const r = cleanPyc(join(tmp, "named.pyc"), join(tmp, "named.out.pyc"));
    if (r.kind !== "cleaned") throw new Error(r.why);
    expect(r.removed).toEqual([]);
    expect(runPy(py, join(tmp, "named.out.pyc"))).toBe("ran\n");
  });

  test("every stem in PYC_STEMS names a removable decoy for the cleaner", () => {
    const py = Bun.which("python3")!;
    const mk = [
      "import sys, marshal, importlib.util",
      "stems = sys.argv[2:]",
      "d = compile('None', 'd', 'exec')",
      "m = compile('print(\"ran\")', 'm', 'exec')",
      "decoys = [d.replace(co_name=s + '_1234', **({'co_qualname': s + '_1234'} if hasattr(d, 'co_qualname') else {})) for s in stems]",
      "m = m.replace(co_consts=m.co_consts + tuple(decoys))",
      "open(sys.argv[1], 'wb').write(importlib.util.MAGIC_NUMBER + b'\\0' * 12 + marshal.dumps(m))",
    ].join("\n");
    expect(Bun.spawnSync([py, "-I", "-c", mk, join(tmp, "stems.pyc"), ...PYC_STEMS]).exitCode).toBe(0);
    const r = cleanPyc(join(tmp, "stems.pyc"), join(tmp, "stems.out.pyc"));
    if (r.kind !== "cleaned") throw new Error(r.why);
    expect([...r.removed].sort()).toEqual(PYC_STEMS.map((s) => `${s}_1234`).sort());
    expect(runPy(py, join(tmp, "stems.out.pyc"))).toBe("ran\n");
  });

  test("sanitize cleans BLA .pyc files in a folder, copies the plain one byte for byte, leaves the original alone", () => {
    const v = versions[0]!;
    const dir = pyDir("pycs", { "bla.pyc": readFixture(`ledger.py${v}.bla.pyc`), "plain.pyc": readFixture(`ledger.py${v}.pyc`) });
    const before = readFileSync(join(dir, "bla.pyc"));
    const rep = sanitize(dir, join(tmp, "pycs-out"));
    expect(rep.actions.map((a) => a.kind).sort()).toEqual(["pyc-decoys-dropped"]);
    expect(readFileSync(join(tmp, "pycs-out", "plain.pyc")).equals(readFixture(`ledger.py${v}.pyc`))).toBe(true);
    expect(scan(join(tmp, "pycs-out")).score).toBe(0);
    expect(readFileSync(join(dir, "bla.pyc")).equals(before)).toBe(true);
  });

  test("a .pyc no installed python reads is copied unchanged and reported", () => {
    const odd = Buffer.from(readFixture("ledger.py312.bla.pyc"));
    odd.writeUInt16LE(60000, 0); // magic no interpreter has
    const dir = pyDir("odd", { "odd.pyc": odd });
    const rep = sanitize(dir, join(tmp, "odd-out"));
    expect(rep.actions.map((a) => a.kind)).toEqual(["pyc-kept-unchanged"]);
    expect(readFileSync(join(tmp, "odd-out", "odd.pyc")).equals(odd)).toBe(true);
  });
});
