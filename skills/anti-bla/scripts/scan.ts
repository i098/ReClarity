#!/usr/bin/env bun
// Score a build 0-100 for BLA trap shapes before the first REA call. Score 0 = plain REA.
// Shapes are pinned to BLA 3.1.0 (references/signatures.md). Reads only; never runs target code.
import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { openAsar } from "./lib/asar.ts";
import { findApkDecoys, findDartDecoys } from "./lib/dart.ts";
import { cleanEvm, cleanEvmHex } from "./lib/evm.ts";
import { MAX_APK_FILE, MAX_EVM_FILE, MAX_PCAP_FILE, dataKind } from "./lib/formats.ts";
import { REA_MAX_SENTINELS, findSentinels, isNativeExecutable } from "./lib/fuses.ts";
import { countStrongMarkers } from "./lib/guard-markers.ts";
import { findModelDecoys } from "./lib/model.ts";
import { countShieldRecords } from "./lib/pcap.ts";
import { findHoney, isSqlite } from "./lib/sqlite.ts";
import { findSeeds, opaqueValue, parseJs, walk, type AnyNode, type Program } from "./lib/js.ts";
import { countBeamDecoys } from "./lib/beam.ts";
import { REA_MAX_GO_BUILDINFO, REA_MAX_RUSTC_HASHES, goBuildInfos, isGoFlood, rustcPaths, trailerStart } from "./lib/native.ts";
import { findWasmDecoys, parseSections } from "./lib/wasm.ts";
import { pycDecoyNames, tarpitDecoyCount } from "./lib/pytarpit.ts";

export const BLA_VERSION = "3.1.0";
export const REA_ASAR_DEFAULT_HEADER = 16 * 1024 * 1024;
export const FLOOD_MIN = 100;
/** BLA 3.1.0 flood entry: path of 200+ chars, body of 256 bytes or less. */
export const isFloodEntry = (f: { path: string; node: { size?: number } }): boolean => f.path.length >= 200 && (f.node.size ?? 0) <= 256;

export interface Finding {
  id: string;
  count: number;
  where: string[];
}
export interface ScanReport {
  tool: "anti-bla/scan";
  signaturesPinnedTo: string;
  target: string;
  score: number;
  level: "none" | "suspect" | "hardened";
  findings: Finding[];
  notes: string[];
}

// weight: points when the finding fires; min: count needed to fire
const RULES: Record<string, { weight: number; min: number }> = {
  config_file: { weight: 25, min: 1 },
  asar_header_flood: { weight: 40, min: 1 },
  fuse_decoy: { weight: 40, min: 1 },
  opaque_predicate: { weight: 25, min: 3 },
  ternary_chunks: { weight: 15, min: 1 },
  getter_ring: { weight: 10, min: 1 },
  selector_pyramid: { weight: 10, min: 1 },
  string_doubling: { weight: 10, min: 1 },
  keepalive_array: { weight: 10, min: 1 },
  decoy_ipc: { weight: 10, min: 1 },
  runtime_guard: { weight: 10, min: 1 },
  bait_text: { weight: 15, min: 1 },
  enclave_words: { weight: 5, min: 10 },
  sqlite_honey: { weight: 40, min: 1 },
  model_nesting_breaker: { weight: 40, min: 1 },
  pcap_flood: { weight: 40, min: 1 },
  evm_trailer: { weight: 40, min: 1 },
  dart_pool_decoy: { weight: 40, min: 1 },
  wasm_export_flood: { weight: 40, min: 1 },
  wasm_decoy_sections: { weight: 25, min: 1 },
  beam_chunk_flood: { weight: 40, min: 1 },
  native_shield_trailer: { weight: 40, min: 1 },
  rustc_hash_flood: { weight: 40, min: 1 },
  go_buildinfo_flood: { weight: 40, min: 1 },
  python_tarpit: { weight: 40, min: 1 },
  pyc_decoy_code: { weight: 40, min: 3 },
};
export const CONFIG_NAMES = [".blarc", ".blarc.json", "bla.config.json", ".bla-manifest.json"];
export const BAIT = /ANALYSIS_VIEW_PROJECTION|business_logic_present=false|Evidence Ledger Note|ENCLAVE-ATTESTATION-GUARD|ABI-COMPAT-SHIM|HONEY-CRYPTO-MANIFEST/g;
const ENCLAVE = /enclave|attestation|tpm2_|nitroenclave|vsock|hardware-sealed/gi;
const DECOY_IPC = /delegatedToEnclave\s*:\s*true|fallbackStub\s*:\s*true/g;
const PYINSTALLER_COOKIE = Buffer.from("MEI\x0c\x0b\x0a\x0b\x0e", "latin1");
const MAX_JS = 16 * 1024 * 1024;
export const MAX_BIN = 512 * 1024 * 1024;
const MAX_FILES = 2000;
const MAX_ASAR_JS = 300;
const SKIP_DIRS = ["node_modules", ".git"];

