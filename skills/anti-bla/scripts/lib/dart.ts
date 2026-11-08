// BLA 3.1.0 Flutter shield. Two plants, both zeroed in place so offsets and file size stay the same:
//  1. The trailer block of the native shield: 66 fake Dart snapshot records (magic f5f5dcdc, size field 64,
//     kind 3, hex hash), eight fake `Dart VM version` / `based on LLVM` lines, then a string pool of
//     `[BLA-FLUTTER-POOL-EXHAUST]` with 516 `package:`/`dart:` URIs and 2032 class-like tokens. REA caps
//     snapshot hashes at 64 and the pool at 500 URIs and 2000 tokens.
//  2. A pool written into a named `.isolate` section, led by `[BLA-FLUTTER-MAPPED]`. BLA overwrote the
//     real bytes there, so zero is the best a copy can hold.
// A snapshot header in front of the isolate pool is kept: BLA leaves a real header in place and plants after it,
// and a header BLA wrote itself has the same shape, so the two cannot be told apart.

import { FLUTTER_LIB } from "./formats.ts";
import { entryData, readZip, replaceData, writeZip } from "./zip.ts";

const POOL_MARKER = Buffer.from("\0[BLA-FLUTTER-POOL-EXHAUST]\0", "utf8");
const MAPPED_MARKER = Buffer.from("\0[BLA-FLUTTER-MAPPED]\0", "utf8");
const VERSION_BLOCK = Buffer.from(
  [
    '\0Dart VM version: 3.5.0-enclave-tee-ring0 (stable) on "linux_x64"\0',
    'Dart VM version: 3.6.2-sgx-isolated-bridge (stable) on "macos_arm64"\0',
    ...[["17.0.6", "01"], ["18.1.2", "02"], ["18.1.8", "03"], ["19.1.0", "04"], ["19.1.4", "05"], ["20.0.0", "06"]].map(([v, n]) => `based on LLVM ${v} (https://enclave.internal/llvm-tee-${n})\0`),
  ].join(""),
  "latin1",
);
const SNAPSHOT_MAGIC = [0xf5, 0xf5, 0xdc, 0xdc];
const RECORD = 52;

const POOL_ENTRY = /^(package:enclave_tarpit_\d+\/lib\/bridge_[0-9a-f]{4}\.dart|dart:enclave_isolate_\d+|EnclaveTarpitNode_\d+_[0-9a-f]{3})$/;
const MAPPED_ENTRY = /^(package:m\d+\/b\.dart|dart:d\d+|Node_\d+_X)$/;

export interface DartDecoy {
  kind: "trailer-pool" | "isolate-pool";
  start: number;
  end: number;
  /** Fake snapshot records inside the range. */
  records: number;
  /** Pool entries inside the range. */
  entries: number;
}

/** A BLA fake snapshot record: magic, size 64, kind 3, 32 lowercase hex characters. */
function isFakeRecord(b: Buffer, at: number): boolean {
  if (at < 0 || at + RECORD > b.length || !SNAPSHOT_MAGIC.every((m, i) => b[at + i] === m)) return false;
  return b.readBigUInt64LE(at + 4) === 64n && b.readBigUInt64LE(at + 12) === 3n && /^[0-9a-f]{32}$/.test(b.toString("latin1", at + 20, at + 52));
}

/** End of a run of NUL-terminated strings that all match `entry`. */
function poolEnd(b: Buffer, from: number, entry: RegExp): { end: number; entries: number } {
  let at = from;
  let entries = 0;
  for (;;) {
    const nul = b.indexOf(0, at);
    if (nul < 0 || nul === at || !entry.test(b.toString("latin1", at, nul))) break;
    entries++;
    at = nul + 1;
  }
  return { end: at, entries };
}

export function findDartDecoys(b: Buffer): DartDecoy[] {
  const out: DartDecoy[] = [];
  for (let at = b.indexOf(POOL_MARKER); at >= 0; at = b.indexOf(POOL_MARKER, at + 1)) {
    // BLA joins the marker and the entries with NUL, so a second NUL follows the marker's own
    if (b[at + POOL_MARKER.length] !== 0) continue;
    const pool = poolEnd(b, at + POOL_MARKER.length + 1, POOL_ENTRY);
    if (!pool.entries) continue;
    // the fake records sit in front of the fake version lines, which sit in front of the pool
    let start = at;
    if (at >= VERSION_BLOCK.length && b.subarray(at - VERSION_BLOCK.length, at).equals(VERSION_BLOCK)) start = at - VERSION_BLOCK.length;
    let records = 0;
    while (isFakeRecord(b, start - RECORD)) {
      start -= RECORD;
      records++;
    }
    out.push({ kind: "trailer-pool", start, end: pool.end, records, entries: pool.entries });
  }
  for (let at = b.indexOf(MAPPED_MARKER); at >= 0; at = b.indexOf(MAPPED_MARKER, at + 1)) {
    const pool = poolEnd(b, at + MAPPED_MARKER.length, MAPPED_ENTRY);
    out.push({ kind: "isolate-pool", start: at, end: pool.end, records: 0, entries: pool.entries });
  }
  return out;
}

/** Zero the decoy ranges in `b` (a copy). */
export function zeroDecoys(b: Buffer, decoys: DartDecoy[]): void {
  for (const d of decoys) b.fill(0, d.start, d.end);
}

export interface ApkResult {
  /** The APK with every libapp.so cleaned. Signatures are gone, so it is for analysis only. */
  buffer: Buffer;
  /** Library paths that held decoys. */
  libs: string[];
  decoys: DartDecoy[];
}

/** Decoys in the Flutter libraries of an APK, without writing anything. */
export function findApkDecoys(apk: Buffer): { lib: string; decoys: DartDecoy[] }[] {
  const out: { lib: string; decoys: DartDecoy[] }[] = [];
  for (const e of readZip(apk)) {
    if (!FLUTTER_LIB.test(e.name)) continue;
    const decoys = findDartDecoys(entryData(e));
    if (decoys.length) out.push({ lib: e.name, decoys });
  }
  return out;
}

/** Zero the Dart decoys in each lib/<abi>/libapp.so of an APK. Undefined when there are none. */
export function cleanApk(apk: Buffer): ApkResult | undefined {
  const entries = readZip(apk);
  const libs: string[] = [];
  const all: DartDecoy[] = [];
  const next = entries.map((e) => {
    if (!FLUTTER_LIB.test(e.name)) return e;
    const data = Buffer.from(entryData(e));
    const decoys = findDartDecoys(data);
    if (!decoys.length) return e;
    zeroDecoys(data, decoys);
    libs.push(e.name);
    all.push(...decoys);
    return replaceData(e, data);
  });
  return libs.length ? { buffer: writeZip(next), libs, decoys: all } : undefined;
}
