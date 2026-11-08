// WebAssembly binary: find and drop BLA 3.1.0 decoys (alias exports and decoy custom sections).
// Shapes from BLA src/shields/formats/wasm.ts. Exports and custom sections only: code, imports, types
// and every real export stay byte for byte.
const MAGIC = Buffer.from([0x00, 0x61, 0x73, 0x6d]);

/** Alias export BLA appends: `enclave_export_<hex4>_<i>_eeee...`. `bla_enclave_verify_*` is the name BLA gives these in its interface plan. */
const DECOY_EXPORT = /^(enclave_export_|bla_enclave_verify_)/;
/** Custom sections BLA appends: manifest, attestation, canary, diagnostics, honey names, interface plan. */
const DECOY_SECTION = /^(bla\.|enclave\.attestation\.)/;
const HONEY_MODULE = "tee_hardware_enclave_transport_stub_";

export interface WasmSection {
  id: number;
  /** Whole section: id byte, size, payload. */
  raw: Buffer;
  payload: Buffer;
}
export interface WasmExport {
  name: string;
  kind: number;
  index: number;
  /** Encoded entry bytes, kept as read. */
  raw: Buffer;
}
export interface WasmDecoys {
  /** Export entries that are decoys (name shape, alias of a real export, not named by glue). */
  exports: WasmExport[];
  /** Custom sections that are decoys, by section index. */
  sections: Map<number, string>;
  exportCount: number;
}

const uleb = (b: Buffer, at: number): { value: number; next: number } => {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    const byte = b[at + i];
    if (byte === undefined) throw new Error("truncated LEB128");
    value += (byte & 0x7f) * 2 ** (7 * i);
    if (!(byte & 0x80)) return { value, next: at + i + 1 };
  }
  throw new Error("LEB128 over 32 bits");
};

const encodeUleb = (n: number): Buffer => {
  const out: number[] = [];
  do {
    const byte = n % 128;
    n = Math.floor(n / 128);
    out.push(n > 0 ? byte | 0x80 : byte);
  } while (n > 0);
  return Buffer.from(out);
};

/** Sections of a module, or undefined when the bytes are not a well-framed module. */
export function parseSections(bytes: Buffer): WasmSection[] | undefined {
  if (bytes.length < 8 || !bytes.subarray(0, 4).equals(MAGIC)) return undefined;
  const out: WasmSection[] = [];
  let at = 8;
  try {
    while (at < bytes.length) {
      const { value: size, next } = uleb(bytes, at + 1);
      const end = next + size;
      if (end > bytes.length) return undefined;
      out.push({ id: bytes[at]!, raw: bytes.subarray(at, end), payload: bytes.subarray(next, end) });
      at = end;
    }
  } catch {
    return undefined;
  }
  return out;
}

/** Export entries, or undefined when the section is not exactly framed. */
export function parseExports(payload: Buffer): WasmExport[] | undefined {
  try {
    const { value: count, next } = uleb(payload, 0);
    let at = next;
    const out: WasmExport[] = [];
    for (let i = 0; i < count; i++) {
      const start = at;
      const len = uleb(payload, at);
      const nameEnd = len.next + len.value;
      if (nameEnd >= payload.length) return undefined;
      const idx = uleb(payload, nameEnd + 1);
      out.push({ name: payload.subarray(len.next, nameEnd).toString("utf8"), kind: payload[nameEnd]!, index: idx.value, raw: payload.subarray(start, idx.next) });
      at = idx.next;
    }
    return at === payload.length ? out : undefined;
  } catch {
    return undefined;
  }
}

/** Name and body of a custom section payload. */
function customName(payload: Buffer): { name: string; body: Buffer } | undefined {
  try {
    const { value, next } = uleb(payload, 0);
    if (next + value > payload.length) return undefined;
    return { name: payload.subarray(next, next + value).toString("utf8"), body: payload.subarray(next + value) };
  } catch {
    return undefined;
  }
}

/** True for the `name` section BLA adds: module-name subsection naming a fake enclave transport. */
function isHoneyNameSection(body: Buffer): boolean {
  try {
    if (body[0] !== 0) return false;
    const sub = uleb(body, 1);
    const len = uleb(body, sub.next);
    return body.subarray(len.next, len.next + len.value).toString("utf8").startsWith(HONEY_MODULE);
  } catch {
    return false;
  }
}

/**
 * Decoys in a module. `isNamedByGlue` says the host code names an export, so it stays. A decoy export must
 * also alias a function that a non-decoy export reaches: BLA only aliases real exported functions.
 */
export function findWasmDecoys(sections: WasmSection[], isNamedByGlue: (name: string) => boolean = () => false): WasmDecoys {
  const decoys: WasmDecoys = { exports: [], sections: new Map(), exportCount: 0 };
  sections.forEach((s, i) => {
    if (s.id === 0) {
      const c = customName(s.payload);
      if (c && (DECOY_SECTION.test(c.name) || (c.name === "name" && isHoneyNameSection(c.body)))) decoys.sections.set(i, c.name);
    } else if (s.id === 7) {
      const entries = parseExports(s.payload);
      if (!entries) return;
      decoys.exportCount += entries.length;
      const real = new Set(entries.filter((e) => !DECOY_EXPORT.test(e.name)).map((e) => `${e.kind}:${e.index}`));
      for (const e of entries) if (DECOY_EXPORT.test(e.name) && e.kind === 0 && real.has(`0:${e.index}`) && !isNamedByGlue(e.name)) decoys.exports.push(e);
    }
  });
  return decoys;
}

/** Module without the decoys. Everything else is copied as read. Undefined when there is nothing to drop. */
export function cleanWasm(bytes: Buffer, isNamedByGlue?: (name: string) => boolean): { buffer: Buffer; droppedExports: number; droppedSections: string[] } | undefined {
  const sections = parseSections(bytes);
  if (!sections) return undefined;
  const decoys = findWasmDecoys(sections, isNamedByGlue);
  if (!decoys.exports.length && !decoys.sections.size) return undefined;
  const drop = new Set(decoys.exports.map((e) => e.name));
  const parts: Buffer[] = [bytes.subarray(0, 8)];
  sections.forEach((s, i) => {
    if (decoys.sections.has(i)) return;
    if (s.id !== 7 || !drop.size) return void parts.push(s.raw);
    const kept = parseExports(s.payload)!.filter((e) => !drop.has(e.name));
    const body = Buffer.concat([encodeUleb(kept.length), ...kept.map((e) => e.raw)]);
    parts.push(Buffer.from([7]), encodeUleb(body.length), body);
  });
  return { buffer: Buffer.concat(parts), droppedExports: decoys.exports.length, droppedSections: [...decoys.sections.values()] };
}
