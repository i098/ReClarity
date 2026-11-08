import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foldJs, foldPath } from "../scripts/fold-js.ts";
import { buildAsar, openAsar } from "../scripts/lib/asar.ts";
import { scan } from "../scripts/scan.ts";
import { readFixture } from "./fixtures/make.ts";

const tmp = mkdtempSync(join(tmpdir(), "antibla-fold-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const load = (code: string): Record<string, (...a: unknown[]) => unknown> => {
  const m = { exports: {} as Record<string, (...a: unknown[]) => unknown> };
  new Function("module", "require", code)(m, require);
  return m.exports;
};

describe("fold-js on real BLA 3.1.0 output", () => {
  const src = readFixture("main.bla.js").toString("utf8");
  const r = foldJs(src);
  const before = load(src);
  const after = load(r.code);

  test("folds seed predicates and cuts the decoy mass", () => {
    expect(r.stats.predicatesFolded).toBeGreaterThan(0);
    expect(r.stats.sinkCallsRemoved).toBeGreaterThan(0);
    expect(r.code.length).toBeLessThan(src.length / 10);
    expect(r.code).not.toContain("sourceMappingURL");
  });

  test("exports behave the same on common and rare input", () => {
    const inputs = ["Hello, World!", "a b  c", "", "AAAAAAA-PRO-1234", "AB-PRO-1234", "x-y"];
    for (const f of ["slugify", "wordCount", "checkLicense"]) for (const i of inputs) expect(after[f]!(i)).toEqual(before[f]!(i));
    for (const i of [[[1, 2], [3]], [], [[1]]]) expect(after.rareExport!(i)).toEqual(before.rareExport!(i));
  });

  test("the folded copy scores lower than the original", () => {
    const out = join(tmp, "main.js");
    writeFileSync(out, r.code);
    expect(scan(out).score).toBeLessThan(scan(join(import.meta.dir, "fixtures/main.bla.js")).score);
  });
});

describe("fold-js keeps what it cannot prove dead", () => {
  const seed = "const _s = 4098631152 | (typeof _d === \"function\" && _d(0) === 1282826635 ? 1 : 0);\n";

  test("rare-input logic survives: only seed predicates are folded", () => {
    const code = `${seed}function _d() { return 0; }\nfunction f(x) { if (x === 424242) { return "rare"; } if ((Math.imul(_s ^ 60, 1) & 7) === 0) { return "opaque"; } return "common"; }\nmodule.exports = { f };\n`;
    const out = foldJs(code).code;
    expect(out).toContain("424242");
    expect(load(out).f!(424242)).toBe("rare");
  });

  test("state read by live code is not treated as a sink", () => {
    const code = `${seed}let n = 0;\nfunction tick() { n = n + 1; return n; }\nfunction f() { tick(); return n; }\nmodule.exports = { f };\n`;
    const out = foldJs(code).code;
    expect(load(out).f!()).toBe(1);
  });

  test("a build without seeds is returned unchanged", () => {
    const code = "module.exports = { f: () => 1 };\n";
    expect(foldJs(code).code).toBe(code);
  });
});

describe("fold-js keeps behavior it cannot prove unchanged", () => {
  const seed = "const _s = 4098631152 | (typeof _d === \"function\" && _d(0) === 1282826635 ? 1 : 0);\nfunction _d() { return 0; }\n";

  test("a call that mutates its argument is kept", () => {
    const code = `${seed}const registry = new Map();\nfunction register(m) { m.set("a", 1); }\nregister(registry);\nmodule.exports = { has: (k) => registry.has(k) };\n`;
    expect(load(foldJs(code).code).has!("a")).toBe(true);
    const code2 = `${seed}const cfg = {};\nfunction init(c) { c.ready = true; }\ninit(cfg);\nmodule.exports = { ready: () => cfg.ready };\n`;
    expect(load(foldJs(code2).code).ready!()).toBe(true);
  });

  test("a call to a function that writes through `this` is kept", () => {
    const code = `${seed}function setup() { this.antiBlaThisProbe = true; }\nsetup();\nmodule.exports = { f: () => 1 };\n`;
    load(foldJs(code).code);
    expect((globalThis as Record<string, unknown>).antiBlaThisProbe).toBe(true);
    delete (globalThis as Record<string, unknown>).antiBlaThisProbe;
  });

  test("a call whose default parameter value has an outside effect is kept", () => {
    const code = `${seed}let c = 0;\nfunction bump(a = c++) {}\nbump();\nmodule.exports = { get: () => c };\n`;
    expect(load(foldJs(code).code).get!()).toBe(1);
  });

  test("a name that is rebound or not const is never treated as a seed", () => {
    const shadowed = "const flags = Number(process.argv[2]) | 1;\nfunction check(flags) { if ((flags & 1) === 1) return 'odd'; return 'even'; }\nmodule.exports = { check };\n";
    expect(load(foldJs(shadowed).code).check!(2)).toBe("even");
    const reassigned = "let h = 7 | 1;\nh = h + 1;\nfunction f() { if ((h & 1) === 0) return 'even'; return 'odd'; }\nmodule.exports = { f };\n";
    expect(load(foldJs(reassigned).code).f!()).toBe("even");
  });

  test("only a byte-masked `| 1` is a seed: a literal or unmasked left side keeps both arms", () => {
    const flags = "const FLAGS = 0x1000 | 1;\nfunction f() { if (FLAGS === 4097) return 'A'; return 'B'; }\nmodule.exports = { f };\n";
    expect(load(foldJs(flags).code).f!()).toBe("A");
    const mode = "const MODE = (process.env.MODE_NUM | 0) | 1;\nfunction g() { return MODE !== 4097 ? 'other' : 'special'; }\nmodule.exports = { g };\n";
    expect(foldJs(mode).code).toBe(mode);
    const masked = "const S = (process.pid & 0xff) | 1;\nfunction h() { if ((S & 1) === 1) return 'odd'; return 'even'; }\nmodule.exports = { h };\n";
    expect(load(foldJs(masked).code).h!()).toBe("odd");
    expect(foldJs(masked).stats.branchesDropped).toBeGreaterThan(0);
  });

  test("two different seeds are never assumed equal: a test that compares them is kept", () => {
    const code = "const A = (process.pid & 0xff) | 1;\nconst B = (process.ppid & 0xff) | 1;\nfunction f() { return A === B ? 'same' : 'diff'; }\nmodule.exports = { f };\n";
    expect(foldJs(code).code).toBe(code);
  });

  test("a classic script keeps its top-level declarations, which other scripts may call", () => {
    const code = `${seed}function onSave() { return 1; }\nfunction helper() { return 2; }\n`;
    const out = foldJs(code).code;
    expect(out).toContain("function onSave");
    expect(out).toContain("function helper");
  });
});

test("foldPath writes a copy and leaves the original", () => {
  const src = join(tmp, "in.js");
  const original = readFixture("main.bla.js");
  writeFileSync(src, original);
  const rep = foldPath(src, join(tmp, "out.js"));
  expect(readFileSync(src).equals(original)).toBe(true);
  expect(rep.files[0]!.stats.predicatesFolded).toBeGreaterThan(0);
});

test("foldPath copies node_modules unchanged", () => {
  const src = join(tmp, "app");
  mkdirSync(join(src, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(src, "main.js"), "module.exports = 1;\n");
  writeFileSync(join(src, "node_modules", "dep", "index.js"), readFixture("main.bla.js"));
  foldPath(src, join(tmp, "app-out"));
  expect(readFileSync(join(tmp, "app-out", "node_modules", "dep", "index.js")).equals(readFixture("main.bla.js"))).toBe(true);
});

test("foldPath copies an ASAR with a bad entry unchanged instead of aborting", () => {
  const src = join(tmp, "bad.asar");
  writeFileSync(src, buildAsar([{ path: "a.js", node: { size: 2 ** 40, offset: "0" } }]));
  foldPath(src, join(tmp, "bad-out.asar"));
  expect(readFileSync(join(tmp, "bad-out.asar")).equals(readFileSync(src))).toBe(true);
});

test("one unparseable entry does not stop the rest of the ASAR from folding", () => {
  const src = join(tmp, "mixed.asar");
  writeFileSync(src, buildAsar([
    { path: "main.js", node: {}, data: readFixture("main.bla.js") },
    { path: "bad.js", node: {}, data: Buffer.from("this is { not js") },
  ]));
  const rep = foldPath(src, join(tmp, "mixed-out.asar"));
  expect(rep.files.map((f) => f.path)).toEqual([`${src}!main.js`]);
  expect(rep.notes.join("\n")).toContain("bad.js");
  const out = openAsar(join(tmp, "mixed-out.asar"));
  expect(out.read(out.files.find((f) => f.path === "bad.js")!).toString()).toBe("this is { not js");
  expect(out.read(out.files.find((f) => f.path === "main.js")!).length).toBeLessThan(readFixture("main.bla.js").length / 10);
  out.close();
});

test("an unparseable .js in a directory is kept and noted, not fatal", () => {
  const d = join(tmp, "bad-dir");
  mkdirSync(d);
  writeFileSync(join(d, "bad.js"), "this is { not js");
  writeFileSync(join(d, "main.js"), readFixture("main.bla.js"));
  const rep = foldPath(d, join(tmp, "bad-dir-out"));
  expect(readFileSync(join(tmp, "bad-dir-out", "bad.js"), "utf8")).toBe("this is { not js");
  expect(rep.notes.join("\n")).toContain("bad.js");
  expect(rep.files.map((f) => f.path)).toEqual([join(d, "main.js")]);
});

describe("a file with only prunable code is cleaned the same in a directory and in an ASAR", () => {
  const seed = "const _s = 4098631152 | (typeof _d === \"function\" && _d(0) === 1282826635 ? 1 : 0);\n";
  const code = `${seed}function _d() { return 0; }\nfunction unused() { return 1; }\nconst arr = [unused];\nvoid [arr];\nmodule.exports = { f: () => 1 };\n`;

  test("directory", () => {
    const d = join(tmp, "prune-dir");
    mkdirSync(d);
    writeFileSync(join(d, "m.js"), code);
    const rep = foldPath(d, join(tmp, "prune-dir-out"));
    expect(readFileSync(join(tmp, "prune-dir-out", "m.js"), "utf8")).not.toContain("unused");
    expect(rep.files).toHaveLength(1);
  });

  test("ASAR", () => {
    const src = join(tmp, "prune.asar");
    writeFileSync(src, buildAsar([{ path: "m.js", node: {}, data: Buffer.from(code) }]));
    const rep = foldPath(src, join(tmp, "prune-out.asar"));
    const out = openAsar(join(tmp, "prune-out.asar"));
    expect(out.read(out.files[0]!).toString()).not.toContain("unused");
    out.close();
    expect(rep.files).toHaveLength(1);
  });
});

test("foldPath never follows or copies a symlink", () => {
  const outside = join(tmp, "outside-secret.js");
  writeFileSync(outside, "module.exports = 'secret';\n");
  const d = join(tmp, "link-dir");
  mkdirSync(d);
  writeFileSync(join(d, "main.js"), "module.exports = 1;\n");
  symlinkSync(outside, join(d, "leak.js"));
  symlinkSync(d, join(d, "loop"));
  const rep = foldPath(d, join(tmp, "link-dir-out"));
  expect(existsSync(join(tmp, "link-dir-out", "leak.js"))).toBe(false);
  expect(existsSync(join(tmp, "link-dir-out", "loop"))).toBe(false);
  expect(readFileSync(join(tmp, "link-dir-out", "main.js"), "utf8")).toBe("module.exports = 1;\n");
  expect(rep.notes.filter((n) => n.includes("symlink skipped"))).toHaveLength(2);
});
