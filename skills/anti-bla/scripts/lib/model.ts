// BLA 3.1.0 model shields, safetensors and GGUF. Both plant a nesting breaker one level past REA's limit
// (MODEL_JSON_NESTING / MODEL_METADATA_NESTING = 32) and add `enclave.*` bait metadata.
//
// Gate: the breaker must be present (safetensors: depth > 32 with BLA's literal note; GGUF: key
// `enclave.nesting.breaker`, array depth > 32). Only then are the other BLA-added entries removed as
// well. That restores the original file, including GGUF tensor-data alignment, which BLA does not repair.
// Tensor bytes are never read or changed: they are copied through.
import { closeSync, fstatSync, openSync, readSync, writeSync } from "node:fs";

export const MODEL_NESTING_LIMIT = 32;
export const NESTING_NOTE = "BLA Counter-REA JSON nesting breaker";
const MAX_ST_HEADER = 100_000_000;
const MAX_GGUF_DEPTH = 64;
const COPY_CHUNK = 4 * 1024 * 1024;

export interface ModelDecoys {
  format: "safetensors" | "gguf";
  /** What the clean copy drops. Empty when the file is not BLA-hardened. */
  remove: string[];
  /** Nesting depth of the breaker, 0 when there is none. */
  depth: number;
}

function readAt(fd: number, at: number, n: number): Buffer {
  const b = Buffer.alloc(n);
  let got = 0;
  while (got < n) {
    const r = readSync(fd, b, got, n - got, at + got);
    if (r === 0) throw new Error("truncated model file");
    got += r;
  }
  return b;
}

function copyRange(from: number, to: number, start: number, end: number, at: number): void {
  const buf = Buffer.alloc(Math.min(COPY_CHUNK, Math.max(1, end - start)));
  for (let p = start, w = at; p < end; ) {
    const n = readSync(from, buf, 0, Math.min(buf.length, end - p), p);
    if (n === 0) throw new Error("truncated model file");
    writeSync(to, buf, 0, n, w);
    p += n;
    w += n;
  }
}

/** Nesting depth of a parsed JSON value: a scalar is 0, `{a: 1}` is 1. Iterative, so a hostile header cannot overflow the stack. */
function jsonDepth(root: unknown): number {
  let max = 0;
  const stack: [unknown, number][] = [[root, 0]];
  while (stack.length) {
    const [v, d] = stack.pop()!;
    if (typeof v !== "object" || v === null) continue;
    max = Math.max(max, d + 1);
    for (const c of Object.values(v)) stack.push([c, d + 1]);
  }
  return max;
}
const holdsNote = (root: unknown): boolean => {
  const stack: unknown[] = [root];
  while (stack.length) {
    const v = stack.pop();
    if (v === NESTING_NOTE) return true;
    if (typeof v === "object" && v !== null) stack.push(...Object.values(v));
  }
  return false;
};

const ST_META_KEYS = /^(enclave\.(manifest|canary\.token|canary\.transport|diagnostic)\.\d+|enclave\.delegation\.notice)$/;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

interface StParsed {
  header: Record<string, unknown>;
  /** Offset where tensor data starts. */
  dataAt: number;
}
function readSafetensors(fd: number, size: number): StParsed | undefined {
  if (size < 10) return undefined;
  const len = readAt(fd, 0, 8).readBigUInt64LE(0);
  if (len < 2n || len > BigInt(MAX_ST_HEADER) || 8n + len > BigInt(size)) return undefined;
  const text = readAt(fd, 8, Number(len)).toString("utf8");
  if (!text.startsWith("{")) return undefined;
  try {
    const header: unknown = JSON.parse(text);
    return isRecord(header) ? { header, dataAt: 8 + Number(len) } : undefined;
  } catch {
    return undefined;
  }
}

