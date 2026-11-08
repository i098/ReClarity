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
// The bankrupt size of these shields is megabytes (EVM 4 MiB filler), so that part is built here from BLA's
// source shape instead: `evmWithFiller`.
// Flutter: app.flutter.so is BLA's own `buildMappedGoFlutterElfFixture()` (a 51 KB ELF64 with .go.buildinfo and
// .isolate sections); app.bla.flutter.so is `protectNativeBinary(plain, { intensity: "balanced", seed: "fixture-1" })`
// on it (182 KB: Dart trailer pool, mapped isolate pool, Go build info, chaff).

/** Tiny deterministic hex source, in place of BLA's seeded PRNG. */
const hexOf = (n: number, salt: number): string => (Math.imul(salt + 1, 2654435761) >>> 0).toString(16).padStart(8, "0").repeat(Math.ceil(n / 8)).slice(0, n);

/** BLA `maximum`/`bankrupt` EVM shape: real code, JUMPDEST filler, BLA trailer. */
export function evmWithFiller(fillerBytes: number): Buffer {
  const plain = readFixture("app.evm");
  const protectedCode = readFixture("app.bla.evm");
  // real balanced output is the plain code followed by BLA's trailer: lift the trailer off it
  return Buffer.concat([plain, Buffer.alloc(fillerBytes, 0x5b), protectedCode.subarray(plain.length)]);
}

/** A 1.1 MiB ELF-looking Flutter library with real Dart-like strings and no BLA plant: a look-alike that must have no decoys. */
export function flutterLookalike(): Buffer {
  const head = Buffer.alloc(4096);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]).copy(head);
  const body = Buffer.alloc(1 << 20);
  let at = 64;
  for (const t of ['Dart VM version: 3.5.4 (stable) (Mon Oct 14 2024) on "linux_x64"\0', "package:notes_app/main.dart\0", "NotesHomePage\0"]) {
    at += Buffer.from(t, "latin1").copy(body, at) + 16;
  }
  return Buffer.concat([head, body]);
}
