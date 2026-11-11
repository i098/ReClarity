// Build the binary sources for the BLA 3.2.2 format fixtures (src/*). Usage: node mkin.mjs /path/to/bla-checkout
// Inputs are tiny and unsigned: BLA 3.2.2 refuses a ZIP with timestamps, extra fields or a signature, so the archives come from BLA's own writer.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const bla = process.argv[2];
const dist = (p) => import(join(bla, "dist", p));
const { writeZipArchive } = await dist("shields/formats/archive.js");
const { generateBunStandaloneDecoyGraph } = await dist("shields/formats/bun-standalone.js");
const { SeededPrng } = await dist("core/prng.js");
const src = join(dirname(fileURLToPath(import.meta.url)), "src");
mkdirSync(src, { recursive: true });

const adler = (b) => {
  let a = 1, s = 0;
  for (const x of b) { a = (a + x) % 65521; s = (s + a) % 65521; }
  return ((s << 16) | a) >>> 0;
};
function dex(tail) {
  const b = Buffer.alloc(112 + tail.length);
  b.write("dex\n035\0", 0, "ascii");
  b.writeUInt32LE(112, 36);
  b.writeUInt32LE(0x12345678, 40);
  b.write(tail, 112, "latin1");
  b.writeUInt32LE(b.length, 32);
  createHash("sha1").update(b.subarray(32)).digest().copy(b, 12);
  b.writeUInt32LE(adler(b.subarray(12)), 8);
  return b;
}
const w = (name, data) => writeFileSync(join(src, name), data);
w("classes.dex", dex("Lcom/example/Real;\0"));
const meta = Buffer.alloc(256);
meta.writeUInt32LE(0xfab11baf, 0);
meta.writeInt32LE(29, 4);
meta.write("RealLiteral\0", 200);
w("global-metadata.dat", meta);
const dll = Buffer.alloc(200);
dll.write("MZ", 0);
dll.write("BSJB", 128);
dll.write("Real.Namespace\0", 150);
w("App.dll", dll);
w("app.apk", writeZipArchive([
  { name: "AndroidManifest.xml", data: Buffer.from('<manifest package="com.example"><application/></manifest>') },
  { name: "classes.dex", data: dex("Lcom/example/Real;\0") },
  { name: "assets/bin/Data/Managed/Metadata/global-metadata.dat", data: meta },
  { name: "assets/level1.txt", data: Buffer.from("real asset content that is long enough to deflate ".repeat(4)) },
]));
w("app.zip", writeZipArchive([
  { name: "readme.txt", data: Buffer.from("hello real zip") },
  { name: "data/a.bin", data: Buffer.from("real data ".repeat(20)) },
]));
// A Bun standalone carrier: a minimal ELF64 header, then a Bun module graph (EOF trailer). BLA leaves it byte-exact and writes a decoy sidecar.
const elf = Buffer.alloc(64);
elf.write("\x7fELF", 0, "latin1");
elf[4] = 2; elf[5] = 1; elf[6] = 1;
elf.writeUInt16LE(2, 16); elf.writeUInt16LE(0x3e, 18); elf.writeUInt32LE(1, 20); elf.writeUInt16LE(64, 52);
w("bunapp", Buffer.concat([elf, generateBunStandaloneDecoyGraph(new SeededPrng("real-app"), "stealth").buffer]));
