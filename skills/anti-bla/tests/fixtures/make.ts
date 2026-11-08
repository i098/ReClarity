// Hand-made, scaled-down copies of the BLA 3.1.0 shapes that are too big to commit
// (a real bankrupt ASAR is 17 MiB, a real fused binary 1.1 MiB). Shapes were read from a
// real `bla protect --intensity bankrupt` run; see references/signatures.md.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildAsar } from "../../scripts/lib/asar.ts";
import { SENTINEL } from "../../scripts/lib/fuses.ts";

export const FIXTURES = import.meta.dir;
export const readFixture = (name: string): Buffer => readFileSync(join(FIXTURES, name));

/** ASAR with the app files plus `decoys` long-path tiny "enclave shard" entries. */
export function floodAsar(decoys = 150): Buffer {
  const pad = "a".repeat(256);
  const real = [
    { path: "dist/main.js", node: {}, data: readFixture("main.js") },
    { path: "package.json", node: {}, data: Buffer.from('{"name":"tiny-notes","main":"dist/main.js"}') },
  ];
  const shards = Array.from({ length: decoys }, (_, i) => ({
    path: `enclave/shards/ring0-slot-a3e-${pad}_${i}.json`,
    node: {},
    data: Buffer.from(JSON.stringify({ shardId: i, enclaveCid: 16, attestationHash: "259b4b5f", delegated: true })),
  }));
  return buildAsar([...real, ...shards]);
}

/** Fake ELF holding one real fuse block (RunAsNode on) and `decoys` BLA decoy blocks. */
export function fuseBinary(decoys = 34): Buffer {
  const head = Buffer.alloc(4096);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]).copy(head);
  const block = (wire: string) => Buffer.concat([SENTINEL, Buffer.from([1, wire.length]), Buffer.from(wire, "latin1")]);
  const parts = [head, block("10110001")];
  for (let i = 0; i < decoys; i++) parts.push(Buffer.alloc(64), block(i % 2 ? "0100119r" : "01001199"));
  // pad past 1 MiB so the scan treats it as a native executable worth reading
  parts.push(Buffer.alloc(1 << 20));
  return Buffer.concat(parts);
}

// Real BLA output, small enough to commit (BLA 3.1.0, commit 41345ff, seed "fixture-1"):
//   tiny.wasm      hand-assembled module: add and mul over two i32
//   tiny.bla.wasm  protectWasmBinary(tiny.wasm, { intensity: "maximum", preserveExports: ["add", "mul"] })
//   tiny.beam      hand-assembled BEAM form: AtU8 (3 atoms), Code, StrT, ImpT, ExpT, LocT
//   tiny.bla.beam  protectErlangBeamBuffer(tiny.beam, { intensity: "balanced" })
//   go.elf         buildMappedGoFlutterElfFixture() from BLA: ELF64 with a .go.buildinfo and an .isolate section
//   go.bla.elf     protectNativeBinary(go.elf, { intensity: "balanced" })
// The oversize Go claim and the rustc flood below are rebuilt from the same BLA source shapes, because a real
// bankrupt build is 1.1 MiB.

/** Section of a WASM module. Bodies under 128 bytes, so every length is one LEB128 byte. */
export const wasmSection = (id: number, body: Buffer): Buffer => Buffer.concat([Buffer.from([id, body.length]), body]);
export const wasmCustom = (name: string, body = Buffer.alloc(0)): Buffer => wasmSection(0, Buffer.concat([Buffer.from([name.length]), Buffer.from(name), body]));

/** `tiny.wasm` with its export section replaced: `[name, function index]` pairs, then extra sections at the end. */
export function wasmWith(exports: [string, number][], ...after: Buffer[]): Buffer {
  const tiny = readFixture("tiny.wasm");
  const entries = exports.map(([n, i]) => Buffer.concat([Buffer.from([n.length]), Buffer.from(n), Buffer.from([0, i])]));
  return Buffer.concat([tiny.subarray(0, 22), wasmSection(7, Buffer.concat([Buffer.from([exports.length]), ...entries])), tiny.subarray(37), ...after]);
}

const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n);
  return b;
};
const pad4 = (b: Buffer): Buffer => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]);
export const beamChunk = (name: string, payload: Buffer): Buffer => Buffer.concat([Buffer.from(name, "latin1"), u32(payload.length), pad4(payload)]);
/** Classic atom table: count, then a length byte and name per atom. */
export const beamAtoms = (names: string[]): Buffer => Buffer.concat([u32(names.length), ...names.map((n) => Buffer.concat([Buffer.from([n.length]), Buffer.from(n)]))]);
/** OTP 28 atom table: negative count, then a compact length (one byte under 16, else two bytes) and name per atom. */
export const beamAtomsCompact = (names: string[]): Buffer =>
  Buffer.concat([u32(-names.length), ...names.map((n) => Buffer.concat([Buffer.from(n.length < 16 ? [n.length << 4] : [((n.length >> 8) << 5) | 8, n.length & 255]), Buffer.from(n)]))]);
export function beamForm(...chunks: Buffer[]): Buffer {
  const body = Buffer.concat([Buffer.from("BEAM"), ...chunks]);
  return Buffer.concat([Buffer.from("FOR1"), u32(body.length), body]);
}

/** `go.elf` with the 512-byte `.go.buildinfo` (at 1024) overwritten by BLA's bankrupt plant: header, a 1 MiB + 1 version length, marker. */
export function goElfWithClaim(): Buffer {
  const out = Buffer.from(readFixture("go.elf"));
  out.fill(0, 1024, 1024 + 512);
  const header = Buffer.alloc(32);
  Buffer.from("ff20476f206275696c64696e663a", "hex").copy(header);
  header[14] = 8;
  header[15] = 2;
  Buffer.concat([header, Buffer.from([0x81, 0x80, 0x40]), Buffer.from("\0[BLA-GO-MAPPED]\0", "latin1")]).copy(out, 1024);
  return out;
}

/** `go.elf` followed by `/rustc/<hash>/` paths, no BLA trailer. Real paths are std ones; decoys are BLA's `enclave_guard.rs`. */
export function rustBinary(real: number, decoys: number): Buffer {
  const hash = (i: number) => i.toString(16).padStart(40, "a");
  const path = (i: number, file: string) => Buffer.from(`/rustc/${hash(i)}/${file}\0`, "latin1");
  const reals = Array.from({ length: real }, (_, i) => path(i, "library/std/src/rt.rs"));
  const fakes = Array.from({ length: decoys }, (_, i) => path(1000 + i, "library/core/src/enclave_guard.rs"));
  return Buffer.concat([readFixture("go.elf"), ...reals, ...fakes]);
}
