// Which data-format cleaner, if any, applies to a file. Shared by scan.ts and sanitize.ts so the two
// agree on what is looked at. Extension picks the cleaner; each cleaner then checks magic and shape.
import { closeSync, openSync, readSync } from "node:fs";
import { extname } from "node:path";

export type DataKind = "sqlite" | "model" | "pcap" | "evm" | "zip" | "dex" | "il2cpp";

const BY_EXT: Record<string, DataKind> = {
  ".sqlite": "sqlite",
  ".sqlite3": "sqlite",
  ".db": "sqlite",
  ".db3": "sqlite",
  ".safetensors": "model",
  ".gguf": "model",
  // BLA 3.1.0 writes classic libpcap only, whatever the name
  ".pcap": "pcap",
  ".evm": "evm",
  ".bin": "evm",
  ".hex": "evm",
  ".bytecode": "evm",
  // APK and ZIP: Flutter libapp.so, and the BLA 3.2.2 archive plants
  ".apk": "zip",
  ".zip": "zip",
  ".dex": "dex",
};

/** BLA picks archives, DEX and IL2CPP metadata by magic, whatever the name (`.jar`, `global-metadata.dat`). */
const MAGIC: [number, DataKind][] = [[0x504b0304, "zip"], [0x6465780a, "dex"], [0xaf1bb1fa, "il2cpp"]];

export function dataKind(path: string): DataKind | undefined {
  const byExt = BY_EXT[extname(path).toLowerCase()];
  if (byExt) return byExt;
  const m = Buffer.alloc(4);
  try {
    const fd = openSync(path, "r");
    try {
      if (readSync(fd, m, 0, 4, 0) < 4) return undefined;
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined; // unreadable: the caller's own read reports it
  }
  return MAGIC.find(([magic]) => magic === m.readUInt32BE(0))?.[1];
}

/** REA admits at most 4 MiB of EVM input, and a hex carrier is twice that. Bigger files are not carriers. */
export const MAX_EVM_FILE = 9 * 1024 * 1024;
/** An APK or ZIP is read whole to patch it. */
export const MAX_APK_FILE = 1024 * 1024 * 1024;
/** The Flutter library REA reads from an APK. */
export const FLUTTER_LIB = /^lib\/[^/]+\/libapp\.so$/;
/** Whole-file reads for PCAP stop here; a bigger capture is reported and left alone. */
export const MAX_PCAP_FILE = 512 * 1024 * 1024;