/** Tensor descriptor keys that carry the breaker, and the BLA metadata entries to drop with them. */
function safetensorsDecoys(header: Record<string, unknown>): { breakers: [string, string][]; meta: string[]; depth: number } {
  const breakers: [string, string][] = [];
  let depth = 0;
  for (const [name, desc] of Object.entries(header)) {
    if (name === "__metadata__" || !isRecord(desc)) continue;
    for (const [key, value] of Object.entries(desc)) {
      if (key === "dtype" || key === "shape" || key === "data_offsets") continue;
      // root(0) > descriptor(1) > value: the deepest scalar sits jsonDepth + 1 levels below the descriptor
      const d = jsonDepth(value) + 2;
      if (d > MODEL_NESTING_LIMIT && holdsNote(value)) {
        breakers.push([name, key]);
        depth = Math.max(depth, d);
      }
    }
  }
  const meta: string[] = [];
  const md = header.__metadata__;
  if (breakers.length && isRecord(md)) {
    for (const [k, v] of Object.entries(md)) {
      if (ST_META_KEYS.test(k) || (k === "enclave.delegation.status" && v === "HARDWARE_TEE_SPLIT_WEIGHTS") || (k === "bla.shield.signature" && typeof v === "string" && /^BLA-MODEL-SHIELD-[0-9a-f]{8}$/.test(v))) meta.push(k);
    }
  }
  return { breakers, meta, depth };
}

// ---- GGUF ----

const GGUF_MAGIC = Buffer.from("GGUF", "ascii");
const WIDTH: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };
const STRING = 8;
const ARRAY = 9;

/** Windowed reader so a tokenizer array with 150k strings costs a few reads, not 150k. */
class Window {
  #at = 0;
  #buf: Buffer = Buffer.alloc(0);
  constructor(readonly fd: number, readonly size: number) {}
  get(at: number, n: number): Buffer {
    if (at < 0 || at + n > this.size) throw new Error("GGUF value runs past the end of the file");
    if (at < this.#at || at + n > this.#at + this.#buf.length) {
      const len = Math.min(Math.max(n, 1 << 20), this.size - at);
      this.#buf = readAt(this.fd, at, len);
      this.#at = at;
    }
    return this.#buf.subarray(at - this.#at, at - this.#at + n);
  }
  u32(at: number): number {
    return this.get(at, 4).readUInt32LE(0);
  }
  u64(at: number): number {
    const v = this.get(at, 8).readBigUInt64LE(0);
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("GGUF length beyond exact precision");
    return Number(v);
  }
}

/** End offset of a value and its array depth (0 for a non-array). Depth is capped so a hostile file cannot recurse without bound. */
function skipValue(w: Window, type: number, at: number, depth: number): { end: number; frames: number } {
  if (depth > MAX_GGUF_DEPTH) throw new Error("GGUF array nesting past 64");
  const fixed = WIDTH[type];
  if (fixed !== undefined) return { end: at + fixed, frames: 0 };
  if (type === STRING) return { end: at + 8 + w.u64(at), frames: 0 };
  if (type !== ARRAY) throw new Error(`unknown GGUF value type ${type}`);
  const elem = w.u32(at);
  const count = w.u64(at + 4);
  let cur = at + 12;
  const width = WIDTH[elem];
  if (width !== undefined) return { end: cur + count * width, frames: 1 };
  let deepest = 0;
  for (let i = 0; i < count; i++) {
    const v = skipValue(w, elem, cur, depth + 1);
    deepest = Math.max(deepest, v.frames);
    cur = v.end;
  }
  return { end: cur, frames: 1 + deepest };
}

interface GgufEntry {
  key: string;
  start: number;
  end: number;
  frames: number;
  /** First bytes of a string value, enough to recognize BLA's description tag. */
  head: string;
}
interface GgufParsed {
  version: number;
  tensorCount: bigint;
  entries: GgufEntry[];
  kvEnd: number;
}
const BLA_GGUF_KEYS = /^enclave\.(delegation\.manifest|nesting\.breaker|canary\.token\.\d+|canary\.transport\.\d+|diagnostic\.\d+)$/;
const DESCRIPTION_TAG = "[BLA-MODEL-SHIELD] ";

function readGguf(fd: number, size: number): GgufParsed | undefined {
  if (size < 24) return undefined;
  const w = new Window(fd, size);
  if (!w.get(0, 4).equals(GGUF_MAGIC)) return undefined;
  const version = w.u32(4);
  if (version !== 2 && version !== 3) return undefined;
  const kvCount = w.u64(16);
  if (kvCount > 1_000_000) return undefined;
  const entries: GgufEntry[] = [];
  let at = 24;
  for (let i = 0; i < kvCount; i++) {
    const start = at;
    const keyLen = w.u64(at);
    const key = w.get(at + 8, keyLen).toString("utf8");
    const type = w.u32(at + 8 + keyLen);
    const valueAt = at + 12 + keyLen;
    const v = skipValue(w, type, valueAt, 0);
    const head = type === STRING ? w.get(valueAt + 8, Math.min(w.u64(valueAt), DESCRIPTION_TAG.length)).toString("utf8") : "";
    entries.push({ key, start, end: v.end, frames: v.frames, head });
    at = v.end;
  }
  if (at > size) return undefined;
  return { version, tensorCount: w.get(8, 8).readBigUInt64LE(0), entries, kvEnd: at };
}

