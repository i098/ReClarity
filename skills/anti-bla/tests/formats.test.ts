import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { cleanApk, findApkDecoys, findDartDecoys, zeroDecoys } from "../scripts/lib/dart.ts";
import { cleanEvm, cleanEvmHex } from "../scripts/lib/evm.ts";
import { cleanModel, findModelDecoys } from "../scripts/lib/model.ts";
import { cleanPcap, countShieldRecords } from "../scripts/lib/pcap.ts";
import { findHoney } from "../scripts/lib/sqlite.ts";
import { entryData, readZip, replaceData, writeZip, type ZipEntry } from "../scripts/lib/zip.ts";
import { sanitize } from "../scripts/sanitize.ts";
import { scan } from "../scripts/scan.ts";
import { evmWithFiller, flutterLookalike, readFixture } from "./fixtures/make.ts";

const tmp = mkdtempSync(join(tmpdir(), "antibla-fmt-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const put = (name: string, data: Buffer | string): string => {
  const p = join(tmp, name);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, data);
  return p;
};

describe("SQLite", () => {
  test("honey tables dropped, the business table and its rows kept", () => {
    const src = put("a/app.sqlite", readFixture("app.bla.sqlite"));
    expect(findHoney(src).tables.length).toBeGreaterThan(0);
    expect(scan(join(tmp, "a")).findings.map((f) => f.id)).toContain("sqlite_honey");
    const out = join(tmp, "a-out");
    sanitize(join(tmp, "a"), out);
    const db = new Database(join(out, "app.sqlite"), { readonly: true });
    const names = db.query<{ name: string }, []>("select name from sqlite_master").all().map((r) => r.name);
    expect(names.some((n) => n.includes("enclave"))).toBe(false);
    expect(db.query("select account_id, plan_tier from license_cache").all()).toEqual([{ account_id: "acct_prod_01", plan_tier: "enterprise" }]);
    db.close();
    expect(findHoney(src).tables.length).toBeGreaterThan(0); // original untouched
  });

  test("a user table that shares one honey name, with other columns, is not dropped", () => {
    const p = join(tmp, "b/user.sqlite");
    mkdirSync(join(tmp, "b"), { recursive: true });
    const db = new Database(p);
    db.run("create table enclave_key_hierarchy (id integer primary key, note text)");
    db.run("insert into enclave_key_hierarchy (note) values ('mine')");
    db.close();
    expect(findHoney(p).tables).toEqual([]);
    sanitize(join(tmp, "b"), join(tmp, "b-out"));
    const out = new Database(join(tmp, "b-out/user.sqlite"), { readonly: true });
    expect(out.query("select note from enclave_key_hierarchy").all()).toEqual([{ note: "mine" }]);
    out.close();
  });

  test("a database with a live -wal file is copied, not cleaned", () => {
    put("c/app.sqlite", readFixture("app.bla.sqlite"));
    put("c/app.sqlite-wal", "pending");
    const r = sanitize(join(tmp, "c"), join(tmp, "c-out"));
    expect(r.actions.some((a) => a.kind === "sqlite-honey-dropped")).toBe(false);
    expect(readFileSync(join(tmp, "c-out/app.sqlite")).equals(readFixture("app.bla.sqlite"))).toBe(true);
  });
});

describe("models", () => {
  for (const [plain, bla] of [
    ["tiny.safetensors", "tiny.bla.safetensors"],
    ["tiny.gguf", "tiny.bla.gguf"],
  ] as const) {
    test(`${plain}: nesting breaker and bait removed, the file returns to the plain bytes`, () => {
      const src = put(`m/${bla}`, readFixture(bla));
      const d = findModelDecoys(src)!;
      expect(d.depth).toBeGreaterThan(32);
      expect(d.remove.length).toBeGreaterThan(1);
      const dst = join(tmp, `m/clean.${plain.split(".")[1]}`);
      expect(cleanModel(src, dst)).toBeDefined();
      expect(readFileSync(dst).equals(readFixture(plain))).toBe(true);
      expect(findModelDecoys(dst)?.remove ?? []).toEqual([]);
    });
  }

  test("a safetensors file with deep JSON but no BLA note is kept as it is", () => {
    const deep = Array.from({ length: 40 }).reduce<unknown>((v) => [v], "x");
    const header = Buffer.from(JSON.stringify({ __metadata__: { note: "mine" }, w: { dtype: "F32", shape: [1], data_offsets: [0, 4], deep } }));
    const len = Buffer.alloc(8);
    len.writeBigUInt64LE(BigInt(header.length));
    const src = put("m/user.safetensors", Buffer.concat([len, header, Buffer.alloc(4)]));
    expect(findModelDecoys(src)?.remove ?? []).toEqual([]);
    expect(cleanModel(src, join(tmp, "m/user-out.safetensors"))).toBeUndefined();
  });
});

