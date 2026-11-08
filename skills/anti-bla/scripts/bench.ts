#!/usr/bin/env bun
// Arms A / B / C on one app, same REA, same command:
//   A  REA on the plain app
//   B  REA on the BLA-hardened app
//   C  REA on the ReClarity-cleaned copy of the hardened app (clean time is added to wall time)
// Measures what a script can: REA exit and capacity error, wall time, evidence size in tokens,
// recall of known facts, trap words that reached the evidence. It does NOT run an agent, so
// agent tokens and hidden-test accuracy are not measured here.
//   bun bench.ts --plain a.asar --hardened b.asar --rea "node rea.mjs" --work dir --facts slugify,wordCount [--runs 3] [--out bench.json]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TRAP } from "./coverage.ts";
import { isCapacityError } from "./guard.ts";
import { prepare } from "./run.ts";

export interface Run {
  ms: number;
  exitCode: number | null;
  error?: string;
  capacityError: boolean;
  outputBytes: number;
  recall: number;
  trapHits: number;
  unknowns: number;
}
export interface Arm {
  arm: "A" | "B" | "C";
  path: string;
  cleanMs: number;
  tokens: number | null;
  runs: Run[];
}

const reaArgs = (rea: string, path: string, extra: string): string => `${rea} analyze-javascript-application '${path}' --format json ${extra}`;
const sh = (cmd: string) => Bun.spawnSync(["sh", "-c", cmd], { stdout: "pipe", stderr: "pipe", timeout: 15 * 60_000, killSignal: "SIGKILL" });

function once(rea: string, path: string, facts: string[]): Run {
  const t0 = performance.now();
  const r = sh(reaArgs(rea, path, ""));
  const ms = Math.round(performance.now() - t0);
  const text = r.stdout.toString();
  let error: string | undefined;
  let unknowns = 0;
  try {
    const e = JSON.parse(text);
    if (typeof e.error === "string") error = `${e.error}: ${String(e.message ?? "").slice(0, 200)}`;
    else unknowns = e.normalized_result?.semantic_graph?.unknowns?.length ?? 0;
  } catch {
    error = `not JSON: ${text.slice(0, 100)}`;
  }
  const hit = error ? 0 : facts.filter((f) => text.includes(f)).length;
  return {
    ms,
    exitCode: r.exitCode ?? null,
    error,
    capacityError: r.exitCode !== 0 && isCapacityError(r.stderr.toString()),
    outputBytes: text.length,
    recall: facts.length ? hit / facts.length : 0,
    trapHits: error ? 0 : (text.match(new RegExp(TRAP.source, "gi")) ?? []).length,
    unknowns,
  };
}

function tokenCount(rea: string, path: string): number | null {
  const n = Number(sh(reaArgs(rea, path, "--token-count")).stdout.toString().trim().split("\n").at(-1));
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function bench(o: { plain: string; hardened: string; rea: string; work: string; facts: string[]; runs: number }): Arm[] {
  mkdirSync(o.work, { recursive: true });
  const t0 = performance.now();
  const cleaned = prepare(o.hardened, join(o.work, "c"), "a", false);
  const cleanMs = Math.round(performance.now() - t0);
  const arms: [Arm["arm"], string, number][] = [["A", o.plain, 0], ["B", o.hardened, 0], ["C", cleaned, cleanMs]];
  return arms.map(([arm, path, ms]) => ({
    arm,
    path,
    cleanMs: ms,
    tokens: tokenCount(o.rea, path),
    runs: Array.from({ length: o.runs }, () => once(o.rea, path, o.facts)),
  }));
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
  const plain = opt("--plain");
  const hardened = opt("--hardened");
  const rea = opt("--rea");
  const work = opt("--work");
  const facts = opt("--facts")?.split(",");
  if (!plain || !hardened || !rea || !work || !facts) {
    console.error('usage: bun bench.ts --plain a.asar --hardened b.asar --rea "node rea.mjs" --work dir --facts f1,f2 [--runs 3] [--out bench.json]');
    process.exit(64);
  }
  const arms = bench({ plain, hardened, rea, work, facts, runs: Number(opt("--runs") ?? 3) });
  const json = JSON.stringify({ tool: "anti-bla/bench", arms }, null, 2);
  if (opt("--out")) writeFileSync(opt("--out")!, json);
  console.log(json);
}