function ggufDecoys(p: GgufParsed): { remove: GgufEntry[]; depth: number } {
  const breaker = p.entries.find((e) => e.key === "enclave.nesting.breaker" && e.frames > MODEL_NESTING_LIMIT);
  if (!breaker) return { remove: [], depth: 0 };
  const remove = p.entries.filter((e) => BLA_GGUF_KEYS.test(e.key) || (e.key === "general.description" && e.head === DESCRIPTION_TAG));
  return { remove, depth: breaker.frames };
}

// ---- public ----

function withFile<T>(path: string, f: (fd: number, size: number) => T): T {
  const fd = openSync(path, "r");
  try {
    return f(fd, fstatSync(fd).size);
  } finally {
    closeSync(fd);
  }
}

/** Read-only check. `undefined` when the file is not a model this module understands. */
export function findModelDecoys(path: string): ModelDecoys | undefined {
  try {
    return withFile(path, (fd, size) => {
      if (readAt(fd, 0, Math.min(size, 4)).equals(GGUF_MAGIC)) {
        const p = readGguf(fd, size);
        if (!p) return undefined;
        const d = ggufDecoys(p);
        return { format: "gguf", remove: d.remove.map((e) => e.key), depth: d.depth };
      }
      const st = readSafetensors(fd, size);
      if (!st) return undefined;
      const d = safetensorsDecoys(st.header);
      return { format: "safetensors", remove: [...d.breakers.map(([t, k]) => `${t}.${k}`), ...d.meta.map((k) => `__metadata__.${k}`)], depth: d.depth };
    });
  } catch {
    return undefined;
  }
}

/** Write the clean copy to `dst`. Returns what was dropped, or `undefined` (and writes nothing) when there is nothing to drop. */
export function cleanModel(src: string, dst: string): ModelDecoys | undefined {
  try {
    return withFile(src, (from, size) => {
      const head = readAt(from, 0, Math.min(size, 4));
      const to = () => openSync(dst, "w");
      if (head.equals(GGUF_MAGIC)) {
        const p = readGguf(from, size);
        if (!p) return undefined;
        const d = ggufDecoys(p);
        if (!d.remove.length) return undefined;
        const out = to();
        try {
          const prefix = readAt(from, 0, 24);
          prefix.writeBigUInt64LE(BigInt(p.entries.length - d.remove.length), 16);
          writeSync(out, prefix);
          let w = 24;
          for (const e of p.entries) {
            if (d.remove.includes(e)) continue;
            copyRange(from, out, e.start, e.end, w);
            w += e.end - e.start;
          }
          copyRange(from, out, p.kvEnd, size, w);
        } finally {
          closeSync(out);
        }
        return { format: "gguf", remove: d.remove.map((e) => e.key), depth: d.depth };
      }
      const st = readSafetensors(from, size);
      if (!st) return undefined;
      const d = safetensorsDecoys(st.header);
      if (!d.breakers.length) return undefined;
      const header = structuredClone(st.header);
      for (const [name, key] of d.breakers) delete (header[name] as Record<string, unknown>)[key];
      const md = header.__metadata__;
      if (isRecord(md)) {
        for (const k of d.meta) delete md[k];
        if (!Object.keys(md).length) delete header.__metadata__;
      }
      const raw = Buffer.from(JSON.stringify(header), "utf8");
      const padded = Buffer.alloc(Math.ceil(raw.length / 8) * 8, 0x20);
      raw.copy(padded);
      const lead = Buffer.alloc(8);
      lead.writeBigUInt64LE(BigInt(padded.length), 0);
      const out = to();
      try {
        writeSync(out, lead);
        writeSync(out, padded);
        copyRange(from, out, st.dataAt, size, 8 + padded.length);
      } finally {
        closeSync(out);
      }
      return { format: "safetensors", remove: [...d.breakers.map(([t, k]) => `${t}.${k}`), ...d.meta.map((k) => `__metadata__.${k}`)], depth: d.depth };
    });
  } catch {
    return undefined;
  }
}
