import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coverage, quarantineCopy } from "../scripts/coverage.ts";

const sandboxWorks = !!Bun.which("bwrap") && Bun.spawnSync(["bwrap", "--ro-bind", "/", "/", "true"]).exitCode === 0;
const tmp = mkdtempSync(join(tmpdir(), "antibla-covtest-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const app = (name: string, src: string): string => {
  const d = join(tmp, name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "main.js"), src);
  return join(d, "main.js");
};
const kinds = (r: ReturnType<typeof coverage>) => Object.fromEntries(r.files[0]!.statements.map((s) => [s.head.match(/function (\w+)/)?.[1] ?? s.head, s.kind]));

describe.skipIf(!sandboxWorks)("coverage", () => {
  test("rare-input code is marked not run, never decoy", () => {
    const f = app("rare", "function common() { return 1; }\nfunction rare(x) { if (x === 42) return 'seldom'; return 0; }\nmodule.exports = { common, rare };\ncommon();\n");
    const k = kinds(coverage(f));
    expect(k.common).toBe("run");
    expect(k.rare).toBe("not_run");
  });

  test("unreferenced trap code that never ran is a decoy suspect; referenced trap code is kept", () => {
    const f = app(
      "trap",
      "function realRare() { return 'attestation of a real ticket'; }\nfunction shadow() { return 'ENCLAVE-ATTESTATION-GUARD'; }\nvoid shadow;\nmodule.exports = { realRare };\n",
    );
    const r = coverage(f);
    const k = kinds(r);
    expect(k.realRare).toBe("not_run"); // exported, so live code names it
    expect(k.shadow).toBe("decoy_suspect");

    const out = join(tmp, "trap-out");
    expect(quarantineCopy(f, r, out).removed).toBe(2); // shadow + its keep-alive line
    const copy = readFileSync(join(out, "main.js"), "utf8");
    expect(copy).not.toContain("shadow");
    expect(readFileSync(join(out, "quarantine.json"), "utf8")).toContain("ENCLAVE-ATTESTATION-GUARD");
    expect(readFileSync(f, "utf8")).toContain("shadow"); // original untouched
    expect(Bun.spawnSync(["node", "-e", `console.log(require(${JSON.stringify(join(out, "main.js"))}).realRare())`]).stdout.toString()).toContain("real ticket");
  });

  test("target runs without network, home files or inherited secrets", () => {
    process.env.ANTI_BLA_TEST_SECRET = "leak";
    const secret = join(tmp, "secret.txt"); // outside the app dir, like a file in the user's home
    writeFileSync(secret, "s3cret");
    const f = app(
      "jail",
      `const fs = require("fs");
let leaked = 0;
if (process.env.ANTI_BLA_TEST_SECRET) leaked |= 1;
try { fs.readFileSync(${JSON.stringify(secret)}); leaked |= 2; } catch {}
try { fs.writeFileSync("/app/x", "x"); leaked |= 4; } catch {}
if (Object.values(require("os").networkInterfaces()).flat().some((i) => i && !i.internal)) leaked |= 8;
process.exit(leaked);
`,
    );
    const r = coverage(f);
    delete process.env.ANTI_BLA_TEST_SECRET;
    expect(r.exitCode).toBe(0);
  });

  test("a target that never ends is killed at the time limit", () => {
    const f = app("loop", "while (true) {}\n");
    const r = coverage(f, { timeoutSec: 1 });
    expect(r.timedOut).toBe(true);
    expect(r.notes.join(" ")).toContain("time limit");
  });
});
