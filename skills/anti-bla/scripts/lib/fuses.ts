import { closeSync, openSync, readSync } from "node:fs";
// Electron fuse wire: SENTINEL, version byte, length byte, then one state byte per fuse.
// Real states are '0' '1' 'r'. BLA 3.1.0 decoys carry '9' (0x39) in the wire.
export const SENTINEL = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX", "ascii");
export const DECOY_BYTE = 0x39;
/** REA ElectronFuseReader gives up above this many sentinels per slice. */
export const REA_MAX_SENTINELS = 32;

export interface Sentinel {
  offset: number;
  version: number;
  wire: string;
  decoy: boolean;
}

export function findSentinels(buf: Buffer): Sentinel[] {
  const out: Sentinel[] = [];
  for (let at = buf.indexOf(SENTINEL); at >= 0; at = buf.indexOf(SENTINEL, at + 1)) {
    const hdr = at + SENTINEL.length;
    const len = buf[hdr + 1] ?? 0;
    if (hdr + 2 + len > buf.length) continue;
    const wire = buf.subarray(hdr + 2, hdr + 2 + len);
    out.push({ offset: at, version: buf[hdr] ?? 0, wire: wire.toString("latin1"), decoy: len >= 6 && wire.includes(DECOY_BYTE) });
  }
  return out;
}

/** ELF, PE or Mach-O magic: the only files that can hold the fuse wire. */
export function isNativeExecutable(path: string): boolean {
  const fd = openSync(path, "r");
  const m = Buffer.alloc(4);
  try {
    readSync(fd, m, 0, 4, 0);
  } finally {
    closeSync(fd);
  }
  const be = m.readUInt32BE(0);
  return be === 0x7f454c46 || (be >>> 16) === 0x4d5a || [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(be);
}