describe("PCAP", () => {
  test("BLA packets dropped, the real packet kept byte for byte", () => {
    const bla = readFixture("app.bla.pcap");
    expect(countShieldRecords(bla)).toBeGreaterThan(0);
    const c = cleanPcap(bla)!;
    expect(c.buffer.equals(readFixture("app.pcap"))).toBe(true);
    expect(c.kept).toBe(1);
  });

  test("a real packet that only mentions the marker is kept", () => {
    const plain = readFixture("app.pcap");
    const body = Buffer.from("user traffic [BLA-PCAP-SHIELD] in a log line");
    const rec = Buffer.alloc(16);
    rec.writeUInt32LE(body.length, 8);
    rec.writeUInt32LE(body.length, 12);
    const withMention = Buffer.concat([plain, rec, body]);
    expect(countShieldRecords(withMention)).toBe(0);
    expect(cleanPcap(withMention)).toBeUndefined();
  });

  test("a truncated capture is not cleaned", () => {
    expect(cleanPcap(readFixture("app.bla.pcap").subarray(0, 50))).toBeUndefined();
  });
});

describe("EVM", () => {
  test("trailer and JUMPDEST filler removed; real code kept", () => {
    const code = evmWithFiller(70_000);
    const c = cleanEvm(code)!;
    expect(c.fillerBytes).toBeGreaterThanOrEqual(70_000 - 1);
    expect(c.buffer.length).toBeLessThan(readFixture("app.evm").length + 2);
    expect(c.buffer.subarray(0, 40).equals(readFixture("app.evm").subarray(0, 40))).toBe(true);
  });

  test("real solc code with ordinary metadata is not touched", () => {
    expect(cleanEvm(readFixture("app.evm"))).toBeUndefined();
  });

  test("a hex carrier is cleaned and stays hex", () => {
    const hex = "0x" + evmWithFiller(70_000).toString("hex");
    const c = cleanEvmHex(hex)!;
    expect(c.text.startsWith("0x6080604052")).toBe(true);
    expect(c.text.length).toBeLessThan(hex.length / 10);
    expect(cleanEvmHex("0x" + readFixture("app.evm").toString("hex"))).toBeUndefined();
  });
});

describe("Flutter", () => {
  // app.bla.flutter.so is BLA 3.1.0's own protectNativeBinary output on app.flutter.so (see fixtures/make.ts)
  const plain = readFixture("app.flutter.so");
  const bla = readFixture("app.bla.flutter.so");
  const GO_BUILDINFO = [1024, 1138]; // BLA's Go build-info plant: not a Dart decoy, so it stays in the clean copy

  test("BLA's trailer pool (66 records, 516 package + 516 dart URIs, 2032 tokens) and isolate pool are found", () => {
    const decoys = findDartDecoys(bla);
    expect(decoys.map((d) => d.kind).sort()).toEqual(["isolate-pool", "trailer-pool"]);
    const trailer = decoys.find((d) => d.kind === "trailer-pool")!;
    expect(trailer.records).toBe(66);
    expect(trailer.entries).toBe(516 * 2 + 2032);
    expect(trailer.end).toBe(bla.length - 4_723); // the chaff BLA appends after the pool is not Dart
    const isolate = decoys.find((d) => d.kind === "isolate-pool")!;
    expect(isolate.records).toBe(0);
    expect(isolate.start).toBe(2048 + 52); // the plain ELF's own snapshot header at the section start stays
  });

  test("zeroing leaves the file size and every other byte of the plain ELF as it was", () => {
    const decoys = findDartDecoys(bla);
    const copy = Buffer.from(bla);
    zeroDecoys(copy, decoys);
    expect(copy.length).toBe(bla.length);
    expect(findDartDecoys(copy)).toEqual([]);
    const inDecoy = (i: number): boolean => decoys.some((d) => i >= d.start && i < d.end) || (i >= GO_BUILDINFO[0]! && i < GO_BUILDINFO[1]!);
    for (let i = 0; i < plain.length; i++) if (!inDecoy(i)) expect(copy[i]).toBe(plain[i]!);
    for (const d of decoys) expect(plain.subarray(d.start, Math.min(d.end, plain.length)).every((x) => x === 0)).toBe(true); // nothing the plain input held is zeroed
  });

  test("the plain ELF, a binary with Dart-like strings, and a user pool of real URIs have no decoys", () => {
    expect(findDartDecoys(plain)).toEqual([]);
    const pool = Buffer.from(Array.from({ length: 600 }, (_, i) => `package:app_${i}/lib/x.dart`).join("\0") + "\0");
    expect(findDartDecoys(Buffer.concat([flutterLookalike(), pool]))).toEqual([]);
  });
});

