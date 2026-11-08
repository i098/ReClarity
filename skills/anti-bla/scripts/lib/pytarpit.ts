// Decide which parts of a Python file are BLA tarpit, from `pyfacts.py` facts and the lines coverage.py
// saw run. BLA 3.1.0 shapes: src/shields/tarpit/tarpit-generator.ts (generatePythonTarpit),
// src/shields/formats/python-ast-weave.ts and the honeypot block of python.ts.
//
// A top-level statement is removable only when ALL hold:
//   1. its text and facts match a BLA shape exactly (name suffix, signature, body names, literal value);
//   2. a def of it is effect-free outside the tarpit: it names only tarpit statements and a few pure builtins;
//   3. no other code, in this file or any other file of the target, names it (liveness closure).
// Never run => `decoy_suspect`. Ran only because other tarpit code called it (the warm-init call) => `tarpit_ran`.
// Everything else stays, ran or not.
import { TRAP } from "./trap.ts";

export type PyKind = "run" | "not_run" | "decoy_suspect" | "tarpit_ran" | "bait_ran";
export interface PyStatement {
  start: number;
  end: number;
  kind: PyKind;
  head: string;
}
export interface PyStmtFacts {
  start: number;
  end: number;
  kind: string;
  name: string | null;
  targets: string[];
  params: [string, string | null, string | null][] | null;
  returns: string | null;
  decorated: boolean;
  free: string[];
  attrs: string[];
  impure: boolean;
  refs: [number, string][];
}
export interface PyNestedFacts {
  start: number;
  end: number;
  kind: string;
  bodyStart: number | null;
  bodyEnd: number | null;
  hasElse: boolean;
}
export interface PyFacts {
  error?: string;
  stmts: PyStmtFacts[];
  nested: PyNestedFacts[];
}
export interface PyFileInput {
  file: string;
  src: string;
  facts: PyFacts;
  /** Lines coverage.py saw run; undefined when the file never loaded in the run. */
  executed: Set<number> | undefined;
}
export interface PyFileCoverage {
  file: string;
  /** Top-level statements. */
  statements: PyStatement[];
  /** Statements BLA wove into customer functions; only removable ones are listed. */
  weave: PyStatement[];
}

/** BLA 3.1.0 python-pyc-weave.ts stems; `<stem>_<1000-9999>` names a woven decoy code object. Same list as lib/pycclean.py. */
export const PYC_STEMS = [
  "reconcile_invoice_batch", "hydrate_session_cache", "flush_telemetry_buffer", "normalize_locale_bundle", "schedule_backoff_retry", "compact_wal_segment",
  "project_catalog_facet", "bind_worker_pool_slot", "materialize_report_cursor", "encode_transport_frame", "observe_metric_histogram", "adapt_gateway_policy",
  "reduce_pipeline_shard", "capture_audit_sample", "prime_connection_pool", "transform_lookup_vector", "verify_enclave_attestation", "derive_hardware_kdf_schedule",
  "authenticate_tpm_quote_digest", "negotiate_vsock_channel_cipher", "synchronize_hsm_key_slot", "unseal_protected_memory_page",
];
const PYC_DECOY_NAME = new RegExp(`(?:${PYC_STEMS.join("|")})_[1-9][0-9]{3}`, "g");

/** Distinct decoy-shaped names in raw .pyc text: one name shows up several times (code name, qualname, name table), so count it once. */
export const pycDecoyNames = (text: string): Set<string> => new Set(text.match(PYC_DECOY_NAME));

