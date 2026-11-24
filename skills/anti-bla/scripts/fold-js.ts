#!/usr/bin/env bun
// Fold BLA's opaque seed predicates in a COPY of a JS build, then cut what only they kept alive.
// Pass 1 folds `if`/`?:`/expressions that give one answer for every seed value.
// Pass 2 removes top-level declarations no live code reaches (decoy clusters, keep-alive arrays).
// It never decides from names or text: only from folded predicates and reachability.
import { copyFileSync, cpSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { buildAsar, openAsar, type OpenAsar } from "./lib/asar.ts";
import { findSeeds, kids, opaqueValue, parseJs, type AnyNode, type Seed, type SeedFlag } from "./lib/js.ts";
import { pruneJs } from "./lib/prune.ts";

export interface FoldStats {
  predicatesFolded: number;
  branchesDropped: number;
  declarationsRemoved: number;
  sinkCallsRemoved: number;
  /** BLA shadow-runtime statements cut: decorative init blocks and shadow-heap churn calls. */
  shadowRuntimeRemoved: number;
  sourceMapStripped: boolean;
}
export interface FoldResult {
  code: string;
  stats: FoldStats;
}

const literal = (v: string | number | boolean): string => (typeof v === "string" ? JSON.stringify(v) : typeof v === "number" && v < 0 ? `(${v})` : String(v));

/** A read of a seed that holds one fixed number (a BLA 3.5.x digest seed): the number itself. */
function seedRead(n: AnyNode, parent: AnyNode | undefined, fixed: Map<string, number>): string | undefined {
  if (n.type !== "Identifier" || !fixed.has(n.name) || !parent) return undefined;
  const name = parent.type === "VariableDeclarator" ? parent.id : parent.type === "MemberExpression" && !parent.computed ? parent.property : (parent.type === "Property" || parent.type === "PropertyDefinition" || parent.type === "MethodDefinition") && ("shorthand" in parent && parent.shorthand ? true : !parent.computed) ? parent.key : undefined;
  return name === n ? undefined : literal(fixed.get(n.name)!);
}

function foldPass(src: string, seeds: Seed[], stats: FoldStats): string {
  const ast = parseJs(src);
  const fixed = new Map(seeds.filter((s) => s.samples.length === 1).map((s) => [s.name, s.samples[0]!] as const));
  const render = (n: AnyNode, parent?: AnyNode): string => {
    const read = seedRead(n, parent, fixed);
    if (read !== undefined) {
      stats.predicatesFolded++;
      return read;
    }
    if (n.type === "IfStatement") {
      const t = opaqueValue(n.test, seeds);
      if (t) {
        stats.branchesDropped++;
        const live = t.value ? n.consequent : n.alternate;
        return live ? render(live, n) : ";";
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
          return `(${render(t.value ? n.consequent : n.alternate, n)})`;
        }
      }
    }
    let out = "";
    let pos = n.start;
    for (const k of kids(n)) {
      if (k.start < pos) continue; // shorthand properties share one range
      out += src.slice(pos, k.start) + render(k, n);
      pos = k.end;
    }
    return out + src.slice(pos, n.end);
  };
  return src.slice(0, ast.start) + render(ast) + src.slice(ast.end);
}

export function foldJs(src: string, seedFlag: SeedFlag = 1): FoldResult {
  const stats: FoldStats = { predicatesFolded: 0, branchesDropped: 0, declarationsRemoved: 0, sinkCallsRemoved: 0, shadowRuntimeRemoved: 0, sourceMapStripped: false };
  const seeds = findSeeds(parseJs(src), seedFlag);
  if (!seeds.length) return { code: src, stats };
  let code = foldPass(src, seeds, stats);
  const pruned = pruneJs(code, findSeeds(parseJs(code), seedFlag));
  code = pruned.code;
  stats.declarationsRemoved = pruned.stats.declarationsRemoved;
  stats.sinkCallsRemoved = pruned.stats.sinkCallsRemoved;
  stats.shadowRuntimeRemoved = pruned.stats.shadowRuntimeRemoved;
  // the embedded map carries the original bait text and no longer matches the folded code
  const map = code.replace(/\n\/\/# sourceMappingURL=data:[^\n]*\s*$/, "\n");
  stats.sourceMapStripped = map !== code;
  code = map;
  parseJs(code); // never emit code that does not parse
  return { code, stats };
}

const isJs = (p: string) => [".js", ".cjs", ".mjs"].includes(extname(p));
const changed = (s: FoldStats): boolean => s.predicatesFolded + s.branchesDropped + s.declarationsRemoved + s.sinkCallsRemoved + s.shadowRuntimeRemoved > 0 || s.sourceMapStripped;

export interface FoldReport {
  tool: "anti-bla/fold-js";
  files: { path: string; stats: FoldStats }[];
  /** Files left unfolded, with the reason. */
  notes: string[];
  /** Two or more JS files carry the self-seal check: they hash each other's bytes at run time (BLA 3.2.1 and 3.5.9 samples), so any fold makes the build throw. Nothing is folded. A single sealed file folds and still runs (3.2.2 sample). shortcut: counts check text, does not prove the files hash each other. */
  selfSealed: boolean;
}

const SEAL_MARKER = "integrity check failed";

/** JS files under `src` (a file, folder or ASAR) that carry BLA's self-seal check. */
function sealedFiles(src: string): number {
  if (lstatSync(src).isSymbolicLink()) return 0;
  if (statSync(src).isDirectory()) return readdirSync(src).reduce((n, e) => n + (e === "node_modules" ? 0 : sealedFiles(join(src, e))), 0);
  if (extname(src) === ".asar") {
    let asar: OpenAsar | undefined;
    try {
      asar = openAsar(src);
      return asar.files.filter((f) => !f.node.unpacked && f.node.link === undefined && isJs(f.path) && !f.path.includes("node_modules/") && asar!.read(f).includes(SEAL_MARKER)).length;
    } catch {
      return 0;
    } finally {
      asar?.close();
    }
  }
  return isJs(src) && readFileSync(src, "utf8").includes(SEAL_MARKER) ? 1 : 0;
}

function tryFold(label: string, code: string, flag: SeedFlag, rep: FoldReport): FoldResult | undefined {
  if (rep.selfSealed) return undefined;
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
      const p = join(src, e);
      if (e === "node_modules") {
        cpSync(p, join(dst, e), {
          recursive: true,
          filter: (s) => {
            const link = lstatSync(s).isSymbolicLink();
            if (link) rep.notes.push(`${s}: symlink skipped`);
            return !link;
          },
        });
      } else if (lstatSync(p).isSymbolicLink()) rep.notes.push(`${p}: symlink skipped`);
      else foldTree(p, join(dst, e), flag, rep);
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
        if (!r || !changed(r.stats)) return { path: f.path, node: f.node, data };
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
    if (r && changed(r.stats)) rep.files.push({ path: src, stats: r.stats });
  } else copyFileSync(src, dst);
}

export function foldPath(src: string, dst: string, flag: SeedFlag = 1): FoldReport {
  const rep: FoldReport = { tool: "anti-bla/fold-js", files: [], notes: [], selfSealed: sealedFiles(src) >= 2 };
  if (rep.selfSealed) rep.notes.push(`${src}: self-sealed build, not folded (the seal hashes the file bytes at run time)`);
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
