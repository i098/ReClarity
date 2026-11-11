// BLA 3.2.2 formats that carry their shield as an appended trailer, a planted archive entry, a sidecar file or an emitted source file:
// DEX, IL2CPP metadata, .NET assemblies, ZIP/APK (Android manifest, R8 mapping and JNI decoys), Bun sidecars, C/Rust/Go headers.
// Every marker below is a literal from BLA's own generator (src/shields/formats/*.ts), confirmed on real `bla protect` output.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { entryData, replaceData, writeZip, type ZipEntry } from "./zip.ts";

const DEX_TRAILER = Buffer.from("\0[BLA-DEX-SHIELD-V1]");
const DEX_XREF = Buffer.from("BLA-DEX-XREF-V1");
const IL2CPP_TRAILER = Buffer.from("\0[BLA-IL2CPP-SHIELD]\0");
const DOTNET_TRAILER = Buffer.from("\0BLA_DOTNET_CLR_SHIELD_V1\0");
const ARCHIVE_SCHEMA = "bla-archive-enclave-shield/v1";

export const isDex = (b: Buffer): boolean => b.length >= 112 && b.toString("latin1", 0, 4) === "dex\n";
export const isIl2cpp = (b: Buffer): boolean => b.length >= 256 && b.readUInt32LE(0) === 0xfab11baf;

/** Offset where BLA's appended .NET metadata section starts, or -1. A PE that is not an MZ file is not looked at. */
export const dotnetTrailerStart = (b: Buffer): number => (b.length > 2 && b[0] === 0x4d && b[1] === 0x5a ? b.indexOf(DOTNET_TRAILER) : -1);

export const isDexXref = (b: Buffer): boolean => isDex(b) && b.includes(DEX_XREF);

/** The DEX without BLA's trailer, with file_size, SHA-1 and Adler-32 recomputed as BLA did. Undefined when there is no trailer. */
export function cleanDex(b: Buffer): Buffer | undefined {
  const cut = isDex(b) ? b.indexOf(DEX_TRAILER) : -1;
  if (cut < 112) return undefined;
  const out = Buffer.from(b.subarray(0, cut));
  out.writeUInt32LE(out.length, 32);
  createHash("sha1").update(out.subarray(32)).digest().copy(out, 12);
  let a = 1;
  let s = 0;
  for (const x of out.subarray(12)) {
    a = (a + x) % 65521;
    s = (s + a) % 65521;
  }
  out.writeUInt32LE(((s << 16) | a) >>> 0, 8);
  return out;
}

/** The IL2CPP metadata without BLA's literal trailer. Undefined when there is none. */
export function cleanIl2cpp(b: Buffer): Buffer | undefined {
  const cut = isIl2cpp(b) ? b.indexOf(IL2CPP_TRAILER) : -1;
  return cut >= 256 ? b.subarray(0, cut) : undefined;
}

export type ZipFinding = "archive_decoy" | "android_manifest_decoy" | "android_r8_decoy" | "android_dex_xref_decoy" | "dex_shield" | "il2cpp_shield";
export interface ZipHit {
  name: string;
  id: ZipFinding;
  /** drop: the entry is BLA's own. cut: the entry is the developer's and BLA appended a trailer. */
  action: "drop" | "cut";
  clean?: Buffer;
}

