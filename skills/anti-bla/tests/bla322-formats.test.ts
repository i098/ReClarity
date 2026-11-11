import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { entryData, readZip, writeZip } from "../scripts/lib/zip.ts";
import { sanitize } from "../scripts/sanitize.ts";
import { scan } from "../scripts/scan.ts";

// Samples are real `bla protect` / `bla emit-headers` output of BLA 3.2.2 (fixtures/bla322/regen.sh); src/ holds the plain inputs.
const DIR = join(import.meta.dir, "fixtures/bla322");
const tmp = mkdtempSync(join(tmpdir(), "antibla-322f-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const ids = (target: string) => scan(target).findings.map((f) => f.id);
/** Clean one sample into its own folder and return the folder. */
function clean(...files: string[]): string {
  const dir = join(tmp, `in${readdirSync(tmp).length}`);
  mkdirSync(dir);
  for (const f of files) writeFileSync(join(dir, f), readFileSync(join(DIR, f)));
  const out = `${dir}-out`;
  sanitize(dir, out);
  return out;
}
const entries = (buf: Buffer) => readZip(buf).map((e) => [e.name, entryData(e).toString("latin1")]);

describe("trailer formats: the cleaned copy equals the plain input byte for byte", () => {
  const cases: [string, string, string][] = [
    ["bla-classes.dex", "dex_shield", "classes.dex"],
    ["bla-global-metadata.dat", "il2cpp_shield", "global-metadata.dat"],
    ["bla-App.dll", "dotnet_shield", "App.dll"],
  ];
  for (const [sample, finding, plain] of cases) {
    test(`${sample}: scan fires ${finding}, clean restores ${plain}`, () => {
      expect(ids(join(DIR, sample))).toContain(finding);
      const out = clean(sample);
      expect(readFileSync(join(out, sample)).equals(readFileSync(join(DIR, "src", plain)))).toBe(true);
      expect(ids(out)).toEqual([]);
    });
  }
});

describe("ZIP and APK", () => {
  test("ZIP: BLA's enclave entries are dropped, the developer's entries stay", () => {
    expect(ids(join(DIR, "bla-app.zip"))).toContain("archive_decoy");
    const out = clean("bla-app.zip");
    expect(entries(readFileSync(join(out, "bla-app.zip")))).toEqual(entries(readFileSync(join(DIR, "src/app.zip"))));
    expect(ids(out)).toEqual([]);
  });

  test("APK: manifest, R8 mapping, JNI, xref dex, dex and IL2CPP trailers and shield entries all fire, and all go", () => {
    expect(ids(join(DIR, "bla-app.apk")).sort()).toEqual(["android_dex_xref_decoy", "android_manifest_decoy", "android_r8_decoy", "archive_decoy", "dex_shield", "il2cpp_shield"]);
    const out = clean("bla-app.apk");
    const cleaned = entries(readFileSync(join(out, "bla-app.apk")));
    expect(cleaned).toEqual(entries(readFileSync(join(DIR, "src/app.apk"))));
    expect(cleaned.map((e) => e[0])).toContain("AndroidManifest.xml");
    expect(ids(out)).toEqual([]);
  });

  test("a ZIP with an `enclave/` folder of its own but no BLA manifest entry is not touched", () => {
    const mk = (name: string, data: string) => ({ name, method: 0, raw: Buffer.from(data), crc: Bun.hash.crc32(data), size: data.length, time: 0, date: 0, flags: 0, version: 20 });
    const zip = writeZip([mk("enclave/shadow_module_abcdef.json", "{}"), mk("assets/bla-shield/x.txt", "mine")]);
    const dir = join(tmp, "own");
    mkdirSync(dir);
    writeFileSync(join(dir, "own.zip"), zip);
    expect(scan(dir).score).toBe(0);
    sanitize(dir, `${dir}-out`);
    expect(entries(readFileSync(join(`${dir}-out`, "own.zip")))).toEqual(entries(zip));
  });
});

describe("Bun standalone sidecar", () => {
  test("the decoy module graph and its entangle note fire and are dropped", () => {
    expect(ids(join(DIR, "bla-bunapp.bunfs-snapshot"))).toContain("bun_sidecar_decoy");
    expect(ids(join(DIR, "bla-bunapp.bla-sidecar.v1.json"))).toContain("bun_sidecar_decoy");
    const out = clean("bla-bunapp.bunfs-snapshot", "bla-bunapp.bla-sidecar.v1.json");
    expect(readdirSync(out)).toEqual([]);
  });

  test("the plain Bun carrier is not BLA's: score 0, kept", () => {
    expect(scan(join(DIR, "src/bunapp")).score).toBe(0);
  });
});

describe("emitted C, Rust and Go headers", () => {
  for (const f of ["bla_shield.h", "bla_shield.rs", "bla_shield.go"]) {
    test(`${f}: fires and is dropped`, () => {
      expect(ids(join(DIR, f))).toContain("native_header_decoy");
      expect(readdirSync(clean(f))).toEqual([]);
    });
  }

  test("a hand-written header, Rust and Go file are kept", () => {
    const dir = join(tmp, "plain-src");
    mkdirSync(dir);
    for (const [n, t] of [["a.h", "#ifndef A_H\n#define A_H\nint f(void);\n#endif\n"], ["a.rs", "pub fn enclave_tarpit_1() {}\n"], ["a.go", "package main\nfunc main() {}\n"]]) writeFileSync(join(dir, n!), t!);
    expect(scan(dir).score).toBe(0);
    sanitize(dir, `${dir}-out`);
    expect(readdirSync(`${dir}-out`).sort()).toEqual(["a.go", "a.h", "a.rs"]);
  });
});

test("every plain input of these formats scores 0", () => {
  for (const f of ["classes.dex", "global-metadata.dat", "App.dll", "app.apk", "app.zip"]) expect(scan(join(DIR, "src", f)).score).toBe(0);
});
