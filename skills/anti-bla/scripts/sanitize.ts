#!/usr/bin/env bun
// Write a clean COPY of a build for REA: drop ASAR header flood, neutralize decoy fuse
// sentinels, drop BLA config files, and clean the data formats (SQLite, models, PCAP, EVM, Dart pools). The original is never written. Code is never deleted
// here: logic that only looks like a decoy is handled by coverage.ts ("not run").
import { copyFileSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { buildAsar, openAsar, type OpenAsar } from "./lib/asar.ts";
import { cleanApk, findDartDecoys, zeroDecoys } from "./lib/dart.ts";
import { cleanEvm, cleanEvmHex } from "./lib/evm.ts";
import { MAX_APK_FILE, MAX_EVM_FILE, MAX_PCAP_FILE, dataKind } from "./lib/formats.ts";
import { SENTINEL, findSentinels, isNativeExecutable } from "./lib/fuses.ts";
import { cleanModel } from "./lib/model.ts";
import { cleanPcap } from "./lib/pcap.ts";
import { dropHoney, isSqlite } from "./lib/sqlite.ts";
import { CONFIG_NAMES, FLOOD_MIN, REA_ASAR_DEFAULT_HEADER, isFloodEntry } from "./scan.ts";

export interface Action {
  kind: "dropped-config" | "asar-flood-dropped" | "fuse-decoys-zeroed" | "dart-decoys-zeroed" | "apk-dart-decoys-zeroed" | "sqlite-honey-dropped" | "model-decoys-removed" | "pcap-flood-dropped" | "evm-trailer-removed" | "copied-asar-unchanged" | "copied" | "skipped-symlink";
  path: string;
  detail?: string;
}
export interface SanitizeReport {
  tool: "anti-bla/sanitize";
  target: string;
  out: string;
  actions: Action[];
  /** Set REA_ASAR_MAX_HEADER_BYTES to this value to read the ORIGINAL archive without cleaning (max 256 MiB). */
  reaEnv: Record<string, string>;
  /** Entries whose names look like enclave decoys but are not flood-shaped: kept, to be judged by coverage. */
  suspects: string[];
}

const MIB = 1024 * 1024;
const REA_ASAR_MAX = 256 * MIB;
const SUSPECT = /(^|\/)(enclave|tee|attestation)[^/]*/i;

function sanitizeAsar(src: string, dst: string, r: SanitizeReport): void {
  let asar: OpenAsar | undefined;
  try {
    const open = (asar = openAsar(src));
    const flood = open.files.filter(isFloodEntry);
    if (open.headerBytes > REA_ASAR_DEFAULT_HEADER) {
      const need = Math.ceil(open.headerBytes / MIB) * MIB;
      if (need <= REA_ASAR_MAX) r.reaEnv.REA_ASAR_MAX_HEADER_BYTES = String(need);
    }
    if (flood.length < FLOOD_MIN) {
      copyFileSync(src, dst);
      r.actions.push({ kind: "copied-asar-unchanged", path: src });
      return;
    }
    const drop = new Set(flood);
    const kept = open.files.filter((f) => !drop.has(f));
    const packed = buildAsar(kept.map((f) => ({ path: f.path, node: f.node, data: f.node.unpacked || f.node.link !== undefined ? undefined : open.read(f) })));
    writeFileSync(dst, packed);
    r.actions.push({ kind: "asar-flood-dropped", path: src, detail: `${flood.length} entries dropped, header ${open.headerBytes} B -> ${packed.readUInt32LE(12)} B` });
    for (const f of kept) if (SUSPECT.test(f.path) && !r.suspects.includes(f.path)) r.suspects.push(f.path);
  } catch (e) {
    copyFileSync(src, dst);
    r.actions.push({ kind: "copied-asar-unchanged", path: src, detail: e instanceof Error ? e.message : String(e) });
  } finally {
    asar?.close();
  }
}

function sanitizeBinary(src: string, dst: string, r: SanitizeReport): void {
  copyFileSync(src, dst);
  // shortcut: reads the whole binary into memory; stream it if a 1 GB target ever shows up
  const bin = readFileSync(src);
  const decoys = findSentinels(bin).filter((s) => s.decoy);
  const dart = findDartDecoys(bin);
  if (!decoys.length && !dart.length) return;
  const fd = openSync(dst, "r+");
  try {
    // zero only the 32-byte marker: size and offsets stay the same, REA no longer sees a sentinel
    for (const s of decoys) writeSync(fd, Buffer.alloc(SENTINEL.length), 0, SENTINEL.length, s.offset);
    // Dart decoys are zeroed in place too, so every offset in the binary stays valid
    for (const d of dart) writeSync(fd, Buffer.alloc(d.end - d.start), 0, d.end - d.start, d.start);
  } finally {
    closeSync(fd);
  }
  if (decoys.length) r.actions.push({ kind: "fuse-decoys-zeroed", path: src, detail: `${decoys.length} decoy sentinels zeroed` });
  if (dart.length) r.actions.push({ kind: "dart-decoys-zeroed", path: src, detail: `${dart.length} blocks, ${dart.reduce((n, d) => n + d.entries, 0)} pool entries, ${dart.reduce((n, d) => n + d.records, 0)} fake snapshot records` });
}

/** Clean one data format file from src into dst. A file that is not BLA-shaped is copied byte for byte. */
function sanitizeData(kind: NonNullable<ReturnType<typeof dataKind>>, src: string, dst: string, r: SanitizeReport): void {
  const plain = (detail?: string): void => {
    copyFileSync(src, dst);
    if (detail) r.actions.push({ kind: "copied", path: src, detail });
  };
  const size = statSync(src).size;
  switch (kind) {
    case "sqlite": {
      if (!isSqlite(src)) return plain();
      // a companion file holds changes the main file lacks; cleaning the main file alone would corrupt the copy
      const live = ["-wal", "-journal"].some((x) => existsSync(src + x) && statSync(src + x).size > 0);
      if (live) return plain("SQLite -wal/-journal beside it: not cleaned");
      copyFileSync(src, dst);
      const h = dropHoney(dst);
      if (h.tables.length || h.view) r.actions.push({ kind: "sqlite-honey-dropped", path: src, detail: `${h.tables.length} tables${h.view ? " and 1 view" : ""} dropped, file vacuumed` });
      if (h.suspects.length) r.suspects.push(...h.suspects.map((t) => `${src}: table ${t}`));
      return;
    }
    case "model": {
      const d = cleanModel(src, dst);
      if (!d) return plain();
      r.actions.push({ kind: "model-decoys-removed", path: src, detail: `${d.format}: nesting ${d.depth} removed with ${d.remove.length - 1} more BLA entries; tensor bytes copied unchanged` });
      return;
    }
    case "pcap": {
      if (size > MAX_PCAP_FILE) return plain("over 512 MiB: not cleaned");
      const c = cleanPcap(readFileSync(src));
      if (!c) return plain();
      writeFileSync(dst, c.buffer);
      r.actions.push({ kind: "pcap-flood-dropped", path: src, detail: `${c.dropped} BLA records dropped, ${c.kept} kept${c.kept ? "" : "; no real packets left: BLA discards an input it cannot read and writes its own capture, so the original cannot be recovered"}` });
      return;
    }
    case "evm": {
      if (size > MAX_EVM_FILE) return plain();
      const buf = readFileSync(src);
      const hex = cleanEvmHex(buf.toString("latin1"));
      const raw = hex ? undefined : cleanEvm(buf);
      if (!hex && !raw) return plain();
      writeFileSync(dst, hex ? hex.text : raw!.buffer);
      const c = hex ?? raw!;
      r.actions.push({ kind: "evm-trailer-removed", path: src, detail: `${c.trailerBytes} B trailer and ${c.fillerBytes} B JUMPDEST filler removed${hex ? " (hex carrier)" : ""}` });
      return;
    }
    case "apk": {
      if (size > MAX_APK_FILE) return plain("over 1 GiB: not cleaned");
      const c = cleanApk(readFileSync(src));
      if (!c) return plain();
      writeFileSync(dst, c.buffer);
      r.actions.push({ kind: "apk-dart-decoys-zeroed", path: src, detail: `${c.libs.join(", ")}: ${c.decoys.length} blocks zeroed; APK signature dropped, copy is for analysis only` });
    }
  }
}

function copyTree(src: string, dst: string, r: SanitizeReport): void {
  const st = statSync(src);
  if (st.isDirectory()) {
    mkdirSync(dst, { recursive: true });
    for (const e of readdirSync(src)) {
      const p = join(src, e);
      if (lstatSync(p).isSymbolicLink()) r.actions.push({ kind: "skipped-symlink", path: p });
      else copyTree(p, join(dst, e), r);
    }
    return;
  }
  mkdirSync(dirname(dst), { recursive: true });
  if (CONFIG_NAMES.includes(basename(src))) r.actions.push({ kind: "dropped-config", path: src });
  else if (dataKind(src)) {
    try {
      sanitizeData(dataKind(src)!, src, dst, r);
    } catch (e) {
      copyFileSync(src, dst);
      r.actions.push({ kind: "copied", path: src, detail: `not cleaned: ${(e as Error).message}` });
    }
  }
  else if (extname(src) === ".asar") sanitizeAsar(src, dst, r);
  else if (st.size >= MIB && isNativeExecutable(src)) sanitizeBinary(src, dst, r);
  else copyFileSync(src, dst);
}

export function sanitize(target: string, out: string): SanitizeReport {
  const t = realpathSync(target);
  const o = resolve(out);
  if (o === t || o.startsWith(t + sep) || t.startsWith(o + sep)) throw new Error("refusing: output must be outside the target and not contain it");
  const r: SanitizeReport = { tool: "anti-bla/sanitize", target, out, actions: [], reaEnv: {}, suspects: [] };
  const isDir = statSync(t).isDirectory();
  copyTree(t, isDir ? o : join(o, basename(t)), r);
  return r;
}

if (import.meta.main) {
  const [target, out] = process.argv.slice(2);
  if (!target || !out) {
    console.error("usage: bun sanitize.ts <dir|file> <out-dir>");
    process.exit(64);
  }
  console.log(JSON.stringify(sanitize(target, out), null, 2));
}
