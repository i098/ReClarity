#!/usr/bin/env bun
// Read-only isolation of planted instructions. Walks a repository, finds comment and documentation spans that carry
// directive-shaped text addressed to an AI, or forged chat turns, and writes a VIEW COPY where each span is one marker
// (byte count + hash). Writes isolation.json. Never prints span text. Never executes repository code.
// Comments come from parsers: acorn's tokenizer (JS, TS), Python's own tokenize + ast (run on stdin, never executed),
// and a structural CommonMark scan for Markdown HTML comments (fences and code spans skipped).
// shortcut: acorn cannot lex all TS or JSX; such a file is copied unchanged and listed as "unparsed". Upgrade with a TS lexer.
import { Parser, tokenizer } from "acorn";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { asData } from "../../anti-bla/scripts/guard.ts";

export const PATTERNS_VERSION = 1;
export const MAX_SPANS = 50;
export const MAX_FRACTION = 0.05;
const MIN_BYTES_FOR_FRACTION = 10_000; // below this a single span is a large share of nothing
const MAX_FILE = 2 * 1024 * 1024;
const SKIP_DIRS = new Set([".git", "node_modules"]);
const JS_EXT = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"]);
const MD_EXT = new Set([".md", ".markdown"]);

export type Kind = "directive" | "forged-turn";
interface Span { start: number; end: number; open: string; close: string }
export interface Entry { file: string; line: number; bytes: number; sha256: string; kind: Kind }

// Not recognised is not clean: a paraphrase or another language stays in the view as data, to be wrapped with asData.
const AI = String.raw`(?:ai|a\.i\.|llm|assistant|language model|chatbot|chatgpt|claude|gpt-?\d*|copilot|gemini|ai (?:agent|model|assistant))`;
const DIRECTIVE = [
  new RegExp(String.raw`\b${AI}s?\s*[,:!]\s*\S`, "i"),
  new RegExp(String.raw`\b(?:dear|attention|note to|message for|hey|hello)\s+${AI}s?\b`, "i"),
  new RegExp(String.raw`\b(?:you are|you're|if you are|as)\s+an?\s+${AI}\b`, "i"),
  new RegExp(String.raw`\b${AI}s?\s+(?:reading|reviewing|analy[sz]ing|summari[sz]ing|scanning)\s+this\b`, "i"),
  /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|all|your)\b[^.\n]{0,40}\b(?:instructions?|prompts?|rules?|directions?)\b/i,
];
const FORGED_LINE = /^(?:human|assistant|system|developer)\s*:/i;
const FORGED_TOKEN = /<\|(?:im_start|im_end|system|user|assistant|endoftext)\|>|\[\/?INST\]|<\/?(?:system|human|assistant)>/i;