const SHIELD_DIRS = /^assets\/(?:bla-shield|enclave)\/bla-attestation-manifest\.json$/;
const planted = (name: string): ZipFinding | undefined => {
  const base = basename(name);
  if (/^assets\/bla-shield\//.test(name)) return /^AndroidManifest/.test(base) ? "android_manifest_decoy" : /mapping\.txt$/.test(base) ? "android_r8_decoy" : "archive_decoy";
  if (/^assets\/enclave\/bla-(?:attestation-manifest\.json|canary-tokens\.txt)$/.test(name) || /^enclave\/shadow_module_[0-9a-f]{6}\.json$/.test(name)) return "archive_decoy";
  return name === "lib/arm64-v8a/libbla_enclave_jni.so" ? "android_r8_decoy" : undefined;
};

/** What BLA 3.2.2 added to a ZIP or APK. The planted entries count only when BLA's manifest entry (schema `bla-archive-enclave-shield/v1`) is there. */
export function zipHits(entries: ZipEntry[]): ZipHit[] {
  const hits: ZipHit[] = [];
  let marked = false;
  try {
    marked = entries.some((e) => SHIELD_DIRS.test(e.name) && entryData(e).includes(ARCHIVE_SCHEMA));
  } catch {}
  for (const e of entries) {
    const id = marked ? planted(e.name) : undefined;
    if (id) {
      hits.push({ name: e.name, id, action: "drop" });
      continue;
    }
    if (!/\.dex$|global-metadata\.dat$/.test(e.name)) continue;
    let data: Buffer;
    try {
      data = entryData(e);
    } catch {
      continue;
    }
    if (marked && isDexXref(data)) hits.push({ name: e.name, id: "android_dex_xref_decoy", action: "drop" });
    else {
      const dex = cleanDex(data);
      const meta = dex ? undefined : cleanIl2cpp(data);
      if (dex || meta) hits.push({ name: e.name, id: dex ? "dex_shield" : "il2cpp_shield", action: "cut", clean: (dex ?? meta)! });
    }
  }
  return hits;
}

/** The archive without BLA's entries and trailers. The rewrite drops extra fields and the signing block, as zip.ts says. */
export function cleanZip(entries: ZipEntry[], hits: ZipHit[]): Buffer {
  const by = new Map(hits.map((h) => [h.name, h]));
  return writeZip(entries.flatMap((e) => {
    const h = by.get(e.name);
    return !h ? [e] : h.action === "drop" ? [] : [replaceData(e, h.clean!)];
  }));
}

// --- sidecars and emitted headers ---

const SIDECAR_SUFFIX = ".bunfs-snapshot";
const SIDECAR_NOTE_SUFFIX = ".bla-sidecar.v1.json";
const MAX_SHIELD_FILE = 16 * 1024 * 1024;
/** `bla emit-headers` output. 3.2.2 dropped the "BLA-SHIELD" banner, so the match is on identifiers the generator emits. */
const HEADER_SHAPES: Record<string, RegExp> = {
  ".h": /#ifndef BLA_SHIELD_H\b[\s\S]*enclave_tarpit_fn_\d+/,
  ".hpp": /#ifndef BLA_SHIELD_H\b[\s\S]*enclave_tarpit_fn_\d+/,
  ".rs": /BLA_RUSTC_OVERFLOW_TABLE[\s\S]*fn enclave_tarpit_\d+\(/,
  ".go": /var ShadowHeapSlots = \[16\]uint32[\s\S]*func EnclaveTarpit\d+\(/,
};

/**
 * A file BLA wrote beside or for the build, found by name and then by content:
 * the decoy Bun module graph `<binary>.bunfs-snapshot` (its entry module name and bytecode tag are literals; the binary beside it is never touched),
 * its `.bla-sidecar.v1.json` note, and an emitted C, Rust or Go header.
 */
export function shieldFileId(path: string): "bun_sidecar_decoy" | "native_header_decoy" | undefined {
  const name = basename(path);
  const header = HEADER_SHAPES[extname(name)];
  if (!header && !name.endsWith(SIDECAR_SUFFIX) && !name.endsWith(SIDECAR_NOTE_SUFFIX)) return undefined;
  if (statSync(path).size > MAX_SHIELD_FILE) return undefined;
  const b = readFileSync(path);
  if (header) return header.test(b.toString("latin1")) ? "native_header_decoy" : undefined;
  if (name.endsWith(SIDECAR_SUFFIX)) return b.includes("/$bunfs/root/enclave-attestation-main.js") || b.includes("BLA-DECOY-BYTECODE") ? "bun_sidecar_decoy" : undefined;
  return b.includes('"bla-sidecar-entangle/v1"') ? "bun_sidecar_decoy" : undefined;
}
