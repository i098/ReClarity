import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scan } from "../scripts/scan.ts";
import { TECHNIQUES } from "./fixtures/bla322/techniques.ts";

const DIR = join(import.meta.dir, "fixtures/bla322");
const tmp = mkdtempSync(join(tmpdir(), "antibla-322-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const read = (f: string) => readFileSync(join(DIR, f), "latin1");

describe("BLA 3.2.2 samples, built with real `bla protect` (regen.sh)", () => {
  for (const t of TECHNIQUES) {
    test(`${t.technique}: marker is in ${t.sample} and scan fires ${t.scan}`, () => {
      expect(read(t.sample)).toMatch(t.marker);
      const r = scan(join(DIR, t.sample));
      expect(r.findings.map((f) => f.id)).toContain(t.scan);
    });
  }

  test("every sample scores above 0: BLA 3.2.2 is never silently plain", () => {
    for (const f of new Set(TECHNIQUES.map((t) => t.sample))) expect(scan(join(DIR, f)).score).toBeGreaterThan(0);
  });

  test("the JS samples are hardened", () => {
    for (const f of ["app.bla.js", "app.bla-llm.js", "app.bla-all.js", "ledger.bla.py"]) expect(scan(join(DIR, f)).level).toBe("hardened");
  });

  test("a build that BLA did not touch scores 0", () => {
    for (const f of ["src/app.js", "src/ledger.py", "src/k.ptx", "src/Info.plist", "src/fw.uf2", "src/Tiny.class"]) expect(scan(join(DIR, f)).score).toBe(0);
  });

  test("rule 2: the --self-seal build folds clean (its directive sits in decoy code and goes with it), and the run output is fenced", () => {
    const work = join(tmp, "run");
    const target = join(tmp, "app.js"); // no package.json above tmp: Node reads it as CommonJS
    cpSync(join(DIR, "app.bla-all.js"), target);
    const p = Bun.spawnSync(["bun", join(import.meta.dir, "../scripts/run.ts"), target, "--work", work, "--rea", `node -e "process.stdout.write(String(require('fs').readFileSync(process.argv[1],'utf8').length>0))" {target}`], { stderr: "pipe" });
    const r = JSON.parse(p.stdout.toString());
    expect(r.verdict).toBe("ok");
    const a = r.attempts[0];
    expect(a.output).toContain('<target-data source="rea-output"');
    expect(scan(r.prepared).findings.map((f) => f.id)).not.toContain("opaque_predicate");
  });
});
