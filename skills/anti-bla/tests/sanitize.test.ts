import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAsar, openAsar } from "../scripts/lib/asar.ts";
import { findSentinels } from "../scripts/lib/fuses.ts";
import { sanitize } from "../scripts/sanitize.ts";
import { scan } from "../scripts/scan.ts";
import { floodAsar, fuseBinary, readFixture } from "./fixtures/make.ts";

const tmp = mkdtempSync(join(tmpdir(), "antibla-san-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

describe("sanitize", () => {
  test("ASAR: drops flood entries, keeps real files byte for byte, leaves the original alone", () => {
    const src = join(tmp, "app.asar");
    writeFileSync(src, floodAsar(150));
    const before = sha(src);
    const r = sanitize(src, join(tmp, "out1"));
    expect(sha(src)).toBe(before);
    const out = openAsar(join(tmp, "out1", "app.asar"));
    expect(out.files.map((f) => f.path).sort()).toEqual(["dist/main.js", "package.json"]);
    expect(out.read(out.files.find((f) => f.path === "dist/main.js")!).equals(readFixture("main.js"))).toBe(true);
    out.close();
    expect(r.actions[0]!.kind).toBe("asar-flood-dropped");
    expect(scan(join(tmp, "out1", "app.asar")).score).toBe(0);
  });

  test("ASAR: header over 16 MiB from repeated short-path tiny entries is cut under the limit, no env raise", () => {
    const real = Buffer.from("console.log(1)");
    const pad = "x".repeat(30000);
    const entries = [{ path: "dist/main.js", node: {}, data: real }];
    for (let i = 0; i < 600; i++) entries.push({ path: `d/f${i}.js`, node: { integrity: { hash: "ab" }, pad } as never, data: Buffer.from("1") });
    const src = join(tmp, "big.asar");
    writeFileSync(src, buildAsar(entries));
    const r = sanitize(src, join(tmp, "out9"));
    const orig = openAsar(src);
    expect(orig.headerBytes).toBeGreaterThan(16 * 1024 * 1024);
    orig.close();
    const out = openAsar(join(tmp, "out9", "big.asar"));
    expect(out.headerBytes).toBeLessThan(16 * 1024 * 1024);
    expect(out.files.map((f) => f.path)).toEqual(["dist/main.js"]);
    expect(out.read(out.files[0]!).equals(real)).toBe(true);
    out.close();
    expect(r.reaEnv.REA_ASAR_MAX_HEADER_BYTES).toBeUndefined();
    expect(r.actions[0]!.detail).toContain("600 entries dropped");
  });

  test("ASAR: hashless and empty tiny floods over 16 MiB are cut, and the note names the groups", () => {
    const pad = "x".repeat(30000);
    const entries = [{ path: "dist/main.js", node: {}, data: Buffer.from("console.log(1)") }] as { path: string; node: never; data: Buffer }[];
    for (let i = 0; i < 300; i++) entries.push({ path: `d/f${i}.js`, node: { pad } as never, data: Buffer.from("1") });
    for (let i = 0; i < 300; i++) entries.push({ path: `e/g${i}.js`, node: { pad } as never, data: Buffer.alloc(0) });
    for (const c of ["a", "b"]) for (let i = 0; i < 60; i++) entries.push({ path: `k${c}/h${i}.js`, node: { pad } as never, data: Buffer.from(c) });
    const src = join(tmp, "nohash.asar");
    writeFileSync(src, buildAsar(entries));
    const r = sanitize(src, join(tmp, "out10"));
    const out = openAsar(join(tmp, "out10", "nohash.asar"));
    expect(out.files.length).toBe(121);
    expect(out.files.filter((f) => f.path.startsWith("k")).length).toBe(120);
    out.close();
    expect(r.reaEnv.REA_ASAR_MAX_HEADER_BYTES).toBeUndefined();
    expect(r.actions[0]!.detail).toContain("300 repeated, 1 B each, e.g. d/f0.js, d/f1.js, d/f2.js");
    expect(r.actions[0]!.detail).toContain("300 repeated, 0 B each, e.g. e/g0.js");
  });

  test("ASAR: a kept entry with an enclave-like name is reported as a suspect and stays in the archive", () => {
    const pad = "a".repeat(256);
    const shards = Array.from({ length: 120 }, (_, i) => ({ path: `enclave/shards/ring0-${pad}_${i}.json`, node: {}, data: Buffer.from("{}") }));
    const src = join(tmp, "suspect.asar");
    writeFileSync(src, buildAsar([{ path: "main.js", node: {}, data: Buffer.from("1") }, { path: "enclave/keys.json", node: {}, data: Buffer.from('{"k":1}') }, ...shards]));
    const r = sanitize(src, join(tmp, "out2"));
    expect(r.suspects).toEqual(["enclave/keys.json"]);
    const out = openAsar(join(tmp, "out2", "suspect.asar"));
    expect(out.files.map((f) => f.path).sort()).toEqual(["enclave/keys.json", "main.js"]);
    out.close();
    writeFileSync(join(tmp, "plain.asar"), floodAsar(0));
    expect(sanitize(join(tmp, "plain.asar"), join(tmp, "out3")).actions[0]!.kind).toBe("copied-asar-unchanged");
  });

  test("fuses: decoy sentinels zeroed, real block and file size untouched", () => {
    const src = join(tmp, "electron");
    writeFileSync(src, fuseBinary(34));
    sanitize(src, join(tmp, "out4"));
    const out = readFileSync(join(tmp, "out4", "electron"));
    const s = findSentinels(out);
    expect(s).toHaveLength(1);
    expect(s[0]!.wire).toBe("10110001");
    expect(out.length).toBe(statSync(src).size);
  });

  test("a native executable named .bin still gets its fuse decoys zeroed", () => {
    const src = join(tmp, "tool.bin");
    writeFileSync(src, fuseBinary(34));
    sanitize(src, join(tmp, "out-bin"));
    expect(findSentinels(readFileSync(join(tmp, "out-bin", "tool.bin")))).toHaveLength(1);
  });

  test("directory: configs dropped, other files copied", () => {
    const d = join(tmp, "proj");
    mkdirSync(d);
    writeFileSync(join(d, ".blarc"), "{}");
    writeFileSync(join(d, "main.js"), "1");
    const r = sanitize(d, join(tmp, "out5"));
    expect(existsSync(join(tmp, "out5", ".blarc"))).toBe(false);
    expect(readFileSync(join(tmp, "out5", "main.js"), "utf8")).toBe("1");
    expect(r.actions.map((a) => a.kind)).toContain("dropped-config");
  });

  test("refuses an output inside the target or on top of it", () => {
    const d = join(tmp, "proj");
    expect(() => sanitize(d, join(d, "inner"))).toThrow(/refusing/);
    expect(() => sanitize(d, d)).toThrow(/refusing/);
  });

  test("symlinks in the target are skipped and listed, never copied", () => {
    const outside = join(tmp, "outside.txt");
    writeFileSync(outside, "host secret");
    const d = join(tmp, "links");
    mkdirSync(d);
    writeFileSync(join(d, "main.js"), "1");
    symlinkSync(outside, join(d, "leak.txt"));
    symlinkSync(d, join(d, "loop"));
    const r = sanitize(d, join(tmp, "out7"));
    expect(existsSync(join(tmp, "out7", "leak.txt"))).toBe(false);
    expect(existsSync(join(tmp, "out7", "loop"))).toBe(false);
    expect(r.actions.filter((a) => a.kind === "skipped-symlink").map((a) => a.path).sort()).toEqual([join(d, "leak.txt"), join(d, "loop")]);
  });

  test("an unreadable ASAR is copied unchanged, not a crash", () => {
    const src = join(tmp, "cut.asar");
    writeFileSync(src, floodAsar(150).subarray(0, 40));
    const r = sanitize(src, join(tmp, "out6"));
    expect(sha(join(tmp, "out6", "cut.asar"))).toBe(sha(src));
    expect(r.actions[0]!.kind).toBe("copied-asar-unchanged");
  });

  test("an entry that claims more bytes than the archive holds is refused, not allocated", () => {
    const f = join(tmp, "huge.asar");
    writeFileSync(f, buildAsar([{ path: "a.js", node: { size: 2 ** 40, offset: "0" } }]));
    const a = openAsar(f);
    expect(() => a.read(a.files[0]!)).toThrow(/malformed ASAR entry/);
    a.close();
  });

  test("entries named like Object.prototype keys survive a rebuild", () => {
    const f = join(tmp, "proto.asar");
    const paths = ["__proto__", "d/__proto__", "constructor/y"];
    writeFileSync(f, buildAsar(paths.map((path) => ({ path, node: {}, data: Buffer.from(path) }))));
    const a = openAsar(f);
    expect(a.files.map((x) => x.path).sort()).toEqual([...paths].sort());
    expect(a.read(a.files.find((x) => x.path === "__proto__")!).toString()).toBe("__proto__");
    a.close();
  });
});