describe("APK", () => {
  const entry = (name: string, data: Buffer, method: 0 | 8): ZipEntry =>
    replaceData({ name, method, raw: Buffer.alloc(0), crc: 0, size: 0, time: 0, date: 0, flags: 0, version: 20 }, data);
  const apkWith = (lib: Buffer, other = Buffer.from("<manifest/>")): Buffer =>
    writeZip([entry("AndroidManifest.xml", other, 8), entry("lib/arm64-v8a/libapp.so", lib, 8), entry("lib/arm64-v8a/libflutter.so", Buffer.from("engine"), 0)]);

  test("zip round trip keeps names and bytes, stored and deflated", () => {
    const back = readZip(apkWith(Buffer.from("hello hello hello")));
    expect(back.map((e) => e.name)).toEqual(["AndroidManifest.xml", "lib/arm64-v8a/libapp.so", "lib/arm64-v8a/libflutter.so"]);
    expect(back.map((e) => entryData(e).toString())).toEqual(["<manifest/>", "hello hello hello", "engine"]);
  });

  test("Dart decoys zeroed inside libapp.so; every other entry is byte for byte the same", () => {
    const lib = readFixture("app.bla.flutter.so");
    const apk = apkWith(lib);
    expect(findApkDecoys(apk)).toHaveLength(1);
    const c = cleanApk(apk)!;
    expect(c.libs).toEqual(["lib/arm64-v8a/libapp.so"]);
    const back = readZip(c.buffer);
    const cleaned = entryData(back[1]!);
    expect(cleaned.length).toBe(lib.length);
    expect(findDartDecoys(cleaned)).toEqual([]);
    expect(cleaned.subarray(0, 1024).equals(lib.subarray(0, 1024))).toBe(true);
    expect(entryData(back[0]!).toString()).toBe("<manifest/>");
    expect(entryData(back[2]!).toString()).toBe("engine");
  });

  test("an APK whose libapp.so has no decoys is left alone", () => {
    expect(cleanApk(apkWith(flutterLookalike()))).toBeUndefined();
  });

  test("scan flags a hardened APK and sanitize writes a clean copy", () => {
    put("apk/app.apk", apkWith(readFixture("app.bla.flutter.so")));
    expect(scan(join(tmp, "apk")).findings.map((f) => f.id)).toContain("dart_pool_decoy");
    const out = join(tmp, "apk-out");
    sanitize(join(tmp, "apk"), out);
    expect(scan(out).score).toBe(0);
  });

  test("a file that is not a ZIP is a note in the scan, not a crash", () => {
    put("bad/app.apk", "not a zip");
    expect(scan(join(tmp, "bad")).notes.some((n) => n.includes("not a ZIP"))).toBe(true);
  });

  test("sanitize copies a bad .apk and a corrupt .sqlite unchanged, notes them, and still cleans the rest", () => {
    put("bad2/app.apk", "not a zip");
    put("bad2/broken.sqlite", Buffer.concat([readFixture("app.bla.sqlite").subarray(0, 100), Buffer.alloc(4096, 0xff)]));
    put("bad2/app.pcap", readFixture("app.bla.pcap"));
    const r = sanitize(join(tmp, "bad2"), join(tmp, "bad2-out"));
    expect(readFileSync(join(tmp, "bad2-out/app.apk")).toString()).toBe("not a zip");
    expect(readFileSync(join(tmp, "bad2-out/broken.sqlite")).equals(readFileSync(join(tmp, "bad2/broken.sqlite")))).toBe(true);
    expect(r.actions.filter((a) => a.kind === "copied" && a.detail?.startsWith("not cleaned:")).map((a) => basename(a.path)).sort()).toEqual(["app.apk", "broken.sqlite"]);
    expect(readFileSync(join(tmp, "bad2-out/app.pcap")).equals(readFixture("app.pcap"))).toBe(true);
  });
});