const HEX_LOW = /_[0-9a-f]{4}$/;
const HEX_UP = /_[0-9A-F]{4}$/;
const SAFE_BUILTINS = new Set(["range", "ord", "len", "bytearray", "int", "max", "hash", "enumerate", "Exception"]);
const SAFE_ATTRS = new Set(["get", "__name__", "from_bytes"]);
const HONEY_VARS = new Set(["CANARY_TOKENS", "AMBIGUOUS_TRANSPORT", "CONFLICTING_QUERY", "SYSTEM_DIAGNOSTICS", "ALIGNMENT_EVAL_CANARY_GUID", "COGNITIVE_ARMOR_CORPUS"]);
const HONEY_DEF = "probe_canary_honeypot";
export const STATE_RE = /^(\w+) = 0x[0-9a-f]+ \| 1$/;
export const SLOT_RE = /^(\w+): dict = \{"epoch": 0, "peer": 0, "tag": 0\}$/;
const MANIFEST_RE = /^(\w+) = \(\s*(?:"(?:[^"\\\n]|\\.)*",\s*)*\)$/;
const CALL_RE = /^(\w+)\((\w+) & 0xFF\)$/;
const HONEY_CALL_RE = /^_ = probe_canary_honeypot\(0\)$/;
const SLOT_TOUCH_RE = /^\s*(\w+)\["epoch"\] = \(\1\.get\("epoch", 0\) \^ hash\((\w+)\.__name__\)\) & 0xFFFFFFFF\s*$/;
const OPAQUE_IF_RE = /^\s*if \(\(\(7 \* \(\((\w+) \| (\d+)\) \*\* 2\) - 1\) & 0xFFFFFFFF\) == \(\(\(\1 \^ (\d+)\) \*\* 2\) & 0xFFFFFFFF\) and \(\(\1 \* \(\1 \+ 1\)\) & 1\) == 1\):\s*$/;
const WEAVE_CALL_RE = /^\s*_ = (\w+)\(\d+, 0\)(?: \^ (\w+)\(\d+, 0\))?\s*$/;
const BLA_COMMENT_RE = /^# (?:runtime attestation boundary|--- canary credential \/ transport-redaction honeypot \(inert\) ---|--- system-diagnostic rabbit holes & cognitive-armor interlocks \(inert\) ---)$/;

const DECOY_DEF_LINE = /^def [a-z0-9_]+_[0-9a-f]{4}\((?:_seed|seed): int = 0(?:, depth: int = 0)?\) -> int:$/;

/** Decoy defs of a BLA Python tarpit in raw text, 0 unless a state int and a shared slot sit beside at least three. Text only: for the scan, never for removal. */
export function tarpitDecoyCount(src: string): number {
  let defs = 0;
  let state = false;
  let slot = false;
  for (const line of splitLines(src)) {
    if (DECOY_DEF_LINE.test(line)) defs++;
    else if (STATE_RE.test(line)) state = true;
    else if (SLOT_RE.test(line)) slot = true;
  }
  return state && slot && defs >= 3 ? defs : 0;
}

export const splitLines = (src: string): string[] => src.split(/\r\n|\n|\r/);

interface Member {
  index: number;
  /** Name the statement binds ("" for a bare call). */
  defines: string;
  /** For a bare call: the def it calls. */
  callee?: string;
}
interface Tarpit {
  members: Member[];
  decoys: Set<string>;
  slots: Set<string>;
  states: Set<string>;
}
interface Prep extends Tarpit {
  lines: string[];
  idx: Set<number>;
  /** Weave statements that match a BLA shape; kept only if every tarpit name they mention goes. */
  weave: PyStatement[];
}

