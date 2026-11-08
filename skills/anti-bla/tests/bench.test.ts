import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bench } from "../scripts/bench.ts";

const tmp = mkdtempSync(join(tmpdir(), "antibla-bench-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// Stub REA: a target with "BLOCK" fails with a capacity error, any other prints the fact.
const stub = join(tmp, "rea.sh");
writeFileSync(
  stub,
  `#!/bin/sh\nif grep -q BLOCK "$2" 2>/dev/null; then echo '{"error":"x","message":"ASAR header/index admission is limited to 16 MiB"}' >&2; exit 1; fi\nif grep -q ECHO "$2" 2>/dev/null; then echo '{"error":"x","message":"budget exceeded capacity"}'; exit 1; fi\nif [ "$5" = "--token-count" ]; then echo 42; else echo '{"normalized_result":{"fact":"notes:save"}}'; fi\n`,
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

test("limit words that REA prints on stdout are not a capacity error", () => {
  const echo = join(tmp, "echo.js");
  writeFileSync(echo, "module.exports = 1; // ECHO\n");
  const [, b] = bench({ plain: echo, hardened: echo, rea: `sh ${stub}`, work: join(tmp, "w2"), facts: ["notes:save"], runs: 1 });
  expect(b!.runs[0]!.exitCode).toBe(1);
  expect(b!.runs[0]!.capacityError).toBe(false);
});
