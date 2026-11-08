import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scan, type ScanReport } from "../scripts/scan.ts";
import { FIXTURES, floodAsar, fuseBinary } from "./fixtures/make.ts";

const tmp = mkdtempSync(join(tmpdir(), "antibla-scan-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const ids = (r: ScanReport) => r.findings.map((f) => f.id);

describe("scan", () => {
  test("clean build scores 0: plain REA, no extra cost", () => {
    const r = scan(join(FIXTURES, "main.js"));
    expect(r.score).toBe(0);
    expect(r.level).toBe("none");
    expect(r.notes).toEqual([]);
  });

  test("real BLA 3.1.0 bankrupt JS is flagged by shape, not by name", () => {
    const r = scan(join(FIXTURES, "main.bla.js"));
    expect(r.level).toBe("hardened");
    expect(ids(r)).toEqual(expect.arrayContaining(["opaque_predicate", "ternary_chunks", "getter_ring", "selector_pyramid", "string_doubling", "keepalive_array", "decoy_ipc", "bait_text"]));
    expect(r.findings.find((f) => f.id === "opaque_predicate")!.count).toBeGreaterThan(30);
  });

  test("runtime guard: BLA's guard names fire, an app that reads execArgv or NODE_OPTIONS does not", () => {
    expect(ids(scan(join(FIXTURES, "main.bla.js")))).toContain("runtime_guard");
    const f = join(tmp, "weak-markers.js");
    writeFileSync(f, "const dbg = process.execArgv.includes('--inspect') || !!process.env.NODE_OPTIONS || !!globalThis.navigator?.webdriver;\nconsole.log(dbg);\n");
    expect(ids(scan(f))).not.toContain("runtime_guard");
  });

  test("shape detection survives renamed identifiers and stripped bait text", () => {
    const src = readFileSync(join(FIXTURES, "main.bla.js"), "utf8")
      .replace(/runtimeSeedTransientSensor_cf61/g, "q")
      .replace(/enclave|attestation|ENCLAVE|ABI-COMPAT-SHIM/gi, "zz");
    const f = join(tmp, "renamed.js");
    writeFileSync(f, src);
    expect(ids(scan(f))).toEqual(expect.arrayContaining(["opaque_predicate", "ternary_chunks"]));
  });

  test("ASAR header flood", () => {
    const f = join(tmp, "flood.asar");
    writeFileSync(f, floodAsar(150));
    const r = scan(f);
    expect(ids(r)).toContain("asar_header_flood");
    expect(r.level).toBe("hardened");
  });

  test("ASAR with a few long paths is not a flood", () => {
    const f = join(tmp, "few.asar");
    writeFileSync(f, floodAsar(5));
    expect(ids(scan(f))).not.toContain("asar_header_flood");
  });

  test("fuse decoys: 0x39 wire byte, real block ignored", () => {
    const f = join(tmp, "electron");
    writeFileSync(f, fuseBinary(34));
    const r = scan(f);
    expect(r.findings.find((x) => x.id === "fuse_decoy")!.count).toBe(34);
  });

  test("a binary with only the real fuse block is clean", () => {
    const f = join(tmp, "electron-real");
    writeFileSync(f, fuseBinary(0));
    expect(scan(f).score).toBe(0);
  });

  test("BLA config files in the target", () => {
    const d = join(tmp, "proj");
    mkdirSync(d);
    writeFileSync(join(d, ".blarc"), "{}");
    expect(ids(scan(d))).toContain("config_file");
  });

  test("a symlink loop is skipped and noted, not followed", () => {
    const d = join(tmp, "loop");
    mkdirSync(d);
    writeFileSync(join(d, "a.js"), "module.exports = 1;\n");
    symlinkSync(d, join(d, "self"));
    const r = scan(d);
    expect(r.score).toBe(0);
    expect(r.notes).toEqual([`${join(d, "self")}: symlink skipped`]);
  });

  test("a truncated ASAR is a note, not a crash", () => {
    const f = join(tmp, "cut.asar");
    writeFileSync(f, floodAsar(150).subarray(0, 40));
    const r = scan(f);
    expect(r.score).toBe(0);
    expect(r.notes.join("\n")).toContain("cut.asar");
  });

  test("evidence lists the files that hit, not the files scanned first", () => {
    const d = join(tmp, "where");
    mkdirSync(d);
    for (let i = 0; i < 6; i++) writeFileSync(join(d, `a${i}.js`), "module.exports = 1;\n");
    writeFileSync(join(d, "z.js"), "// ENCLAVE-ATTESTATION-GUARD\nmodule.exports = 2;\n");
    expect(scan(d).findings.find((f) => f.id === "bait_text")!.where).toEqual([join(d, "z.js")]);
  });
});
