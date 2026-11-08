// Minimal ASAR reader and writer (Chromium pickle header, JSON file tree).
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

export interface AsarNode {
  files?: Record<string, AsarNode>;
  size?: number;
  offset?: string;
  unpacked?: boolean;
  link?: string;
}
export interface AsarFile {
  path: string;
  node: AsarNode;
}
export interface Asar {
  /** Bytes of the JSON header; REA admits at most REA_ASAR_MAX_HEADER_BYTES (16 MiB default). */
  headerBytes: number;
  files: AsarFile[];
  read(file: AsarFile): Buffer;
}
export type OpenAsar = Asar & { close(): void };

function collect(dir: AsarNode, prefix: string, out: AsarFile[]): void {
  for (const [name, node] of Object.entries(dir.files ?? {})) {
    const path = prefix + name;
    if (node.files) collect(node, path + "/", out);
    else out.push({ path, node });
  }
}

export function openAsar(path: string): OpenAsar {
  const fd = openSync(path, "r");
  try {
    const head = Buffer.alloc(16);
    if (readSync(fd, head, 0, 16, 0) < 16 || head.readUInt32LE(0) !== 4) throw new Error(`not an ASAR archive: ${path}`);
    const base = 8 + head.readUInt32LE(4);
    const jsonLen = head.readUInt32LE(12);
    const fileSize = fstatSync(fd).size;
    if (16 + jsonLen > fileSize) throw new Error(`malformed ASAR header (claims ${jsonLen} B, file is smaller): ${path}`);
    const json = Buffer.alloc(jsonLen);
    if (readSync(fd, json, 0, jsonLen, 16) < jsonLen) throw new Error(`truncated ASAR header: ${path}`);
    const files: AsarFile[] = [];
    collect(JSON.parse(json.toString("utf8")) as AsarNode, "", files);
    return {
      headerBytes: jsonLen,
      files,
      read(f) {
        if (f.node.unpacked || f.node.size === undefined) return Buffer.alloc(0);
        const { size } = f.node;
        const at = base + Number(f.node.offset);
        if (!Number.isSafeInteger(size) || size < 0 || !(at >= base) || at + size > fileSize) throw new Error(`malformed ASAR entry (offset ${f.node.offset}, size ${size}): ${path}`);
        const buf = Buffer.alloc(size);
        if (readSync(fd, buf, 0, size, at) < size) throw new Error(`truncated ASAR entry: ${path}`);
        return buf;
      },
      close: () => closeSync(fd),
    };
  } catch (e) {
    closeSync(fd);
    throw e;
  }
}

/** Build an archive. Files with `data` are packed; others keep their node (unpacked or link). */
export function buildAsar(entries: { path: string; node: AsarNode; data?: Buffer }[]): Buffer {
  const root: AsarNode = { files: Object.create(null) };
  const chunks: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const parts = e.path.split("/");
    let dir = root;
    for (const p of parts.slice(0, -1)) dir = dir.files![p] ??= { files: Object.create(null) };
    const node: AsarNode = { ...e.node };
    if (e.data) {
      node.size = e.data.length;
      node.offset = String(offset);
      offset += e.data.length;
      chunks.push(e.data);
    }
    dir.files![parts.at(-1)!] = node;
  }
  const json = Buffer.from(JSON.stringify(root), "utf8");
  const aligned = (json.length + 3) & ~3;
  const head = Buffer.alloc(16 + aligned);
  head.writeUInt32LE(4, 0);
  head.writeUInt32LE(8 + aligned, 4);
  head.writeUInt32LE(4 + aligned, 8);
  head.writeUInt32LE(json.length, 12);
  json.copy(head, 16);
  return Buffer.concat([head, ...chunks]);
}
