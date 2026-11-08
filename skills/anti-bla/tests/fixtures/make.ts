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

// ---- data formats ----
// Real BLA 3.1.0 output (bla-agents, commit 41345ff, `intensity: balanced|stealth`, seed "fixture-1"), made once
// with the shield functions and saved next to the plain input it came from:
//   app.sqlite / app.bla.sqlite   buildSampleSqliteDatabase() / protectSqliteBuffer
//   tiny.safetensors / .bla.      buildSafetensorsBuffer() / protectSafetensorsBuffer
//   tiny.gguf / .bla.             a 3-key GGUF v3 / protectGgufBuffer
//   app.pcap / app.bla.pcap       one UDP frame / protectPcapCaptureBuffer (stealth: 4 HTTP + 4 DNS frames)
//   app.evm / app.bla.evm         solc-style runtime code / protectEvmBytecodeBuffer
// The bankrupt size of these shields is megabytes (EVM 4 MiB filler, PCAP 250 KB, Flutter 95 KB), so those parts
// are built here from BLA's source shapes instead: `evmWithFiller`, `flutterTrailer`, `flutterBinary`.

/** Tiny deterministic hex source, in place of BLA's seeded PRNG. */
const hexOf = (n: number, salt: number): string => (Math.imul(salt + 1, 2654435761) >>> 0).toString(16).padStart(8, "0").repeat(Math.ceil(n / 8)).slice(0, n);

/** BLA `maximum`/`bankrupt` EVM shape: real code, JUMPDEST filler, BLA trailer. */
export function evmWithFiller(fillerBytes: number): Buffer {
  const plain = readFixture("app.evm");
  const protectedCode = readFixture("app.bla.evm");
  // real balanced output is the plain code followed by BLA's trailer: lift the trailer off it
  return Buffer.concat([plain, Buffer.alloc(fillerBytes, 0x5b), protectedCode.subarray(plain.length)]);
}

const LABELS = [
  '\0Dart VM version: 3.5.0-enclave-tee-ring0 (stable) on "linux_x64"\0',
  'Dart VM version: 3.6.2-sgx-isolated-bridge (stable) on "macos_arm64"\0',
  ...["17.0.6", "18.1.2", "18.1.8", "19.1.0", "19.1.4", "20.0.0"].map((v, i) => `based on LLVM ${v} (https://enclave.internal/llvm-tee-0${i + 1})\0`),
].join("");

const snapshotRecord = (hash32: string): Buffer => {
  const rec = Buffer.alloc(52, 0);
  rec.set([0xf5, 0xf5, 0xdc, 0xdc], 0);
  rec.writeBigUInt64LE(64n, 4);
  rec.writeBigUInt64LE(3n, 12);
  rec.write(hash32, 20, "ascii");
  return rec;
};

/** Dart part of BLA's native trailer: `buildFlutterPoolExhaustionPayload` (66 records, 8 labels, 516 URIs x2, 2032 tokens). */
export function flutterTrailer(): Buffer {
  const parts: Buffer[] = [];
  for (let i = 0; i < 66; i++) parts.push(snapshotRecord(i.toString(16).padStart(8, "0") + hexOf(24, i)));
  parts.push(Buffer.from(LABELS, "latin1"));
  const pool = ["\0[BLA-FLUTTER-POOL-EXHAUST]\0"];
  for (let i = 0; i < 516; i++) pool.push(`package:enclave_tarpit_${i}/lib/bridge_${hexOf(4, i)}.dart`, `dart:enclave_isolate_${i}`);
  for (let i = 0; i < 2032; i++) pool.push(`EnclaveTarpitNode_${i}_${hexOf(3, i)}`);
  parts.push(Buffer.from(pool.join("\0") + "\0", "utf8"));
  return Buffer.concat(parts);
}

/** `buildMappedFlutterIsolatePoolPlant`: fake record, marker, 532 package URIs, 532 dart URIs, 2032 tokens, zero fill. */
export function mappedIsolatePool(capacity: number): Buffer {
  const strings = ["\0[BLA-FLUTTER-MAPPED]\0"];
  for (let i = 0; i < 532; i++) strings.push(`package:m${i}/b.dart\0`);
  for (let i = 0; i < 532; i++) strings.push(`dart:d${i}\0`);
  for (let i = 0; i < 2032; i++) strings.push(`Node_${i}_X\0`);
  return Buffer.concat([snapshotRecord(hexOf(32, 7)), Buffer.from(strings.join(""))]).subarray(0, capacity);
}

/** A 1.1 MiB ELF-looking Flutter library with real Dart-like strings, optionally planted like BLA does. */
export function flutterBinary(plant: { trailer?: boolean; isolate?: boolean } = {}): { buffer: Buffer; real: { at: number; text: string }[] } {
  const head = Buffer.alloc(4096);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]).copy(head);
  // Real facts REA would read: an engine version line and a package URI
  const realText = ["Dart VM version: 3.5.4 (stable) (Mon Oct 14 2024) on \"linux_x64\"\0", "package:notes_app/main.dart\0", "NotesHomePage\0"];
  const body = Buffer.alloc(1 << 20);
  const real: { at: number; text: string }[] = [];
  let at = 4096 + 64;
  for (const t of realText) {
    Buffer.from(t, "latin1").copy(body, at - 4096);
    real.push({ at, text: t.slice(0, -1) });
    at += t.length + 16;
  }
  let isolateAt = -1;
  if (plant.isolate) {
    isolateAt = 4096 + 64 * 1024;
    mappedIsolatePool(40_000).copy(body, isolateAt - 4096);
  }
  const parts: Buffer[] = [head, body];
  if (plant.trailer) parts.push(Buffer.from("\0[BLA-NATIVE-SHIELD-V1]\0.dep-v0\0"), flutterTrailer(), Buffer.from("chaff: unrelated trailer text\0"));
  return { buffer: Buffer.concat(parts), real };
}
