import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanBeam, countBeamDecoys } from "../scripts/lib/beam.ts";
import { goBuildInfos, rustcPaths } from "../scripts/lib/native.ts";
import { cleanWasm, parseExports, parseSections } from "../scripts/lib/wasm.ts";
import { sanitize } from "../scripts/sanitize.ts";
import { scan, type ScanReport } from "../scripts/scan.ts";
import { beamAtoms, beamAtomsCompact, beamChunk, beamForm, goElfWithClaim, readFixture, rustBinary, wasmCustom, wasmWith } from "./fixtures/make.ts";

const tmp = mkdtempSync(join(tmpdir(), "antibla-fmt-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const ids = (r: ScanReport) => r.findings.map((f) => f.id);
let n = 0;
/** Write `bytes` as `name` in a fresh folder, sanitize that folder, return the cleaned file. */
function cleaned(name: string, bytes: Buffer, extra: Record<string, string> = {}): { out: Buffer; src: string; report: ReturnType<typeof sanitize> } {
  const dir = join(tmp, `t${n++}`);
  mkdirSync(dir);
  writeFileSync(join(dir, name), bytes);
  for (const [f, text] of Object.entries(extra)) writeFileSync(join(dir, f), text);
  const report = sanitize(dir, join(tmp, `o${n}`));
  return { out: readFileSync(join(tmp, `o${n}`, name)), src: dir, report };
}
const exportNames = (b: Buffer) => parseExports(parseSections(b)!.find((s) => s.id === 7)!.payload)!.map((e) => e.name);

describe("WASM", () => {
  test("real BLA output: decoys found, cleaned module is the original module", () => {
    const bla = readFixture("tiny.bla.wasm");
    const r = scan(join(__dirname, "fixtures", "tiny.bla.wasm"));
    expect(ids(r)).toEqual(expect.arrayContaining(["wasm_export_flood", "wasm_decoy_sections"]));
    const c = cleaned("tiny.bla.wasm", bla);
    expect(exportNames(c.out)).toEqual(["add", "mul"]);
    // every section the original has stays byte for byte; the cleaned export section is the original's
    expect(c.out.subarray(8).equals(readFixture("tiny.wasm").subarray(8))).toBe(true);
    expect(scan(join(tmp, `o${n}`, "tiny.bla.wasm")).score).toBe(0);
  });

  test("an export that glue imports stays even when it has a decoy name", () => {
    const bytes = wasmWith([["add", 0], ["mul", 1], ["bla_enclave_verify_7", 0], ["enclave_export_ab12_1_eee", 0]]);
    const c = cleaned("m.wasm", bytes, { "glue.js": "instance.exports.bla_enclave_verify_7()" });
    expect(exportNames(c.out)).toEqual(["add", "mul", "bla_enclave_verify_7"]);
  });

  test("a decoy-named export that aliases nothing real stays", () => {
    const bytes = wasmWith([["enclave_export_ab12_1_eee", 0]]);
    expect(cleanWasm(bytes)).toBeUndefined();
  });

  test("decoy custom sections go; a custom section with another name stays", () => {
    const keep = wasmCustom("producers", Buffer.from("rustc"));
    const bytes = Buffer.concat([wasmWith([["add", 0]]), wasmCustom("bla.canary.credentials"), keep, wasmCustom("enclave.attestation.0")]);
    const c = cleaned("s.wasm", bytes);
    expect(parseSections(c.out)!.map((s) => s.id)).toEqual([1, 3, 7, 10, 0]);
    expect(c.out.subarray(c.out.length - keep.length).equals(keep)).toBe(true);
  });

  test("a module BLA never touched is copied unchanged", () => {
    const plain = readFixture("tiny.wasm");
    const c = cleaned("p.wasm", plain);
    expect(c.out.equals(plain)).toBe(true);
    expect(c.report.actions).toEqual([]);
  });

  test("bytes that are not a module are not scanned and copied as they are", () => {
    const junk = Buffer.from("\0asm\x01\0\0\0\x07\xff\xff\xff\xff\x0f");
    expect(cleanWasm(junk)).toBeUndefined();
    const f = join(tmp, "junk.wasm");
    writeFileSync(f, junk);
    expect(scan(f).notes.join()).toContain("not a well-framed WASM module");
  });
});

describe("BEAM", () => {
  test("real BLA output: decoys found, cleaned form is the original form", () => {
    const f = join(__dirname, "fixtures", "tiny.bla.beam");
    expect(ids(scan(f))).toContain("beam_chunk_flood");
    const c = cleaned("tiny.bla.beam", readFixture("tiny.bla.beam"));
    expect(c.out.equals(readFixture("tiny.beam"))).toBe(true);
  });

  test("canary atoms are cut from a classic and from an OTP 28 compact table; atoms before them keep their index", () => {
    const real = ["tiny", "slugify"];
    for (const table of [beamAtoms, beamAtomsCompact]) {
      const code = beamChunk("Code", Buffer.from("real"));
      const bytes = beamForm(beamChunk("AtU8", table([...real, "bla_beam_canary", "[BLA-BEAM-SHIELD]", "bla_beam_canary_2"])), code);
      const out = cleanBeam(bytes)!;
      expect(out.droppedAtoms).toBe(3);
      expect(out.buffer.equals(beamForm(beamChunk("AtU8", table(real)), code))).toBe(true);
    }
  });

  test("a chunk is a decoy only when its payload starts with the shield marker", () => {
    const keep = beamChunk("Attr", Buffer.from("not a [BLA-BEAM-SHIELD] decoy"));
    const bytes = beamForm(keep, beamChunk("Dbgi", Buffer.from("[BLA-BEAM-SHIELD]\0\0")), beamChunk("Code", Buffer.from("real")));
    expect(countBeamDecoys(bytes)).toEqual({ chunks: 3, decoyChunks: 1, decoyAtoms: 0 });
    expect(cleanBeam(bytes)!.buffer.equals(beamForm(keep, beamChunk("Code", Buffer.from("real"))))).toBe(true);
  });

  test("an atom named bla_beam_canary that does not lead the shield atom stays", () => {
    const bytes = beamForm(beamChunk("AtU8", beamAtoms(["a", "bla_beam_canary", "b"])));
    expect(cleanBeam(bytes)).toBeUndefined();
  });

  test("a form BLA never touched is copied unchanged, bytes after the form are not read as chunks", () => {
    const plain = Buffer.concat([readFixture("tiny.beam"), Buffer.from("trailing note")]);
    expect(countBeamDecoys(plain)).toEqual({ chunks: 6, decoyChunks: 0, decoyAtoms: 0 });
    expect(cleaned("t.beam", plain).out.equals(plain)).toBe(true);
  });

  test("a truncated form is not scanned", () => {
    const f = join(tmp, "cut.beam");
    writeFileSync(f, readFixture("tiny.bla.beam").subarray(0, 100));
    expect(scan(f).notes.join()).toContain("not a well-framed BEAM form");
  });
});

describe("Go and Rust binaries", () => {
  test("real BLA output: shield trailer and fuse decoys go, size and layout of the original binary stay", () => {
    const f = join(__dirname, "fixtures", "go.bla.elf");
    expect(ids(scan(f))).toEqual(expect.arrayContaining(["fuse_decoy", "native_shield_trailer", "go_buildinfo_flood"]));
    const plain = readFixture("go.elf");
    const c = cleaned("go.bla.elf", readFixture("go.bla.elf"));
    expect(c.out.length).toBe(plain.length);
    expect(scan(join(tmp, `o${n}`, "go.bla.elf")).score).toBe(0);
    expect(c.out.subarray(0, 1536).equals(plain.subarray(0, 1536))).toBe(true);
    expect(goBuildInfos(c.out).filter((g) => g.plantEnd >= 0)).toEqual([]);
  });

  test("Go: a build-info claim over 1 MiB is zeroed; the rest of the binary stays", () => {
    const bytes = goElfWithClaim();
    expect(goBuildInfos(bytes).map((g) => g.claimed)).toEqual([1048577]);
    expect(ids(scan(writeBin("claim.elf", bytes)))).toContain("go_buildinfo_flood");
    const c = cleaned("claim.elf", bytes);
    expect(goBuildInfos(c.out)).toEqual([]);
    expect(c.out.length).toBe(bytes.length);
    expect(c.out.subarray(1536).equals(bytes.subarray(1536))).toBe(true);
  });

  test("Go: a real build info with a small claim stays", () => {
    const plain = readFixture("go.elf");
    const c = cleaned("go.elf", plain);
    expect(c.out.equals(plain)).toBe(true);
  });

  test("Rust: decoy hashes past REA's 64 are zeroed, real compiler paths stay", () => {
    const bytes = rustBinary(10, 70);
    expect(rustcPaths(bytes).distinct).toBe(80);
    expect(ids(scan(writeBin("rust.elf", bytes)))).toContain("rustc_hash_flood");
    const c = cleaned("rust.elf", bytes);
    expect(rustcPaths(c.out).distinct).toBe(10);
    expect(c.out.length).toBe(bytes.length);
    expect(c.out.toString("latin1").match(/library\/std\/src\/rt\.rs/g)).toHaveLength(10);
  });

  test("Rust: real hashes over the limit with no decoy path are kept, not guessed away", () => {
    const bytes = rustBinary(70, 0);
    const c = cleaned("many.elf", bytes);
    expect(c.out.equals(bytes)).toBe(true);
  });

  test("Rust: a binary under the limit is untouched even when it has the decoy path", () => {
    const bytes = rustBinary(10, 5);
    expect(cleaned("few.elf", bytes).out.equals(bytes)).toBe(true);
  });
});

function writeBin(name: string, bytes: Buffer): string {
  const f = join(tmp, `${n++}-${name}`);
  writeFileSync(f, bytes);
  return f;
}