class Acc {
  map = new Map<string, Finding>();
  notes: string[] = [];
  add(id: string, where: string, n = 1): void {
    if (n <= 0) return;
    const f = this.map.get(id) ?? { id, count: 0, where: [] };
    f.count += n;
    if (f.where.length < 5 && !f.where.includes(where)) f.where.push(where);
    this.map.set(id, f);
  }
}

const flatten = (n: AnyNode, out: AnyNode[]): void => {
  if (n.type === "BinaryExpression" && n.operator === "+") {
    flatten(n.left as AnyNode, out);
    flatten(n.right, out);
  } else out.push(n);
};
const isStr = (n: AnyNode) => n.type === "Literal" && typeof n.value === "string";

/** First property read off `this` in a getter body, e.g. `return this.grow.more` -> "grow". */
function getterTarget(fn: AnyNode): string | undefined {
  if (fn.type !== "FunctionExpression") return undefined;
  const ret = fn.body.body[0];
  if (ret?.type !== "ReturnStatement" || !ret.argument) return undefined;
  let cur: AnyNode = ret.argument;
  let prop: string | undefined;
  while (cur.type === "MemberExpression") {
    prop = !cur.computed && cur.property.type === "Identifier" ? cur.property.name : undefined;
    cur = cur.object;
  }
  return cur.type === "ThisExpression" ? prop : undefined;
}

function scanRuns(body: AnyNode[], acc: Acc, label: string): void {
  let pyr = 0;
  let dbl = 0;
  let prev = "";
  for (const st of body) {
    if (st.type !== "VariableDeclaration") {
      pyr = dbl = 0;
      continue;
    }
    for (const d of st.declarations) {
      const init = d.init;
      const name = d.id.type === "Identifier" ? d.id.name : "";
      const chain = (e: AnyNode) => (e.type === "ChainExpression" && e.expression.type === "MemberExpression" && e.expression.object.type === "Identifier" ? e.expression.object.name : "");
      const isPyr = init?.type === "ConditionalExpression" && chain(init.consequent) !== "" && chain(init.consequent) === chain(init.alternate) && (pyr === 0 || chain(init.consequent) === prev);
      const isDbl = init?.type === "BinaryExpression" && init.operator === "+" && init.left.type === "Identifier" && init.right.type === "Identifier" && init.left.name === init.right.name && (dbl === 0 || init.left.name === prev);
      pyr = isPyr ? pyr + 1 : 0;
      dbl = isDbl ? dbl + 1 : 0;
      prev = name;
      if (pyr === 16) acc.add("selector_pyramid", label);
      if (dbl === 10) acc.add("string_doubling", label);
    }
  }
}

