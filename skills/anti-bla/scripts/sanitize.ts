#!/usr/bin/env bun
// Write a clean COPY of a build for REA: drop ASAR header flood, neutralize decoy fuse
// sentinels, drop BLA config files. The original is never written. Code is never deleted
// here: logic that only looks like a decoy is handled by coverage.ts ("not run"). The one exception is a
// .pyc: BLA's woven decoy code objects are provably unused there (nothing points at them), so they go.
import { copyFileSync, closeSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { buildAsar, openAsar, type OpenAsar } from "./lib/asar.ts";
import { SENTINEL, findSentinels, isNativeExecutable } from "./lib/fuses.ts";
import { cleanPyc } from "./lib/pybox.ts";
import { pycDecoyNames } from "./lib/pytarpit.ts";
import { BAIT, CONFIG_NAMES, FLOOD_MIN, REA_ASAR_DEFAULT_HEADER, isFloodEntry } from "./scan.ts";

export interface Action {
  kind: "dropped-config" | "asar-flood-dropped" | "fuse-decoys-zeroed" | "pyc-decoys-dropped" | "pyc-kept-unchanged" | "copied-asar-unchanged" | "copied" | "skipped-symlink";
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

function sanitizeBinary(src: string, dst: string, r: SanitizeReport): void {
  copyFileSync(src, dst);
  // shortcut: reads the whole binary into memory; stream it if a 1 GB target ever shows up
  const decoys = findSentinels(readFileSync(src)).filter((s) => s.decoy);
  if (!decoys.length) return;
  const fd = openSync(dst, "r+");
  try {
    // zero only the 32-byte marker: size and offsets stay the same, REA no longer sees a sentinel
    for (const s of decoys) writeSync(fd, Buffer.alloc(SENTINEL.length), 0, SENTINEL.length, s.offset);
  } finally {
    closeSync(fd);
  }
  r.actions.push({ kind: "fuse-decoys-zeroed", path: src, detail: `${decoys.length} decoy sentinels zeroed` });
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
  else if (extname(src) === ".asar") sanitizeAsar(src, dst, r);
  else if (extname(src) === ".pyc" && st.size <= MAX_PYC) sanitizePyc(src, dst, r);
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
