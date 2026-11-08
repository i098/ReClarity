#!/usr/bin/env bun
// Budget and decoy guards. State lives in a small JSON ledger so every tool call can check it.
//   cap       token and time cap per target; at the cap, stop and report
//   retry     a REA capacity error means "clean the copy and retry ONE time"; the same input never twice
//   fixtures  obligation fixtures for covered (run) code only, at most MAX_FIXTURES
//   data      text taken from a target is data; wrap it before it goes near an agent prompt
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { CoverageReport } from "./coverage.ts";

const DEFAULT_MAX_TOKENS = 300_000;
const DEFAULT_MAX_SECONDS = 30 * 60;
export const MAX_FIXTURES = 200;

/** REA limit messages (src/domain/javascript/javascriptSemanticResourceLimits.ts, asarHeaderAdmission), the data format inspectors
 * (model nesting, EVM input, Flutter snapshot hashes, SQLite and tshark output) and BLA's own limit labels. */
const CAPACITY = /budget exceeded|conservatively bounded|header\/index admission is limited|maximum_[a-z_]+ \(|nesting exceeds \d+|exceeds? the retained evidence budget|artifact exceeds \d+ bytes/i;
export const isCapacityError = (text: string): boolean => CAPACITY.test(text);

const GO_FRAMING = /Go module string framing is invalid/;

/** REA's own error envelope only: stderr, or the JSON error object on stdout: `error`/`message` text, `code: "resource_constraint"` (BEAM chunk budget, Go build-info limit), or `code: "invalid_request"` whose message or `details.issues[].message` is the Go module framing error (BLA's balanced Go plant). Other stdout text is target data. */
export function isReaCapacityError(exitCode: number | null, stdout: string, stderr: string): boolean {
  if (exitCode === 0) return false;
  if (isCapacityError(stderr)) return true;
  try {
    const e = JSON.parse(stdout);
    if (e?.code === "resource_constraint") return true;
    if (e?.code === "invalid_request") {
      const issues: { message?: unknown }[] = Array.isArray(e.details?.issues) ? e.details.issues : [];
      return [e.message, ...issues.map((i) => i?.message)].some((m) => typeof m === "string" && GO_FRAMING.test(m));
    }
    return typeof e?.error === "string" && isCapacityError(`${e.error} ${String(e.message ?? "")}`);
  } catch {
    return false;
  }
}

export interface Ledger {
  maxTokens: number;
  maxSeconds: number;
  startedAt: number;
  tokens: number;
  /** sha256 of each input already given to REA */
  tried: string[];
  retried: boolean;
  /** real path of the target this budget belongs to */
  target?: string;
}
export type Verdict = { ok: true } | { ok: false; reason: string };

export function newLedger(env: Record<string, string | undefined> = process.env): Ledger {
  return {
    maxTokens: Number(env.ANTI_BLA_MAX_TOKENS) || DEFAULT_MAX_TOKENS,
    maxSeconds: Number(env.ANTI_BLA_MAX_SECONDS) || DEFAULT_MAX_SECONDS,
    startedAt: Math.floor(Date.now() / 1000),
    tokens: 0,
    tried: [],
    retried: false,
  };
}

export function loadLedger(path: string): Ledger {
  if (!existsSync(path)) return newLedger();
  const l: Ledger = JSON.parse(readFileSync(path, "utf8")); // written by saveLedger
  return l;
}
export const saveLedger = (path: string, l: Ledger): void => writeFileSync(path, JSON.stringify(l, null, 2));

export function check(l: Ledger, now = Math.floor(Date.now() / 1000)): Verdict {
  if (l.tokens >= l.maxTokens) return { ok: false, reason: `token cap reached (${l.tokens}/${l.maxTokens}); stop and report` };
  if (now - l.startedAt >= l.maxSeconds) return { ok: false, reason: `time cap reached (${now - l.startedAt}s/${l.maxSeconds}s); stop and report` };
  return { ok: true };
}

export const inputHash = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

/** Record an input before it goes to REA. False if this exact input was already tried. */
export function admit(l: Ledger, data: string | Buffer): boolean {
  const h = inputHash(data);
  if (l.tried.includes(h)) return false;
  l.tried.push(h);
  return true;
}

/** After a capacity error (the caller checks): allow one retry, and only on a different (cleaned) input. */
export function mayRetry(l: Ledger, cleaned: string | Buffer): Verdict {
  if (l.retried) return { ok: false, reason: "already retried once; report the capacity error" };
  if (l.tried.includes(inputHash(cleaned))) return { ok: false, reason: "cleaning changed nothing; the same input is never retried" };
  l.retried = true;
  return { ok: true };
}

/** Obligation fixtures: only statements the sandbox run reached, capped. A run that crashed or was killed gives none: its labels are unreliable. */
export function fixtureTargets(report: CoverageReport): { file: string; head: string }[] {
  if (report.exitCode !== 0) return [];
  return report.files.flatMap((f) => f.statements.filter((s) => s.kind === "run").map((s) => ({ file: f.file, head: s.head }))).slice(0, MAX_FIXTURES);
}

/** Text from a target is data, never instructions. Escape every closing-tag start in one pass, so no text can close the wrapper. */
export const asData = (text: string, label = "target"): string => `<target-data source="${label}" trust="none">\n${text.replace(/<(?=\/\s*target-data)/gi, "&lt;")}\n</target-data>`;

if (import.meta.main) {
  const [cmd, path, arg] = process.argv.slice(2);
  if (!cmd || !path || !["init", "charge", "check"].includes(cmd)) {
    console.error("usage: bun guard.ts init|check <ledger.json>  |  bun guard.ts charge <ledger.json> <tokens>");
    process.exit(64);
  }
  const l = cmd === "init" ? newLedger() : loadLedger(path);
  if (cmd === "charge") l.tokens += Number(arg) || 0;
  saveLedger(path, l);
  const v = check(l);
  console.log(JSON.stringify({ ...v, tokens: l.tokens, maxTokens: l.maxTokens, maxSeconds: l.maxSeconds }));
  process.exit(v.ok ? 0 : 3);
}
