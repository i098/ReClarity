// Minimal ZIP reader and rewriter, enough to patch files inside an APK. Stored and deflate entries only,
// no ZIP64, no encryption. The rewrite drops extra fields, data descriptors and the APK signing block, so
// the copy is for analysis: it is not installable and its signature is gone.
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

export interface ZipEntry {
  name: string;
  method: number;
  /** Raw bytes as stored in the archive (compressed when method is 8). */
  raw: Buffer;
  crc: number;
  size: number;
  time: number;
  date: number;
  flags: number;
  version: number;
}

const EOCD = 0x06054b50;
const CEN = 0x02014b50;
const LOC = 0x04034b50;
const MAX_ENTRIES = 100_000;
const MAX_ENTRY_BYTES = 1 << 30;

export function readZip(buf: Buffer): ZipEntry[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a ZIP archive");
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new Error("ZIP64 is not supported");
  if (count > MAX_ENTRIES) throw new Error("too many ZIP entries");
  const out: ZipEntry[] = [];
  let at = cdOffset;
  for (let i = 0; i < count; i++) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== CEN) throw new Error("corrupt ZIP central directory");
    const method = buf.readUInt16LE(at + 10);
    const csize = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const skip = buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
    const lho = buf.readUInt32LE(at + 42);
    if (csize === 0xffffffff || buf.readUInt32LE(at + 24) === 0xffffffff || lho === 0xffffffff) throw new Error("ZIP64 is not supported");
    if (lho + 30 > buf.length || buf.readUInt32LE(lho) !== LOC) throw new Error("corrupt ZIP local header");
    const dataAt = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    if (dataAt + csize > buf.length) throw new Error("ZIP entry runs past the end of the file");
    out.push({
      name: buf.toString("utf8", at + 46, at + 46 + nameLen),
      method,
      raw: buf.subarray(dataAt, dataAt + csize),
      crc: buf.readUInt32LE(at + 16),
      size: buf.readUInt32LE(at + 24),
      time: buf.readUInt16LE(at + 12),
      date: buf.readUInt16LE(at + 14),
      flags: buf.readUInt16LE(at + 8) & ~0x8,
      version: buf.readUInt16LE(at + 6),
    });
    at += 46 + nameLen + skip;
  }
  return out;
}

/** Uncompressed bytes of an entry. Throws on an unsupported method. */
export function entryData(e: ZipEntry): Buffer {
  if (e.method === 0) return e.raw;
  if (e.method === 8) return inflateRawSync(e.raw, { maxOutputLength: MAX_ENTRY_BYTES });
  throw new Error(`ZIP method ${e.method} is not supported`);
}

export function writeZip(entries: ZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let at = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(LOC, 0);
    loc.writeUInt16LE(e.version, 4);
    loc.writeUInt16LE(e.flags, 6);
    loc.writeUInt16LE(e.method, 8);
    loc.writeUInt16LE(e.time, 10);
    loc.writeUInt16LE(e.date, 12);
    loc.writeUInt32LE(e.crc, 14);
    loc.writeUInt32LE(e.raw.length, 18);
    loc.writeUInt32LE(e.size, 22);
    loc.writeUInt16LE(name.length, 26);
    parts.push(loc, name, e.raw);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(CEN, 0);
    cen.writeUInt16LE(e.version, 4);
    loc.copy(cen, 6, 4, 30);
    cen.writeUInt32LE(at, 42);
    central.push(cen, name);
    at += 30 + name.length + e.raw.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(EOCD, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(at, 16);
  return Buffer.concat([...parts, cd, end]);
}

/** The entry with new content, compressed the way the old one was. */
export function replaceData(e: ZipEntry, data: Buffer): ZipEntry {
  return { ...e, raw: e.method === 8 ? deflateRawSync(data) : data, crc: crc32(data), size: data.length };
}