function scanJs(src: string, label: string, acc: Acc): void {
  acc.add("bait_text", label, src.match(BAIT)?.length ?? 0);
  acc.add("enclave_words", label, src.match(ENCLAVE)?.length ?? 0);
  acc.add("decoy_ipc", label, src.match(DECOY_IPC)?.length ?? 0);
  acc.add("runtime_guard", label, countStrongMarkers(src));
  let ast: Program;
  try {
    ast = parseJs(src);
  } catch {
    acc.notes.push(`${label}: not parseable as JS; only text signatures checked`);
    return;
  }
  const seeds = findSeeds(ast, 1);
  const inner = new Set<AnyNode>();
  walk(ast, (n) => {
    if (inner.has(n)) return;
    switch (n.type) {
      case "IfStatement":
      case "ConditionalExpression":
      case "WhileStatement":
        if (opaqueValue(n.test, seeds)) acc.add("opaque_predicate", label);
        break;
      case "BinaryExpression": {
        if (n.operator !== "+") break;
        const leaves: AnyNode[] = [];
        flatten(n, leaves);
        let cur: AnyNode = n;
        while (cur.type === "BinaryExpression" && cur.left !== leaves[0]) inner.add((cur = cur.left as AnyNode));
        const chunks = leaves.filter((l) => l.type === "ConditionalExpression" && isStr(l.consequent) && isStr(l.alternate));
        if (chunks.length >= 9) acc.add("ternary_chunks", label);
        break;
      }
      case "ClassBody":
      case "ObjectExpression": {
        const g = new Map<string, string>();
        for (const m of n.type === "ClassBody" ? n.body : n.properties) {
          if ((m.type === "MethodDefinition" || m.type === "Property") && m.kind === "get" && m.key.type === "Identifier") {
            const t = getterTarget(m.value);
            if (t) g.set(m.key.name, t);
          }
        }
        for (const start of g.keys()) {
          let at = start;
          for (let i = 0; i <= g.size && g.has(at); i++) {
            at = g.get(at)!;
            if (at === start) {
              acc.add("getter_ring", label);
              break;
            }
          }
        }
        break;
      }
      case "Program":
      case "BlockStatement":
        scanRuns(n.body, acc, label);
        break;
      case "ExpressionStatement":
        if (n.expression.type === "UnaryExpression" && n.expression.operator === "void" && n.expression.argument.type === "ArrayExpression" && n.expression.argument.elements.length >= 20 && n.expression.argument.elements.every((e) => e?.type === "Identifier")) acc.add("keepalive_array", label);
        break;
    }
  });
}

/** BLA's Python tarpit in a `.py` file, from text shapes alone. */
function scanPy(src: string, label: string, acc: Acc): void {
  acc.add("python_tarpit", label, tarpitDecoyCount(src));
  acc.add("bait_text", label, src.match(BAIT)?.length ?? 0);
  acc.add("enclave_words", label, src.match(ENCLAVE)?.length ?? 0);
}

/** BLA's decoy code objects and honey trailer in a `.pyc`: names sit in the marshal stream as plain bytes. */
function scanPyc(bytes: Buffer, label: string, acc: Acc): void {
  const text = bytes.toString("latin1");
  acc.add("pyc_decoy_code", label, pycDecoyNames(text).size);
  acc.add("bait_text", label, text.match(BAIT)?.length ?? 0);
}

function scanAsar(path: string, acc: Acc): void {
  const asar = openAsar(path);
  try {
    const flood = asar.files.filter(isFloodEntry);
    if (flood.length >= FLOOD_MIN) acc.add("asar_header_flood", `${path}: ${flood.length} long-path tiny entries`, flood.length);
    if (asar.headerBytes > REA_ASAR_DEFAULT_HEADER) acc.add("asar_header_flood", `${path}: header ${asar.headerBytes} B > 16 MiB`);
    let jsCount = 0;
    for (const f of asar.files) {
      if (f.path.length >= 200 || f.path.includes("node_modules/") || !/\.(c|m)?js$/.test(f.path) || (f.node.size ?? 0) > MAX_JS) continue;
      if (++jsCount > MAX_ASAR_JS) {
        acc.notes.push(`${path}: only the first ${MAX_ASAR_JS} JS entries scanned`);
        break;
      }
      scanJs(asar.read(f).toString("utf8"), `${path}!${f.path}`, acc);
    }
  } finally {
    asar.close();
  }
}

