#!/usr/bin/env bun
// Fold BLA's opaque seed predicates in a COPY of a JS build, then cut what only they kept alive.
// Pass 1 folds `if`/`?:`/expressions that give one answer for every seed value.
// Pass 2 removes top-level declarations no live code reaches (decoy clusters, keep-alive arrays).
// It never decides from names or text: only from folded predicates and reachability.
import { copyFileSync, cpSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { buildAsar, openAsar, type OpenAsar } from "./lib/asar.ts";
import { findSeeds, kids, opaqueValue, parseJs, type AnyNode, type Seed, type SeedFlag } from "./lib/js.ts";
import { pruneJs } from "./lib/prune.ts";

export interface FoldStats {
  predicatesFolded: number;
  branchesDropped: number;
  declarationsRemoved: number;
  sinkCallsRemoved: number;
  sourceMapStripped: boolean;
}
export interface FoldResult {
  code: string;
  stats: FoldStats;
}

const literal = (v: string | number | boolean): string => (typeof v === "string" ? JSON.stringify(v) : typeof v === "number" && v < 0 ? `(${v})` : String(v));

function foldPass(src: string, seeds: Seed[], stats: FoldStats): string {
  const ast = parseJs(src);
  const render = (n: AnyNode): string => {
    if (n.type === "IfStatement") {
      const t = opaqueValue(n.test, seeds);
      if (t) {
        stats.branchesDropped++;
        const live = t.value ? n.consequent : n.alternate;
        return live ? render(live) : ";";
      }
    } else if (["BinaryExpression", "LogicalExpression", "UnaryExpression", "ConditionalExpression", "CallExpression"].includes(n.type)) {
      const whole = opaqueValue(n as never, seeds);
      if (whole) {
        stats.predicatesFolded++;
        return literal(whole.value);
      }
      if (n.type === "ConditionalExpression") {
        const t = opaqueValue(n.test, seeds);
        if (t) {
          stats.branchesDropped++;
          return `(${render(t.value ? n.consequent : n.alternate)})`;
        }
      }
    }
    let out = "";
    let pos = n.start;
    for (const k of kids(n)) {
      if (k.start < pos) continue; // shorthand properties share one range
      out += src.slice(pos, k.start) + render(k);
      pos = k.end;
    }
    return out + src.slice(pos, n.end);
  };
  return src.slice(0, ast.start) + render(ast) + src.slice(ast.end);
}

export function foldJs(src: string, seedFlag: SeedFlag = 1): FoldResult {
  const stats: FoldStats = { predicatesFolded: 0, branchesDropped: 0, declarationsRemoved: 0, sinkCallsRemoved: 0, sourceMapStripped: false };
  const seeds = findSeeds(parseJs(src), seedFlag);
  if (!seeds.length) return { code: src, stats };
  let code = foldPass(src, seeds, stats);
  const pruned = pruneJs(code, findSeeds(parseJs(code), seedFlag));
  code = pruned.code;
  stats.declarationsRemoved = pruned.stats.declarationsRemoved;
  stats.sinkCallsRemoved = pruned.stats.sinkCallsRemoved;
  // the embedded map carries the original bait text and no longer matches the folded code
  const map = code.replace(/\n\/\/# sourceMappingURL=data:[^\n]*\s*$/, "\n");
  stats.sourceMapStripped = map !== code;
  code = map;
  parseJs(code); // never emit code that does not parse
  return { code, stats };
}

const isJs = (p: string) => [".js", ".cjs", ".mjs"].includes(extname(p));

export interface FoldReport {
  tool: "anti-bla/fold-js";
  files: { path: string; stats: FoldStats }[];
  /** Files left unfolded, with the reason. */
  notes: string[];
}

function tryFold(label: string, code: string, flag: SeedFlag, rep: FoldReport): FoldResult | undefined {
  try {
    return foldJs(code, flag);
  } catch (e) {
    rep.notes.push(`${label}: not folded, ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}

function foldTree(src: string, dst: string, flag: SeedFlag, rep: FoldReport): void {
  if (statSync(src).isDirectory()) {
    mkdirSync(dst, { recursive: true });
    for (const e of readdirSync(src)) {
      if (e === "node_modules") cpSync(join(src, e), join(dst, e), { recursive: true });
      else foldTree(join(src, e), join(dst, e), flag, rep);
    }
    return;
  }
  mkdirSync(dirname(dst), { recursive: true });
  if (extname(src) === ".asar") {
    let asar: OpenAsar | undefined;
    const folded: FoldReport["files"] = [];
    try {
      asar = openAsar(src);
      const entries = asar.files.map((f) => {
        const data = f.node.unpacked || f.node.link !== undefined ? undefined : asar!.read(f);
        if (!data || !isJs(f.path) || f.path.includes("node_modules/")) return { path: f.path, node: f.node, data };
        const r = tryFold(`${src}!${f.path}`, data.toString("utf8"), flag, rep);
        if (!r || (!r.stats.predicatesFolded && !r.stats.branchesDropped)) return { path: f.path, node: f.node, data };
        folded.push({ path: `${src}!${f.path}`, stats: r.stats });
        const { integrity: _stale, ...node } = f.node as typeof f.node & { integrity?: unknown };
        return { path: f.path, node, data: Buffer.from(r.code) };
      });
      writeFileSync(dst, buildAsar(entries));
      rep.files.push(...folded);
    } catch (e) {
      rep.notes.push(`${src}: archive not folded, ${e instanceof Error ? e.message : String(e)}`);
      copyFileSync(src, dst);
    } finally {
      asar?.close();
    }
  } else if (isJs(src)) {
    const text = readFileSync(src, "utf8");
    const r = tryFold(src, text, flag, rep);
    writeFileSync(dst, r?.code ?? text);
    if (r) rep.files.push({ path: src, stats: r.stats });
  } else copyFileSync(src, dst);
}

export function foldPath(src: string, dst: string, flag: SeedFlag = 1): FoldReport {
  const rep: FoldReport = { tool: "anti-bla/fold-js", files: [], notes: [] };
  foldTree(src, dst, flag, rep);
  return rep;
}

if (import.meta.main) {
  const [src, dst, flag = "1"] = process.argv.slice(2);
  if (!src || !dst) {
    console.error("usage: bun fold-js.ts <file|dir|app.asar> <out> [0|1|either]   (seed flag, default 1)");
    process.exit(64);
  }
  console.log(JSON.stringify(foldPath(src, dst, flag === "either" ? "either" : flag === "0" ? 0 : 1), null, 2));
}
