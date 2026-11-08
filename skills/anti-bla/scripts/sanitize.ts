#!/usr/bin/env bun
// Write a clean COPY of a build for REA: drop ASAR header flood, neutralize decoy fuse sentinels,
// cut BLA's native shield (Go, Rust), drop WASM alias exports and BEAM decoy chunks, drop BLA config
// files. The original is never written. Code is never deleted here: logic that only looks like a
// decoy is handled by coverage.ts ("not run").
import { copyFileSync, closeSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, statSync, truncateSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { buildAsar, openAsar, type OpenAsar } from "./lib/asar.ts";
import { SENTINEL, findSentinels, isNativeExecutable } from "./lib/fuses.ts";
import { CONFIG_NAMES, FLOOD_MIN, MAX_BIN, REA_ASAR_DEFAULT_HEADER, isFloodEntry } from "./scan.ts";
import { cleanBeam } from "./lib/beam.ts";
import { REA_MAX_RUSTC_HASHES, goBuildInfos, isGoFlood, rustcPaths, trailerStart } from "./lib/native.ts";
import { cleanWasm } from "./lib/wasm.ts";

export interface Action {
  kind: "dropped-config" | "asar-flood-dropped" | "fuse-decoys-zeroed" | "copied-asar-unchanged" | "copied" | "skipped-symlink" | "wasm-decoys-dropped" | "beam-decoys-dropped" | "native-trailer-cut" | "go-buildinfo-plant-zeroed" | "rustc-decoys-zeroed";
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
  // the planted header, strings and marker. BLA clears the section before it plants, so any real build info there is not restored.
  const go = goBuildInfos(bytes).filter(isGoFlood).filter((g) => g.plantEnd >= 0);
  const rustFlood = rustcPaths(bytes);
  const rust = rustFlood.distinct > REA_MAX_RUSTC_HASHES ? rustFlood.decoyOffsets : [];
  // zero only the decoy marker, hash or plant: REA no longer sees it
  const zero: [number, number][] = [...fuses.map((s): [number, number] => [s.offset, SENTINEL.length]), ...go.map((g): [number, number] => [g.offset, g.plantEnd - g.offset]), ...rust.map((o): [number, number] => [o, 40])];
  if (!zero.length) return;
  const fd = openSync(dst, "r+");
  try {
    for (const [at, len] of zero) writeSync(fd, Buffer.alloc(len), 0, len, at);
  } finally {
    closeSync(fd);
  }
  if (fuses.length) r.actions.push({ kind: "fuse-decoys-zeroed", path: src, detail: `${fuses.length} decoy sentinels zeroed` });
  if (go.length) r.actions.push({ kind: "go-buildinfo-plant-zeroed", path: src, detail: `${go.length} BLA build-info plant zeroed; real build info that BLA overwrote is not restored` });
  if (rust.length) r.actions.push({ kind: "rustc-decoys-zeroed", path: src, detail: `${rust.length} decoy rustc hashes zeroed of ${rustFlood.distinct}` });
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
  else if (ext === ".wasm") sanitizeWasm(src, dst, r, isNamedByGlue);
  else if (ext === ".beam") sanitizeBeam(src, dst, r);
  else if (st.size <= MAX_BIN && isNativeExecutable(src)) sanitizeBinary(src, dst, r);
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
