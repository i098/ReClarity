import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findSeeds, parseJs } from "../scripts/lib/js.ts";
import { scan } from "../scripts/scan.ts";

// Real BLA 3.2.2 output (tests/fixtures/bla322/regen.sh), checked against the shape generators in BLA's source.
const DIR = join(import.meta.dir, "fixtures/bla322");
const read = (f: string) => readFileSync(join(DIR, f), "utf8");
const finding = (f: string, id: string) => scan(join(DIR, f)).findings.find((x) => x.id === id)?.count ?? 0;

/** Every opaque-predicate template BLA 3.2.2 emits in JS, as printed by Babel. Seed names are random, so `\1` ties the reads. */
const PREDICATES: Record<string, RegExp> = {
  // ast-shield.ts buildOpaqueTrueAst / buildOpaqueFalseAst, and the idx % 3 === 1 chunks of buildCombinatorialStringAst
  "odd square": /\(Math\.imul\((\w+) \^ \d+, \1 \^ \d+\) & 7\) === [01]/g,
  // the other string chunks, and the decoy IPC guard `S | 11`
  "consecutive product": /\(Math\.imul\((\w+) \| \d+, \(\1 \| \d+\) \+ 1\) & 1\) === [01]/g,
  // tarpit/opaque-predicates.ts generateJsOpaqueFalseExpression, all four variants
  "7x^2 - 1": /Math\.imul\(7, Math\.imul\((\w+) \| \d+, \1 \| \d+\)\) - 1 === Math\.imul\(\1 \^ \d+, \1 \^ \d+\)/g,
  "carry add": /\(\((\w+) \^ \d+\) \+ \(\(\1 & \d+\) << 1 \| 0\) \| 0\) !== \(\1 \+ \d+ \| 0\)/g,
  "consecutive product | 0": /\(Math\.imul\((\w+) \| \d+, \(\1 \| \d+\) \+ 1 \| 0\) & 1\) === 1/g,
  "x | ~x": /\((\w+) \| ~\1 \| 0\) !== -1/g,
};

describe("BLA 3.2.2 JS shapes", () => {
  for (const f of ["app.bla-all.js", "app.bla.js"]) {
    test(`${f}: every predicate template occurs and scan counts each one`, () => {
      const src = read(f);
      let total = 0;
      for (const [name, re] of Object.entries(PREDICATES)) {
        const n = src.match(re)?.length ?? 0;
        expect(n, name).toBeGreaterThan(0);
        total += n;
      }
      expect(finding(f, "opaque_predicate")).toBe(total);
    });
  }

  // 3.1.0 emits the same seed with --self-seal (fixtures/main.bla-seal.js); scan missed it in both versions.
  for (const f of ["bla322/app.bla-all.js", "main.bla-seal.js"]) {
    test(`${f}: --self-seal seed \`NUM ^ seal >>> 0 & 0xfffffffe | (digest ? 1 : 0)\` is a seed whose low bit follows the flag`, () => {
      const src = readFileSync(join(import.meta.dir, "fixtures", f), "utf8");
      const name = src.match(/const (\w+) = \d+ \^ \w+ >>> 0 & 0xfffffffe \| \(/)?.[1];
      expect(name).toBeDefined();
      const ast = parseJs(src);
      for (const [flag, bit] of [[1, 1], [0, 0]] as const) {
        const seed = findSeeds(ast, flag).find((s) => s.name === name);
        expect(seed?.samples.every((v) => (v & 1) === bit)).toBe(true);
      }
    });
  }

  test("the unchanged trap shapes still fire on the all-flags build", () => {
    const ids = scan(join(DIR, "app.bla-all.js")).findings.map((f) => f.id);
    for (const id of ["ternary_chunks", "getter_ring", "selector_pyramid", "string_doubling", "keepalive_array", "decoy_ipc", "runtime_guard"]) expect(ids).toContain(id);
  });

  test("js_bla_name: the bla_encrypt_strings stub and the local-Math rename", () => {
    expect(read("vault.bla.js")).toContain("var _blaS=");
    expect(finding("vault.bla.js", "js_bla_name")).toBe(1);
    expect(read("mathlocal.bla.js")).toMatch(/\b_blaLocalMath\w*/);
    expect(finding("mathlocal.bla.js", "js_bla_name")).toBeGreaterThan(0);
    for (const f of ["src/vault.js", "src/mathlocal.js"]) expect(scan(join(DIR, f)).score).toBe(0);
  });
});
