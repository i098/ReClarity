// Which data-format cleaner, if any, applies to a file. Shared by scan.ts and sanitize.ts so the two
// agree on what is looked at. Extension picks the cleaner; each cleaner then checks magic and shape.
import { extname } from "node:path";

export type DataKind = "sqlite" | "model" | "pcap" | "evm" | "apk";

const BY_EXT: Record<string, DataKind> = {
  ".sqlite": "sqlite",
  ".sqlite3": "sqlite",
  ".db": "sqlite",
  ".db3": "sqlite",
  ".safetensors": "model",
  ".gguf": "model",
  // BLA 3.1.0 writes classic libpcap only, whatever the name; pcapng is cleaned too, by magic
  ".pcap": "pcap",
  ".pcapng": "pcap",
  ".cap": "pcap",
  ".evm": "evm",
  ".bin": "evm",
  ".hex": "evm",
  ".bytecode": "evm",
  // Flutter apps: libapp.so inside the APK
  ".apk": "apk",
};

export const dataKind = (path: string): DataKind | undefined => BY_EXT[extname(path).toLowerCase()];

/** REA admits at most 4 MiB of EVM input, and a hex carrier is twice that. Bigger files are not carriers. */
export const MAX_EVM_FILE = 9 * 1024 * 1024;
/** An APK is read whole to patch its Flutter library. */
export const MAX_APK_FILE = 1024 * 1024 * 1024;
/** The Flutter library REA reads from an APK. */
export const FLUTTER_LIB = /^lib\/[^/]+\/libapp\.so$/;
/** Whole-file reads for PCAP stop here; a bigger capture is reported and left alone. */
export const MAX_PCAP_FILE = 512 * 1024 * 1024;
