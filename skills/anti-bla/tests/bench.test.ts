import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bench } from "../scripts/bench.ts";

const tmp = mkdtempSync(join(tmpdir(), "antibla-bench-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// Stub REA: BLOCK fails with a capacity error on stderr, JSON fails with it in the stdout JSON error, TEXT exits 1 with limit words in non-error stdout, ECHO exits 0 with limit words in its output.
const stub = join(tmp, "rea.sh");
writeFileSync(
  stub,
  `#!/bin/sh\nif grep -q BLOCK "$2" 2>/dev/null; then echo '{"error":"x","message":"ASAR header/index admission is limited to 16 MiB"}' >&2; exit 1; fi\nif grep -q JSON "$2" 2>/dev/null; then echo '{"error":"x","message":"ASAR header/index admission is limited to 16 MiB"}'; exit 1; fi\nif grep -q TEXT "$2" 2>/dev/null; then echo '{"normalized_result":{"note":"budget exceeded capacity"}}'; exit 1; fi\nif grep -q ECHO "$2" 2>/dev/null; then echo '{"normalized_result":{"note":"budget exceeded capacity"}}'; exit 0; fi\nif [ "$5" = "--token-count" ]; then echo 42; else echo '{"normalized_result":{"fact":"notes:save"}}'; fi\n`,
  { mode: 0o755 },
);

test("arm B reports the capacity error and zero recall; A and C recall the fact", () => {
  const plain = join(tmp, "plain.js");
  const hard = join(tmp, "hard.js");
  writeFileSync(plain, "module.exports = 1;\n");
  writeFileSync(hard, "module.exports = 1; // BLOCK\n");
  const arms = bench({ plain, hardened: hard, rea: `sh ${stub}`, work: join(tmp, "w"), facts: ["notes:save"], runs: 1 });
  const [a, b, c] = arms;
  expect(a!.runs[0]!.recall).toBe(1);
  expect(b!.runs[0]!.capacityError).toBe(true);
  expect(b!.runs[0]!.recall).toBe(0);
  expect(c!.path).not.toBe(hard);
  expect(a!.tokens).toBe(42);
});

const armB = (marker: string, dir: string) => {
  const f = join(tmp, `${dir}.js`);
  writeFileSync(f, `module.exports = 1; // ${marker}\n`);
  return bench({ plain: f, hardened: f, rea: `sh ${stub}`, work: join(tmp, dir), facts: ["notes:save"], runs: 1 })[1]!.runs[0]!;
};

test("a limit phrase in the JSON error on stdout with a nonzero exit is a capacity error", () => {
  expect(armB("JSON", "wj").capacityError).toBe(true);
});

test("limit words in non-error stdout are not a capacity error, with exit 1 or exit 0", () => {
  expect(armB("TEXT", "wt").capacityError).toBe(false);
  const ok = armB("ECHO", "we");
  expect(ok.exitCode).toBe(0);
  expect(ok.capacityError).toBe(false);
});
