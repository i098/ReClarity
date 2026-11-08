#!/usr/bin/env bun
// Score a build 0-100 for BLA trap shapes before the first REA call. Score 0 = plain REA.
// Shapes are pinned to BLA 3.1.0 (references/signatures.md). Reads only; never runs target code.
import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { openAsar } from "./lib/asar.ts";
import { REA_MAX_SENTINELS, findSentinels, isNativeExecutable } from "./lib/fuses.ts";
import { countStrongMarkers } from "./lib/guard-markers.ts";
import { findSeeds, opaqueValue, parseJs, walk, type AnyNode, type Program } from "./lib/js.ts";

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
};
export const CONFIG_NAMES = [".blarc", ".blarc.json", "bla.config.json", ".bla-manifest.json"];
const BAIT = /ANALYSIS_VIEW_PROJECTION|business_logic_present=false|Evidence Ledger Note|ENCLAVE-ATTESTATION-GUARD|ABI-COMPAT-SHIM|HONEY-CRYPTO-MANIFEST/g;
const ENCLAVE = /enclave|attestation|tpm2_|nitroenclave|vsock|hardware-sealed/gi;
const DECOY_IPC = /delegatedToEnclave\s*:\s*true|fallbackStub\s*:\s*true/g;
const MAX_JS = 16 * 1024 * 1024;
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

function scanFile(path: string, size: number, acc: Acc): void {
  const name = basename(path);
  const ext = extname(name);
  if (CONFIG_NAMES.includes(name)) acc.add("config_file", path);
  else if (name === "package.json" && size < 1 << 20) {
    try {
      if ("bla" in JSON.parse(readFileSync(path, "utf8"))) acc.add("config_file", `${path} ("bla" key)`);
    } catch {}
  } else if (ext === ".asar") {
    try {
      scanAsar(path, acc);
    } catch (e) {
      acc.notes.push(`${path}: not scanned, ${e instanceof Error ? e.message : String(e)}`);
    }
  } else if ([".js", ".cjs", ".mjs"].includes(ext)) {
    if (size > MAX_JS) acc.notes.push(`${path}: over 16 MiB, skipped`);
    else scanJs(readFileSync(path, "utf8"), path, acc);
  } else if (size >= 1 << 20 && isNativeExecutable(path)) {
    // shortcut: reads the whole binary into memory; stream it if a 1 GB target ever shows up
    const s = findSentinels(readFileSync(path));
    const decoys = s.filter((x) => x.decoy).length;
    if (decoys) acc.add("fuse_decoy", `${path}: ${decoys} decoys of ${s.length} sentinels (REA limit ${REA_MAX_SENTINELS})`, decoys);
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
    console.error("usage: bun scan.ts <dir|file.asar|file.js|binary>");
    process.exit(64);
  }
  console.log(JSON.stringify(scan(target), null, 2));
}
