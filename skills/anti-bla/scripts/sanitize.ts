#!/usr/bin/env bun
// Write a clean COPY of a build for REA: drop ASAR header flood, neutralize decoy fuse sentinels,
// cut BLA's native shield (Go, Rust, Flutter), drop WASM alias exports and BEAM decoy chunks, drop BLA config
// files, and clean the data formats (SQLite, models, PCAP, EVM, Dart pools). The original is never written.
// Code is never deleted here: logic that only looks like a decoy is handled by coverage.ts ("not run").
// The one exception is a .pyc: BLA's woven decoy code objects are provably unused there (nothing points at them), so they go.
import { copyFileSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, statSync, truncateSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { buildAsar, openAsar, type OpenAsar } from "./lib/asar.ts";
import { cleanApk, findDartDecoys, zeroDecoys } from "./lib/dart.ts";
import { cleanEvm, cleanEvmHex } from "./lib/evm.ts";
import { MAX_APK_FILE, MAX_EVM_FILE, MAX_PCAP_FILE, dataKind } from "./lib/formats.ts";
import { SENTINEL, findSentinels, isNativeExecutable } from "./lib/fuses.ts";
import { cleanModel } from "./lib/model.ts";
import { cleanPcap } from "./lib/pcap.ts";
import { cleanPyc } from "./lib/pybox.ts";
import { pycDecoyNames } from "./lib/pytarpit.ts";
import { dropHoney, isSqlite } from "./lib/sqlite.ts";
import { BAIT, CONFIG_NAMES, FLOOD_MIN, MAX_BIN, REA_ASAR_DEFAULT_HEADER, isFloodEntry } from "./scan.ts";
import { cleanBeam } from "./lib/beam.ts";
import { REA_MAX_RUSTC_HASHES, goBuildInfos, isGoFlood, rustcPaths, trailerStart } from "./lib/native.ts";
import { cleanWasm } from "./lib/wasm.ts";

export interface Action {
  kind: "dropped-config" | "asar-flood-dropped" | "fuse-decoys-zeroed" | "copied-asar-unchanged" | "pyc-decoys-dropped" | "pyc-kept-unchanged" | "copied" | "skipped-symlink" | "wasm-decoys-dropped" | "beam-decoys-dropped" | "native-trailer-cut" | "go-buildinfo-plant-zeroed" | "rustc-decoys-zeroed" | "dart-decoys-zeroed" | "apk-dart-decoys-zeroed" | "sqlite-honey-dropped" | "model-decoys-removed" | "pcap-flood-dropped" | "evm-trailer-removed";
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
const MAX_PYC = 16 * MIB;
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

function sanitizeWasm(src: string, dst: string, r: SanitizeReport, isNamedByGlue: (name: string) => boolean): void {
  const cleaned = cleanWasm(readFileSync(src), isNamedByGlue);
  if (!cleaned) return copyFileSync(src, dst);
  writeFileSync(dst, cleaned.buffer, { mode: statSync(src).mode });
  r.actions.push({ kind: "wasm-decoys-dropped", path: src, detail: `${cleaned.droppedExports} alias exports, custom sections: ${cleaned.droppedSections.join(", ") || "none"}` });
}

function sanitizeBeam(src: string, dst: string, r: SanitizeReport): void {
  const cleaned = cleanBeam(readFileSync(src));
  if (!cleaned) return copyFileSync(src, dst);
  writeFileSync(dst, cleaned.buffer, { mode: statSync(src).mode });
  r.actions.push({ kind: "beam-decoys-dropped", path: src, detail: `${cleaned.droppedChunks} decoy chunks, ${cleaned.droppedAtoms} canary atoms` });
}

/** Cut BLA's appended shield, then zero the decoys it planted inside the file. Sizes and offsets of what stays do not move. */
function sanitizeBinary(src: string, dst: string, r: SanitizeReport): void {
  copyFileSync(src, dst);
  // shortcut: reads the whole binary into memory; stream it if a target over 512 MiB ever matters
  let bytes = readFileSync(src);
  const cut = trailerStart(bytes);
  if (cut >= 0) {
    truncateSync(dst, cut);
    r.actions.push({ kind: "native-trailer-cut", path: src, detail: `${bytes.length - cut} B of BLA shield removed at ${cut}` });
    bytes = bytes.subarray(0, cut);
  }
  const fuses = findSentinels(bytes).filter((s) => s.decoy);
  const dart = findDartDecoys(bytes);
  // the planted header, strings and marker. BLA clears the section before it plants, so any real build info there is not restored.
  const go = goBuildInfos(bytes).filter(isGoFlood).filter((g) => g.plantEnd >= 0);
  const rustFlood = rustcPaths(bytes);
  const rust = rustFlood.distinct > REA_MAX_RUSTC_HASHES ? rustFlood.decoyOffsets : [];
  // zero only the decoy marker, hash or plant: REA no longer sees it
  const zero: [number, number][] = [...fuses.map((s): [number, number] => [s.offset, SENTINEL.length]), ...go.map((g): [number, number] => [g.offset, g.plantEnd - g.offset]), ...rust.map((o): [number, number] => [o, 40]), ...dart.map((d): [number, number] => [d.start, d.end - d.start])];
  if (!zero.length) return;
  const fd = openSync(dst, "r+");
  try {
    for (const [at, len] of zero) writeSync(fd, Buffer.alloc(len), 0, len, at);
  } finally {
    closeSync(fd);
  }
  if (fuses.length) r.actions.push({ kind: "fuse-decoys-zeroed", path: src, detail: `${fuses.length} decoy sentinels zeroed` });
  if (go.length) r.actions.push({ kind: "go-buildinfo-plant-zeroed", path: src, detail: `${go.length} BLA build-info plant zeroed; real build info that BLA overwrote is not restored` });
  if (dart.length) r.actions.push({ kind: "dart-decoys-zeroed", path: src, detail: `${dart.length} blocks, ${dart.reduce((n, d) => n + d.entries, 0)} pool entries, ${dart.reduce((n, d) => n + d.records, 0)} fake snapshot records` });
  if (rust.length) r.actions.push({ kind: "rustc-decoys-zeroed", path: src, detail: `${rust.length} decoy rustc hashes zeroed of ${rustFlood.distinct}` });
}

/** A .pyc that carries BLA decoy names or honey text gets the cleaner; every other one is copied as it is. */
function sanitizePyc(src: string, dst: string, r: SanitizeReport): void {
  const text = readFileSync(src).toString("latin1");
  if (pycDecoyNames(text).size < 3 && !text.match(BAIT)) {
    copyFileSync(src, dst);
    return;
  }
  const out = cleanPyc(src, dst);
  if (out.kind === "cleaned" && !out.removed.length && !out.trailerDropped) {
    copyFileSync(src, dst); // nothing of BLA's in it: keep the exact bytes, not a re-marshalled copy
    return;
  }
  if (out.kind === "cleaned") {
    r.actions.push({ kind: "pyc-decoys-dropped", path: src, detail: `${out.removed.length} decoy code objects dropped, ${out.trailerDropped} B honey trailer dropped` });
    return;
  }
  copyFileSync(src, dst);
  r.actions.push({ kind: "pyc-kept-unchanged", path: src, detail: out.why });
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

function copyTree(src: string, dst: string, r: SanitizeReport, isNamedByGlue: (name: string) => boolean): void {
  const st = statSync(src);
  if (st.isDirectory()) {
    mkdirSync(dst, { recursive: true });
    for (const e of readdirSync(src)) {
      const p = join(src, e);
      if (lstatSync(p).isSymbolicLink()) r.actions.push({ kind: "skipped-symlink", path: p });
      else copyTree(p, join(dst, e), r, isNamedByGlue);
    }
    return;
  }
  mkdirSync(dirname(dst), { recursive: true });
  const ext = extname(src);
  if (CONFIG_NAMES.includes(basename(src))) r.actions.push({ kind: "dropped-config", path: src });
  else if (ext === ".asar") sanitizeAsar(src, dst, r);
  else if (ext === ".pyc" && st.size <= MAX_PYC) sanitizePyc(src, dst, r);
  else if (ext === ".wasm") sanitizeWasm(src, dst, r, isNamedByGlue);
  else if (ext === ".beam") sanitizeBeam(src, dst, r);
  else if (st.size <= MAX_BIN && isNativeExecutable(src)) sanitizeBinary(src, dst, r);
  else if (dataKind(src)) {
    try {
      sanitizeData(dataKind(src)!, src, dst, r);
    } catch (e) {
      copyFileSync(src, dst);
      r.actions.push({ kind: "copied", path: src, detail: `not cleaned: ${(e as Error).message}` });
    }
  }
  else copyFileSync(src, dst);
}

/** Names a JS file in the tree uses, to keep decoy-shaped exports that host code needs. Reads the JS once, on first use. */
function glueReader(root: string): (name: string) => boolean {
  let text: string | undefined;
  const read = (p: string): string[] => {
    if (lstatSync(p).isSymbolicLink()) return [];
    const st = statSync(p);
    if (st.isDirectory()) return readdirSync(p).flatMap((e) => read(join(p, e)));
    return [".js", ".cjs", ".mjs"].includes(extname(p)) && st.size <= MAX_BIN ? [readFileSync(p, "utf8")] : [];
  };
  return (name) => (text ??= statSync(root).isDirectory() ? read(root).join("\n") : "").includes(name);
}

export function sanitize(target: string, out: string): SanitizeReport {
  const t = realpathSync(target);
  const o = resolve(out);
  if (o === t || o.startsWith(t + sep) || t.startsWith(o + sep)) throw new Error("refusing: output must be outside the target and not contain it");
  const r: SanitizeReport = { tool: "anti-bla/sanitize", target, out, actions: [], reaEnv: {}, suspects: [] };
  const isDir = statSync(t).isDirectory();
  copyTree(t, isDir ? o : join(o, basename(t)), r, glueReader(t));
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
