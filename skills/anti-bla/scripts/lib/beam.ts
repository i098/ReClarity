// Erlang BEAM (IFF `FOR1`): find and drop BLA 3.1.0 decoys. Shapes from BLA src/shields/formats/erlang-beam.ts:
// decoy chunks whose payload starts with `[BLA-BEAM-SHIELD]`, and canary atoms appended to the atom table.
// Real chunks are copied as read, so Code, ExpT and ImpT stay byte for byte.
const SHIELD = Buffer.from("[BLA-BEAM-SHIELD]", "latin1");
const CANARY_ATOM = "bla_beam_canary";
const SHIELD_ATOM = "[BLA-BEAM-SHIELD]";

export interface BeamChunk {
  name: string;
  /** Whole chunk: name, size, payload, padding. */
  raw: Buffer;
  payload: Buffer;
}

const pad4 = (n: number): number => (4 - (n % 4)) % 4;

/** Chunks of a well-framed BEAM form, or undefined. Bytes after the form are not chunks. */
export function parseBeam(bytes: Buffer): BeamChunk[] | undefined {
  if (bytes.length < 12 || bytes.toString("latin1", 0, 4) !== "FOR1" || bytes.toString("latin1", 8, 12) !== "BEAM") return undefined;
  const end = 8 + bytes.readUInt32BE(4);
  if (end > bytes.length) return undefined;
  const out: BeamChunk[] = [];
  let at = 12;
  while (at < end) {
    if (at + 8 > end) return undefined;
    const size = bytes.readUInt32BE(at + 4);
    const next = at + 8 + size + pad4(size);
    if (next > end) return undefined;
    out.push({ name: bytes.toString("latin1", at, at + 4), raw: bytes.subarray(at, next), payload: bytes.subarray(at + 8, at + 8 + size) });
    at = next;
  }
  return out;
}

export const isShieldChunk = (c: BeamChunk): boolean => c.payload.subarray(0, SHIELD.length).equals(SHIELD);

/** One atom length in an OTP 28 compact atom table: tag `u`, 1 to 8 bytes. */
function compactLength(b: Buffer, at: number): { value: number; next: number } | undefined {
  const first = b[at];
  if (first === undefined || (first & 7) !== 0) return undefined;
  if (!(first & 8)) return { value: first >> 4, next: at + 1 };
  if (!(first & 0x10)) return b[at + 1] === undefined ? undefined : { value: ((first >> 5) << 8) | b[at + 1]!, next: at + 2 };
  const count = (first >> 5) + 2;
  if (first >> 5 === 7 || at + 1 + count > b.length) return undefined;
  let value = 0;
  for (let i = 0; i < count; i++) value = value * 256 + b[at + 1 + i]!;
  return { value, next: at + 1 + count };
}

/** Atoms of an `AtU8` payload with the byte offset where each one starts. Undefined when the table does not parse. */
export function atomTable(payload: Buffer): { compact: boolean; atoms: { name: string; start: number }[] } | undefined {
  if (payload.length < 4) return undefined;
  const declared = payload.readInt32BE(0);
  const compact = declared < 0;
  const atoms: { name: string; start: number }[] = [];
  let at = 4;
  for (let i = 0; i < Math.abs(declared); i++) {
    const len = compact ? compactLength(payload, at) : payload[at] === undefined ? undefined : { value: payload[at]!, next: at + 1 };
    if (!len || len.next + len.value > payload.length) return undefined;
    atoms.push({ name: payload.toString("utf8", len.next, len.next + len.value), start: at });
    at = len.next + len.value;
  }
  return { compact, atoms };
}

/** Index where BLA's appended canary atoms start: `bla_beam_canary` straight followed by `[BLA-BEAM-SHIELD]`. -1 when absent. */
export const canaryStart = (atoms: { name: string }[]): number => atoms.findIndex((a, k) => a.name === CANARY_ATOM && atoms[k + 1]?.name === SHIELD_ATOM);

export interface BeamCount {
  chunks: number;
  decoyChunks: number;
  decoyAtoms: number;
}

/** What BLA planted in a form. */
export function countBeamDecoys(bytes: Buffer): BeamCount | undefined {
  const chunks = parseBeam(bytes);
  if (!chunks) return undefined;
  let decoyAtoms = 0;
  for (const c of chunks) {
    if (c.name !== "AtU8") continue;
    const t = atomTable(c.payload);
    const cut = t ? canaryStart(t.atoms) : -1;
    if (t && cut >= 0) decoyAtoms += t.atoms.length - cut;
  }
  return { chunks: chunks.length, decoyChunks: chunks.filter(isShieldChunk).length, decoyAtoms };
}

/** Form without decoy chunks and canary atoms. Atoms before the canary keep their index. Undefined when nothing is planted. */
export function cleanBeam(bytes: Buffer): { buffer: Buffer; droppedChunks: number; droppedAtoms: number } | undefined {
  const chunks = parseBeam(bytes);
  const found = chunks && countBeamDecoys(bytes);
  if (!chunks || !found || (!found.decoyChunks && !found.decoyAtoms)) return undefined;
  const kept = chunks.filter((c) => !isShieldChunk(c)).map((c) => {
    if (c.name !== "AtU8") return c.raw;
    const t = atomTable(c.payload);
    const cut = t ? canaryStart(t.atoms) : -1;
    if (!t || cut < 0) return c.raw;
    const payload = Buffer.from(c.payload.subarray(0, t.atoms[cut]!.start));
    payload.writeInt32BE(t.compact ? -cut : cut, 0);
    const head = Buffer.alloc(8);
    head.write(c.name, 0, "latin1");
    head.writeUInt32BE(payload.length, 4);
    return Buffer.concat([head, payload, Buffer.alloc(pad4(payload.length))]);
  });
  const body = Buffer.concat([Buffer.from("BEAM", "latin1"), ...kept]);
  const head = Buffer.alloc(8);
  head.write("FOR1", 0, "latin1");
  head.writeUInt32BE(body.length, 4);
  return { buffer: Buffer.concat([head, body]), droppedChunks: found.decoyChunks, droppedAtoms: found.decoyAtoms };
}
