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
