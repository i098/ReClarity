// BLA 3.1.0 EVM shield: replaces the terminal Solidity metadata (CBOR map + 2-byte big-endian length) with
// its own, whose `bla` entry is `[BLA-EVM-SHIELD]`, and at `maximum`/`bankrupt` puts a run of JUMPDEST
// (0x5b) filler in front of it (64 KiB, or up to REA's 4 MiB input limit). BLA drops the original
// metadata before it adds its own, so that metadata cannot come back.
// The clean copy removes BLA's trailer and the filler. It keeps one JUMPDEST of the run: a real contract
// that ends in a JUMPDEST then keeps it, and one extra inert JUMPDEST changes nothing.

/** Real code never ends in this many JUMPDESTs; BLA's smallest filler is 64 KiB. */
export const MIN_FILLER_RUN = 1024;
const JUMPDEST = 0x5b;
// CBOR text(3) "bla" then text(16) "[BLA-EVM-SHIELD]"
const BLA_ENTRY = Buffer.concat([Buffer.from([0x63]), Buffer.from("bla"), Buffer.from([0x70]), Buffer.from("[BLA-EVM-SHIELD]")]);

/** Offset where BLA's terminal metadata starts, or -1 when the code does not end in BLA's trailer. */
export function shieldTrailerAt(code: Buffer): number {
  if (code.length < 3) return -1;
  const len = code.readUInt16BE(code.length - 2);
  const at = code.length - 2 - len;
  if (len === 0 || at < 0 || code[at]! >> 5 !== 5) return -1;
  return code.subarray(at, code.length - 2).includes(BLA_ENTRY) ? at : -1;
}

export interface EvmResult {
  buffer: Buffer;
  trailerBytes: number;
  fillerBytes: number;
}

export function cleanEvm(code: Buffer): EvmResult | undefined {
  const at = shieldTrailerAt(code);
  if (at < 0) return undefined;
  let end = at;
  while (end > 0 && code[end - 1] === JUMPDEST) end--;
  const run = at - end;
  const fillerBytes = run >= MIN_FILLER_RUN ? run - 1 : 0;
  return { buffer: code.subarray(0, at - fillerBytes), trailerBytes: code.length - at, fillerBytes };
}

const isWs = (c: string): boolean => c === " " || (c >= "\t" && c <= "\r");

/** A hex-encoded carrier (REA accepts `raw` and `hex`): decode, clean, encode in the same style. No regex: the text can be 8 MB. */
export function cleanEvmHex(text: string): (EvmResult & { text: string }) | undefined {
  let start = 0;
  let end = text.length;
  while (start < end && isWs(text[start]!)) start++;
  while (end > start && isWs(text[end - 1]!)) end--;
  const prefix = text.startsWith("0x", start) || text.startsWith("0X", start) ? text.slice(start, start + 2) : "";
  const digits = text.slice(start + prefix.length, end);
  // Buffer.from stops at the first bad character, so a short result means the text is not pure hex
  const bytes = Buffer.from(digits, "hex");
  if (!bytes.length || bytes.length * 2 !== digits.length) return undefined;
  const r = cleanEvm(bytes);
  if (!r) return undefined;
  const hex = r.buffer.toString("hex");
  return { ...r, text: text.slice(0, start) + prefix + (/[A-F]/.test(digits.slice(0, 4096)) ? hex.toUpperCase() : hex) + text.slice(end) };
}