/** Data formats: SQLite, model files, PCAP, EVM bytecode, Flutter APK. Read-only; each cleaner checks magic and shape itself. */
function scanData(kind: NonNullable<ReturnType<typeof dataKind>>, path: string, size: number, acc: Acc): void {
  switch (kind) {
    case "sqlite": {
      if (!isSqlite(path)) return;
      const h = findHoney(path);
      acc.add("sqlite_honey", `${path}: ${h.tables.length} honey tables${h.view ? " and view" : ""}`, h.tables.length + (h.view ? 1 : 0));
      if (h.suspects.length) acc.notes.push(`${path}: tables with "enclave_" in the name kept (not BLA's shape): ${h.suspects.join(", ")}`);
      return;
    }
    case "model": {
      const d = findModelDecoys(path);
      if (d?.remove.length) acc.add("model_nesting_breaker", `${path}: ${d.format}, nesting ${d.depth} (REA limit 32), ${d.remove.length} entries`, d.remove.length);
      return;
    }
    case "pcap": {
      if (size > MAX_PCAP_FILE) return void acc.notes.push(`${path}: over 512 MiB, not scanned`);
      const n = countShieldRecords(readFileSync(path));
      acc.add("pcap_flood", `${path}: ${n} BLA records`, n);
      return;
    }
    case "evm": {
      if (size > MAX_EVM_FILE) return;
      const buf = readFileSync(path);
      const hex = cleanEvmHex(buf.toString("latin1"));
      const r = hex ?? cleanEvm(buf);
      if (r) acc.add("evm_trailer", `${path}: ${r.trailerBytes} B trailer, ${r.fillerBytes} B filler${hex ? " (hex)" : ""}`);
      return;
    }
    case "apk": {
      if (size > MAX_APK_FILE) return void acc.notes.push(`${path}: over 1 GiB, not scanned`);
      for (const f of findApkDecoys(readFileSync(path))) acc.add("dart_pool_decoy", `${path}!${f.lib}: ${f.decoys.length} Dart decoy blocks`, f.decoys.length);
    }
  }
}

function scanWasm(bytes: Buffer, path: string, acc: Acc): void {
  const sections = parseSections(bytes);
  if (!sections) return void acc.notes.push(`${path}: not a well-framed WASM module; not scanned`);
  const d = findWasmDecoys(sections);
  if (d.exports.length) acc.add("wasm_export_flood", `${path}: ${d.exports.length} alias exports of ${d.exportCount}`, d.exports.length);
  if (d.sections.size) acc.add("wasm_decoy_sections", `${path}: ${[...d.sections.values()].join(", ")}`, d.sections.size);
}

function scanBeam(bytes: Buffer, path: string, acc: Acc): void {
  const c = countBeamDecoys(bytes);
  if (!c) return void acc.notes.push(`${path}: not a well-framed BEAM form; not scanned`);
  if (c.decoyChunks || c.decoyAtoms) acc.add("beam_chunk_flood", `${path}: ${c.decoyChunks} decoy chunks of ${c.chunks}, ${c.decoyAtoms} canary atoms`, c.decoyChunks + c.decoyAtoms);
}

function scanNative(bytes: Buffer, path: string, acc: Acc): void {
  const s = findSentinels(bytes);
  const decoys = s.filter((x) => x.decoy).length;
  if (decoys) acc.add("fuse_decoy", `${path}: ${decoys} decoys of ${s.length} sentinels (REA limit ${REA_MAX_SENTINELS})`, decoys);
  const cut = trailerStart(bytes);
  if (cut >= 0) acc.add("native_shield_trailer", `${path}: ${bytes.length - cut} B appended at ${cut}`);
  const rust = rustcPaths(bytes);
  if (rust.distinct > REA_MAX_RUSTC_HASHES) acc.add("rustc_hash_flood", `${path}: ${rust.distinct} distinct rustc paths (REA limit ${REA_MAX_RUSTC_HASHES})`, rust.distinct);
  const dart = findDartDecoys(bytes);
  if (dart.length) acc.add("dart_pool_decoy", `${path}: ${dart.length} Dart decoy blocks`, dart.length);
  const go = goBuildInfos(bytes).filter(isGoFlood);
  if (go.length) acc.add("go_buildinfo_flood", go[0]!.plantEnd >= 0 ? `${path}: BLA Go plant marker after build info at ${go[0]!.offset}` : `${path}: Go build info claims ${go[0]!.claimed} B (REA limit ${REA_MAX_GO_BUILDINFO})`, go.length);
}

