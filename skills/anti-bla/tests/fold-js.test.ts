import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foldJs, foldPath } from "../scripts/fold-js.ts";
import { buildAsar } from "../scripts/lib/asar.ts";
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