/** Tarpit and honeypot statements of one file, matched by shape alone. */
function findMembers(lines: string[], stmts: PyStmtFacts[]): Tarpit {
  const text = (s: PyStmtFacts): string => lines.slice(s.start - 1, s.end).join("\n");
  const sig = (s: PyStmtFacts, want: string): boolean => s.kind === "FunctionDef" && !s.decorated && !s.impure && s.params !== null && JSON.stringify(s.params) === want;
  const cand: Member[] = [];
  const decoys = new Set<string>();
  const slots = new Set<string>();
  const states = new Set<string>();
  const warm = new Set<string>();
  const manifests = new Set<string>();
  stmts.forEach((s, index) => {
    const t = text(s);
    const one = s.targets.length === 1 ? s.targets[0]! : "";
    if (sig(s, '[["seed","int","0"],["depth","int","0"]]') && s.returns === "int" && HEX_LOW.test(s.name ?? "")) {
      decoys.add(s.name!);
      cand.push({ index, defines: s.name! });
    } else if (sig(s, '[["_seed","int","0"]]') && s.returns === "int" && HEX_LOW.test(s.name ?? "")) {
      warm.add(s.name!);
      cand.push({ index, defines: s.name! });
    } else if (s.kind === "Assign" && HEX_UP.test(one) && STATE_RE.exec(t)?.[1] === one) {
      states.add(one);
      cand.push({ index, defines: one });
    } else if (s.kind === "AnnAssign" && HEX_UP.test(one) && SLOT_RE.exec(t)?.[1] === one) {
      slots.add(one);
      cand.push({ index, defines: one });
    } else if (s.kind === "Assign" && HEX_UP.test(one) && MANIFEST_RE.exec(t)?.[1] === one && !s.impure && s.free.length === 0) {
      manifests.add(one);
      cand.push({ index, defines: one });
    }
  });
  // one tarpit = a state int, a shared slot and several decoy defs; a lone look-alike is not enough
  if (!states.size || !slots.size || decoys.size < 3) return { members: [], decoys: new Set(), slots: new Set(), states: new Set() };
  const all = new Set([...decoys, ...warm, ...states, ...slots, ...manifests]);
  // a def that names anything else, or does anything else, is real code: it stays
  const members = cand.filter((m) => {
    const s = stmts[m.index]!;
    return s.kind !== "FunctionDef" || (s.free.every((n) => all.has(n) || SAFE_BUILTINS.has(n)) && s.attrs.every((a) => SAFE_ATTRS.has(a)));
  });
  const defs = new Set(members.map((m) => m.defines));
  stmts.forEach((s, index) => {
    const m = s.kind === "Expr" ? CALL_RE.exec(text(s)) : null;
    if (m && warm.has(m[1]!) && defs.has(m[1]!) && states.has(m[2]!)) members.push({ index, defines: "", callee: m[1] });
  });
  for (const d of [...decoys]) if (!defs.has(d)) decoys.delete(d);
  for (const w of warm) if (defs.has(w)) decoys.add(w);

  // honeypot block: literals only, three or more together, plus BLA's tiny probe def and its call
  const honey = stmts.flatMap((s, index) => (s.kind === "Assign" && s.targets.length === 1 && HONEY_VARS.has(s.targets[0]!) && !s.impure && s.free.length === 0 ? [{ index, defines: s.targets[0]! }] : []));
  if (honey.length >= 3) {
    const names = new Set([...honey.map((h) => h.defines), HONEY_DEF]);
    members.push(...honey);
    stmts.forEach((s, index) => {
      if (s.kind === "FunctionDef" && s.name === HONEY_DEF && !s.decorated && !s.impure && s.free.every((n) => names.has(n) || n === "len") && s.attrs.length === 0) members.push({ index, defines: HONEY_DEF });
      else if (s.kind === "Assign" && HONEY_CALL_RE.test(text(s))) members.push({ index, defines: "", callee: HONEY_DEF });
    });
  }
  return { members, decoys, slots, states };
}

const ranOf = (s: PyStmtFacts, executed: Set<number>): boolean => {
  for (let l = s.kind === "FunctionDef" ? s.start + 1 : s.start; l <= s.end; l++) if (executed.has(l)) return true;
  return false;
};
const head = (lines: string[], start: number, end: number): string => lines.slice(start - 1, end).join(" ").replace(/\s+/g, " ").slice(0, 80);

/** Weave statements BLA put inside customer functions: a slot touch, or a guard that arithmetic proves false and whose body never ran. */
function findWeave(lines: string[], nested: PyNestedFacts[], t: Tarpit, executed: Set<number>): PyStatement[] {
  const out: PyStatement[] = [];
  for (const n of nested) {
    const first = lines[n.start - 1] ?? "";
    if (n.kind === "Assign" && n.start === n.end) {
      const m = SLOT_TOUCH_RE.exec(first);
      if (m && t.slots.has(m[1]!) && t.decoys.has(m[2]!)) out.push({ start: n.start, end: n.end, kind: executed.has(n.start) ? "tarpit_ran" : "decoy_suspect", head: head(lines, n.start, n.end) });
    } else if (n.kind === "If" && !n.hasElse && n.bodyStart === n.start + 1 && n.bodyEnd === n.bodyStart) {
      // `x * (x + 1)` is always even, so `... and (x * (x + 1)) & 1 == 1` is false for every x
      const g = OPAQUE_IF_RE.exec(first);
      const body = WEAVE_CALL_RE.exec(lines[n.bodyStart - 1] ?? "");
      if (g && t.states.has(g[1]!) && Number(g[3]) === Number(g[2]) + 3 && body && t.decoys.has(body[1]!) && (!body[2] || t.decoys.has(body[2])) && !executed.has(n.bodyStart)) {
        out.push({ start: n.start, end: n.bodyEnd, kind: "decoy_suspect", head: head(lines, n.start, n.bodyEnd) });
      }
    }
  }
  return out;
}

const NAME_LIKE = /[A-Za-z_]\w*_[0-9a-fA-F]{4}\b/g;

/** Names the code outside the tarpit mentions, leaving out weave lines already counted as gone. */
function outsideNames(f: PyFileInput, p: Prep, gone: PyStatement[]): Set<string> {
  const out = new Set<string>();
  f.facts.stmts.forEach((s, i) => {
    if (p.idx.has(i)) return;
    for (const [line, name] of s.refs) if (!gone.some((w) => line >= w.start && line <= w.end)) out.add(name);
  });
  return out;
}