function scanFile(path: string, size: number, acc: Acc): void {
  const name = basename(path);
  const ext = extname(name);
  if (CONFIG_NAMES.includes(name)) acc.add("config_file", path);
  else if (name === "package.json" && size < 1 << 20) {
    try {
      if ("bla" in JSON.parse(readFileSync(path, "utf8"))) acc.add("config_file", `${path} ("bla" key)`);
    } catch {}
  } else if (size <= MAX_BIN && isNativeExecutable(path)) {
    // shortcut: reads the whole binary into memory; stream it if a target over 512 MiB ever matters
    const bin = readFileSync(path);
    if (bin.subarray(-65536).includes(PYINSTALLER_COOKIE)) acc.notes.push(`${path}: PyInstaller archive; its .pyc files are not read or cleaned. Clean the .py files before bundling, or extract it and run this on the .pyc files`);
    scanNative(bin, path, acc);
  } else if (dataKind(path)) {
    try {
      scanData(dataKind(path)!, path, size, acc);
    } catch (e) {
      acc.notes.push(`${path}: not scanned, ${e instanceof Error ? e.message : String(e)}`);
    }
  } else if (ext === ".asar") {
    try {
      scanAsar(path, acc);
    } catch (e) {
      acc.notes.push(`${path}: not scanned, ${e instanceof Error ? e.message : String(e)}`);
    }
  } else if ([".js", ".cjs", ".mjs"].includes(ext)) {
    if (size > MAX_JS) acc.notes.push(`${path}: over 16 MiB, skipped`);
    else scanJs(readFileSync(path, "utf8"), path, acc);
  } else if (ext === ".py") {
    if (size > MAX_JS) acc.notes.push(`${path}: over 16 MiB, skipped`);
    else scanPy(readFileSync(path, "latin1"), path, acc);
  } else if (ext === ".pyc") {
    if (size > MAX_JS) acc.notes.push(`${path}: over 16 MiB, skipped`);
    else scanPyc(readFileSync(path), path, acc);
  } else if (ext === ".wasm" || ext === ".beam") {
    if (size > MAX_BIN) acc.notes.push(`${path}: over 512 MiB, skipped`);
    else if (ext === ".wasm") scanWasm(readFileSync(path), path, acc);
    else scanBeam(readFileSync(path), path, acc);
  }
}

export function scan(target: string): ScanReport {
  const acc = new Acc();
  let seen = 0;
  const visit = (p: string): void => {
    if (seen >= MAX_FILES) return;
    const st = statSync(p);
    if (st.isDirectory()) {
      for (const e of readdirSync(p)) {
        if (SKIP_DIRS.includes(e)) continue;
        const child = join(p, e);
        if (lstatSync(child).isSymbolicLink()) acc.notes.push(`${child}: symlink skipped`);
        else visit(child);
      }
    } else if (st.isFile()) {
      seen++;
      scanFile(p, st.size, acc);
    }
  };
  visit(target);
  if (seen >= MAX_FILES) acc.notes.push(`stopped after ${MAX_FILES} files`);
  const findings = [...acc.map.values()].filter((f) => f.count >= (RULES[f.id]?.min ?? 1));
  const score = Math.min(100, findings.reduce((s, f) => s + (RULES[f.id]?.weight ?? 0), 0));
  return {
    tool: "anti-bla/scan",
    signaturesPinnedTo: BLA_VERSION,
    target,
    score,
    level: score === 0 ? "none" : score < 40 ? "suspect" : "hardened",
    findings,
    notes: [...acc.notes, ...(score ? [`signatures pinned to BLA ${BLA_VERSION}; a newer BLA may use shapes this scan misses`] : [])],
  };
}

if (import.meta.main) {
  const target = process.argv[2];
  if (!target) {
    console.error("usage: bun scan.ts <dir|file.asar|file.js|file.py|file.pyc|binary>");
    process.exit(64);
  }
  console.log(JSON.stringify(scan(target), null, 2));
}
