// Native binaries (ELF, Mach-O, PE): BLA 3.1.0 shapes for the Go, Rust and trailer decoys.
// Shapes from BLA src/shields/formats/native.ts and go-flutter-exhaustion.ts. Reads only; callers patch.
export const NATIVE_TRAILER = Buffer.from("\0[BLA-NATIVE-SHIELD-V1]\0.dep-v0\0", "latin1");
/** REA `MAX_RUSTC_HASHES`: more distinct `/rustc/<hash>/` paths than this is a capacity error. */
export const REA_MAX_RUSTC_HASHES = 64;
/** REA `MAX_BUILD_INFO_BYTES`: Go version and module text together may not exceed this. */
export const REA_MAX_GO_BUILDINFO = 1024 * 1024;

const RUSTC = Buffer.from("/rustc/", "latin1");
const GO_MAGIC = Buffer.from("ff20476f206275696c64696e663a", "hex");
const GO_MAPPED_MARKER = Buffer.from("\0[BLA-GO-MAPPED]\0", "latin1");
const HEX40 = /^[0-9a-f]{40}\/$/;
const DECOY_RUSTC_PATH = /^library\/core\/src\/enclave[a-z_]*\.rs/;

/** Offset where BLA's appended shield starts (the original binary is everything before it), or -1. */
export const trailerStart = (bytes: Buffer): number => bytes.indexOf(NATIVE_TRAILER);

export interface RustcPaths {
  /** Distinct commit hashes in `/rustc/<hash>/` paths. */
  distinct: number;
  /** File offsets of the 40 hash characters in paths that end in BLA's `library/core/src/enclave*.rs`. */
  decoyOffsets: number[];
}

export function rustcPaths(bytes: Buffer): RustcPaths {
  const seen = new Set<string>();
  const decoyOffsets: number[] = [];
  for (let at = bytes.indexOf(RUSTC); at >= 0; at = bytes.indexOf(RUSTC, at + 1)) {
    const start = at + RUSTC.length;
    const hash = bytes.toString("latin1", start, start + 41);
    if (!HEX40.test(hash)) continue;
    seen.add(hash);
    if (DECOY_RUSTC_PATH.test(bytes.toString("latin1", start + 41, start + 41 + 64))) decoyOffsets.push(start);
  }
  return { distinct: seen.size, decoyOffsets };
}

export interface GoBuildInfo {
  /** Start of the 32-byte header. */
  offset: number;
  /** Version plus module bytes the header claims (the version length alone when it is past the file). */
  claimed: number;
  /** End of BLA's mapped plant (header, length, marker), or -1 when the bytes after the header are not that plant. */
  plantEnd: number;
}

function uvarint(b: Buffer, at: number): { value: number; next: number } | undefined {
  let value = 0;
  for (let i = 0; i < 10; i++) {
    const byte = b[at + i];
    if (byte === undefined) return undefined;
    value += (byte & 0x7f) * 2 ** (7 * i);
    if (!(byte & 0x80)) return { value, next: at + i + 1 };
  }
  return undefined;
}

/** Go build-info headers with inline strings (flag bit 1) and what they claim. */
export function goBuildInfos(bytes: Buffer): GoBuildInfo[] {
  const out: GoBuildInfo[] = [];
  for (let at = bytes.indexOf(GO_MAGIC); at >= 0; at = bytes.indexOf(GO_MAGIC, at + 1)) {
    if (at + 32 > bytes.length || !((bytes[at + 15] ?? 0) & 2)) continue;
    const version = uvarint(bytes, at + 32);
    if (!version) continue;
    const found = bytes.subarray(version.next, at + 1024).indexOf(GO_MAPPED_MARKER);
    const marked = found >= 0;
    const plantEnd = marked ? version.next + found + GO_MAPPED_MARKER.length : -1;
    if (version.value > REA_MAX_GO_BUILDINFO || marked) {
      out.push({ offset: at, claimed: version.value, plantEnd });
      continue;
    }
    const module = uvarint(bytes, version.next + version.value);
    out.push({ offset: at, claimed: version.value + (module?.value ?? 0), plantEnd });
  }
  return out;
}

export const isGoFlood = (g: GoBuildInfo): boolean => g.claimed > REA_MAX_GO_BUILDINFO || g.plantEnd >= 0;