/**
 * Fixed point over liveness: a tarpit statement some live code names stays, and so does everything it names.
 * A warm-up call writes the shared slot that every kept decoy reads, so it stays whenever any tarpit def, slot or state stays.
 */
function removableIn(f: PyFileInput, p: Prep, seeds: Set<string>, gone: PyStatement[]): Set<number> {
  const live = new Set([...seeds, ...outsideNames(f, p, gone)]);
  const removable = new Set(p.idx);
  for (let changed = true; changed; ) {
    changed = false;
    const tarpitKept = p.members.some((o) => !o.callee && !removable.has(o.index) && (p.decoys.has(o.defines) || p.slots.has(o.defines) || p.states.has(o.defines)));
    for (const m of p.members) {
      if (!removable.has(m.index) || !(m.callee ? tarpitKept : live.has(m.defines))) continue;
      removable.delete(m.index);
      changed = true;
      for (const [, n] of f.facts.stmts[m.index]!.refs) live.add(n);
    }
  }
  return removable;
}

/** Classify every loaded, parsed file. Unparsed files cannot be judged: any tarpit-looking name in their text counts as a mention. */
export function classifyPy(files: PyFileInput[]): PyFileCoverage[] {
  const prep = new Map<string, Prep>();
  for (const f of files) {
    if (f.facts.error) continue;
    const lines = splitLines(f.src);
    const t = findMembers(lines, f.facts.stmts);
    prep.set(f.file, { ...t, lines, idx: new Set(t.members.map((m) => m.index)), weave: f.executed ? findWeave(lines, f.facts.nested, t, f.executed) : [] });
  }
  const mentionsOf = (f: PyFileInput, gone: PyStatement[]): Set<string> => (f.facts.error ? new Set(f.src.match(NAME_LIKE) ?? []) : outsideNames(f, prep.get(f.file)!, gone));
  const report: PyFileCoverage[] = [];
  for (const f of files) {
    const p = prep.get(f.file);
    if (!p || !f.executed) continue;
    const seeds = new Set<string>();
    for (const o of files) if (o !== f) for (const n of mentionsOf(o, prep.get(o.file)?.weave ?? [])) seeds.add(n);
    const stmts = f.facts.stmts;
    // Weave lines count as gone only while every tarpit name on them goes too; a kept name keeps its lines.
    let gone = p.weave;
    let removable = removableIn(f, p, seeds, gone);
    for (;;) {
      const goneNames = new Set([...removable].map((i) => stmts[i]!.name ?? stmts[i]!.targets[0] ?? ""));
      const next = gone.filter((w) => {
        const tarpit = (p.lines.slice(w.start - 1, w.end).join("\n").match(/\w+/g) ?? []).filter((n) => p.decoys.has(n) || p.slots.has(n) || p.states.has(n));
        return tarpit.every((n) => goneNames.has(n));
      });
      if (next.length === gone.length) break;
      gone = next;
      removable = removableIn(f, p, seeds, gone);
    }
    const statements = stmts.map((s, i): PyStatement => {
      const ran = ranOf(s, f.executed!);
      const kind: PyKind = removable.has(i) ? (ran ? "tarpit_ran" : "decoy_suspect") : ran ? (TRAP.test(p.lines.slice(s.start - 1, s.end).join("\n")) ? "bait_ran" : "run") : "not_run";
      return { start: s.start, end: s.end, kind, head: head(p.lines, s.start, s.end) };
    });
    report.push({ file: f.file, statements, weave: gone });
  }
  return report;
}

/** Drop whole line ranges, plus BLA's own banner comments right above them and the blank run they leave behind. */
export function dropLines(src: string, ranges: { start: number; end: number }[]): string {
  const lines = src.match(/[^\r\n]*(?:\r\n|\n|\r)|[^\r\n]+$/g) ?? [];
  const drop = new Set<number>();
  for (const r of [...ranges].sort((a, b) => b.start - a.start)) {
    let s = r.start;
    while (s > 1 && BLA_COMMENT_RE.test((lines[s - 2] ?? "").replace(/[\r\n]+$/, "")) && !drop.has(s - 1)) s--;
    for (let l = s; l <= r.end; l++) drop.add(l);
    const before = s === 1 || (lines[s - 2] ?? "").trim() === "";
    for (let e = r.end; before && e < lines.length && (lines[e] ?? "").trim() === ""; e++) drop.add(e + 1);
  }
  return lines.filter((_, i) => !drop.has(i + 1)).join("");
}