export function classify(text: string): Kind | undefined {
  if (FORGED_TOKEN.test(text) || text.split("\n").some((l) => FORGED_LINE.test(l.replace(/^[\s/*#<!>-]+/, "")))) return "forged-turn";
  return DIRECTIVE.some((r) => r.test(text)) ? "directive" : undefined;
}

const sha = (b: string | Buffer): string => createHash("sha256").update(b).digest("hex");

function jsSpans(src: string): Span[] | undefined {
  const spans: Span[] = [];
  const tokens: string[] = [];
  try {
    const opts = { ecmaVersion: "latest", sourceType: "module", allowHashBang: true, onComment: (_b: boolean, _t: string, s: number, e: number) => spans.push({ start: s, end: e, open: src.startsWith("/*", s) ? "/*" : src.startsWith("//", s) ? "//" : "#!", close: src.startsWith("/*", s) ? "*/" : "" }) } as const;
    for (const t of tokenizer(src, opts as never)) tokens.push(src.slice(t.start, t.end));
  } catch {
    return undefined;
  }
  (spans as Span[] & { tokens?: string[] }).tokens = tokens;
  return spans;
}

/** The view must lex to the same non-comment tokens as the original, or the file is not trusted to the lexer (TS regex/division guesses). */
function sameTokens(orig: string[], view: string): boolean {
  try {
    const v: string[] = [];
    for (const t of tokenizer(view, { ecmaVersion: "latest", sourceType: "module", allowHashBang: true } as never)) v.push(view.slice(t.start, t.end));
    return v.length === orig.length && v.every((x, i) => x === orig[i]);
  } catch {
    return false;
  }
}

function mdSpans(src: string): Span[] {
  const spans: Span[] = [];
  let fence: { ch: string; n: number } | null = null;
  let i = 0;
  while (i < src.length) {
    if (i === 0 || src[i - 1] === "\n") {
      const eol = src.indexOf("\n", i);
      const end = eol < 0 ? src.length : eol;
      const line = src.slice(i, end);
      const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (fence) {
        if (m && m[1]![0] === fence.ch && m[1]!.length >= fence.n && /^\s*$/.test(line.slice(m[0].length))) fence = null;
        i = end + 1;
        continue;
      }
      if (m) {
        fence = { ch: m[1]![0]!, n: m[1]!.length };
        i = end + 1;
        continue;
      }
    }
    const c = src[i];
    if (c === "\\") i += 2;
    else if (c === "`") {
      let n = 1;
      while (src[i + n] === "`") n++;
      const m = new RegExp("(?<!`)`{" + n + "}(?!`)", "g");
      m.lastIndex = i + n;
      const close = m.exec(src);
      i = close ? close.index + n : i + n;
    } else if (src.startsWith("<!--", i)) {
      const e = src.indexOf("-->", i + 4);
      const end = e < 0 ? src.length : e + 3;
      spans.push({ start: i, end, open: "<!--", close: "-->" });
      i = end;
    } else i++;
  }
  return spans;
}

// Runs Python's tokenizer and parser on stdin. The source is parsed, never executed. Positions: [kind, line, col, endLine, endCol] in UTF-16 units.
const PY = `
import sys, io, ast, json, tokenize
src = sys.stdin.buffer.read().decode("utf-8")
lines = src.split("\\n")
def u(l, c): return len(lines[l-1][:c].encode("utf-16-le")) // 2
def b(l, c): return len(lines[l-1].encode()[:c].decode())
out = []
try:
    for t in tokenize.generate_tokens(io.StringIO(src).readline):
        if t.type == tokenize.COMMENT:
            out.append(["comment", t.start[0], u(t.start[0], t.start[1]), t.end[0], u(t.end[0], t.end[1])])
except Exception:
    pass
try:
    for n in ast.walk(ast.parse(src)):
        if isinstance(n, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)) and n.body:
            s = n.body[0]
            if isinstance(s, ast.Expr) and isinstance(s.value, ast.Constant) and isinstance(s.value.value, str):
                out.append(["doc", s.lineno, u(s.lineno, b(s.lineno, s.col_offset)), s.end_lineno, u(s.end_lineno, b(s.end_lineno, s.end_col_offset))])
except Exception:
    pass
print(json.dumps(out))
`;

function pySpans(src: string): Span[] | undefined {
  const r = Bun.spawnSync(["python3", "-I", "-S", "-c", PY], { stdin: Buffer.from(src), stdout: "pipe", stderr: "ignore" });
  if (r.exitCode !== 0) return undefined;
  const starts = [0];
  for (let i = src.indexOf("\n"); i >= 0; i = src.indexOf("\n", i + 1)) starts.push(i + 1);
  const at = (l: number, c: number) => starts[l - 1]! + c;
  const rows = JSON.parse(r.stdout.toString()) as [string, number, number, number, number][];
  return rows.map(([k, l, c, el, ec]) => ({ start: at(l, c), end: at(el, ec), open: k === "doc" ? '"""' : "#", close: k === "doc" ? '"""' : "" }));
}

export const marker = (bytes: number, hash: string): string => `[reclarity: isolated span, ${bytes}B, sha ${hash.slice(0, 12)}]`;

interface FileResult { entries: Entry[]; view?: string; unparsed?: boolean }

/** Pure: one file's text in, its isolated spans and view text out. Line count of the view equals the original's. */
export function isolateText(file: string, text: string): FileResult {
  const ext = extname(file).toLowerCase();
  const raw = JS_EXT.has(ext) ? jsSpans(text) : ext === ".py" ? pySpans(text) : MD_EXT.has(ext) ? mdSpans(text) : [];
  if (!raw) return { entries: [], unparsed: true };
  const tokens = (raw as Span[] & { tokens?: string[] }).tokens;
  const hits = raw.filter((s) => classify(text.slice(s.start, s.end)) && s.end > s.start).sort((a, b) => a.start - b.start);
  if (!hits.length) return { entries: [] };
  let view = "";
  let pos = 0;
  const entries: Entry[] = [];
  for (const s of hits) {
    const span = text.slice(s.start, s.end);
    const h = sha(span);
    const pad = "\n".repeat(span.split("\n").length - 1);
    // Python docstrings and block comments keep their quote/comment syntax so the view still parses.
    const body = s.close ? `${s.open}${marker(Buffer.byteLength(span), h)}${pad}${s.close}` : `${s.open} ${marker(Buffer.byteLength(span), h)}`;
    view += text.slice(pos, s.start) + body;
    pos = s.end;
    entries.push({ file, line: text.slice(0, s.start).split("\n").length, bytes: Buffer.byteLength(span), sha256: h, kind: classify(span)! });
  }
  view += text.slice(pos);
  if (tokens && !sameTokens(tokens, view)) return { entries: [], unparsed: true };
  return { entries, view };
}

function treeHash(root: string): string {
  const h = createHash("sha256");
  const walk = (dir: string, rel: string) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = lstatSync(p);
      if (st.isSymbolicLink()) h.update(`${r}\0l\0${readlinkSync(p)}\n`);
      else if (st.isDirectory()) {
        h.update(`${r}\0d\n`);
        walk(p, r);
      } else h.update(`${r}\0f\0${sha(readFileSync(p))}\n`);
    }
  };
  walk(root, "");
  return h.digest("hex");
}

/** Nearest existing ancestor resolved through symlinks, so a not-yet-created output cannot hide inside the target. */
function realish(p: string): string {
  const a = resolve(p);
  return existsSync(a) ? realpathSync(a) : join(realish(dirname(a)), basename(a));
}

export interface Report { tool: string; patternsVersion: number; target: string; view: string; tree: { before: string; after: string }; spans: Entry[]; unparsed: string[]; skipped: string[] }

export class CapExceeded extends Error {}

export function isolate(target: string, out: string): Report {
  const t = realpathSync(target);
  const o = realish(out);
  if (o === t || o.startsWith(t + sep) || t.startsWith(o + sep)) throw new Error("refusing: output must be outside the target and not contain it");
  if (!lstatSync(t).isDirectory()) throw new Error("target must be a directory");
  if (existsSync(join(o, "view")) || existsSync(join(o, "isolation.json"))) throw new Error("refusing: output already holds a view or isolation.json");
  const before = treeHash(t);
  const plan: { rel: string; src: string; view?: string }[] = [];
  const spans: Entry[] = [];
  const unparsed: string[] = [];
  const skipped: string[] = [];
  let scanned = 0;
  let spanBytes = 0;
  const walk = (dir: string, rel: string) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = lstatSync(p);
      if (st.isSymbolicLink()) skipped.push(r);
      else if (st.isDirectory()) SKIP_DIRS.has(name) ? skipped.push(`${r}/`) : walk(p, r);
      else if (st.isFile()) {
        const known = JS_EXT.has(extname(name).toLowerCase()) || extname(name).toLowerCase() === ".py" || MD_EXT.has(extname(name).toLowerCase());
        const buf = known && st.size <= MAX_FILE ? readFileSync(p) : undefined;
        const text = buf && !buf.includes(0) ? buf.toString("utf8") : undefined;
        if (!buf || text === undefined || !Buffer.from(text).equals(buf)) {
          plan.push({ rel: r, src: p });
          continue;
        }
        scanned += buf.length;
        const res = isolateText(r, text);
        if (res.unparsed) unparsed.push(r);
        for (const e of res.entries) {
          spans.push(e);
          spanBytes += e.bytes;
        }
        plan.push({ rel: r, src: p, view: res.view });
      }
    }
  };
  walk(t, "");
  if (spans.length > MAX_SPANS || (scanned >= MIN_BYTES_FOR_FRACTION && spanBytes > scanned * MAX_FRACTION))
    throw new CapExceeded(`stopped: ${spans.length} spans, ${spanBytes} of ${scanned} scanned bytes exceed the cap. Masking this much may hide something. A human decides. Nothing was written.`);
  const view = join(o, "view");
  mkdirSync(view, { recursive: true });
  for (const f of plan) {
    const dst = join(view, f.rel);
    mkdirSync(dirname(dst), { recursive: true });
    if (f.view === undefined) copyFileSync(f.src, dst);
    else {
      writeFileSync(dst, f.view);
      chmodSync(dst, lstatSync(f.src).mode & 0o777);
    }
  }
  const after = treeHash(t);
  const report: Report = { tool: "untrusted-repo-read/isolate", patternsVersion: PATTERNS_VERSION, target: t, view, tree: { before, after }, spans, unparsed, skipped };
  writeFileSync(join(o, "isolation.json"), JSON.stringify(report, null, 2) + "\n");
  if (before !== after) throw new Error("the original tree changed during the run");
  return report;
}

if (import.meta.main) {
  const [target, out] = process.argv.slice(2);
  if (!target || !out) {
    console.error("usage: bun isolate.ts <repo-dir> <out-dir>   (writes <out-dir>/view and <out-dir>/isolation.json)");
    process.exit(64);
  }
  try {
    const r = isolate(target, out);
    // File names come from the target: wrap them. Span text is never in the report.
    const lines = r.spans.map((s) => `${JSON.stringify(s.file)} line ${s.line}, ${s.bytes}B, sha ${s.sha256.slice(0, 12)}, ${s.kind}`);
    console.log(asData(lines.join("\n") || "no spans", "isolate-report"));
    console.log(JSON.stringify({ spans: r.spans.length, unparsed: r.unparsed.length, skipped: r.skipped.length, treeUnchanged: r.tree.before === r.tree.after, treeSha256: r.tree.before, view: r.view }));
  } catch (e) {
    // Error text is fixed by this script (parser messages are never forwarded).
    console.error(e instanceof CapExceeded || (e instanceof Error && /^(refusing|target must|the original)/.test(e.message)) ? (e as Error).message : "isolate failed");
    process.exit(e instanceof CapExceeded ? 3 : 1);
  }
}
