#!/usr/bin/env bun
// Wrapper for one target: scan first, clean a copy when BLA shapes show, run REA under the caps.
// A REA capacity error gets ONE retry, and only on a differently cleaned copy. The original is never written.
//   bun run.ts <target> --work <dir> [--rea "rea ... {target}"] [--coverage]
import { lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { coverage, quarantineCopy } from "./coverage.ts";
import { foldPath } from "./fold-js.ts";
import { admit, asData, check, inputHash, isReaCapacityError, loadLedger, mayRetry, saveLedger, type Ledger } from "./guard.ts";
import { sanitize } from "./sanitize.ts";
import { scan, type ScanReport } from "./scan.ts";

export interface ReaAttempt {
  copy: string;
  exitCode: number | null;
  capacityError: boolean;
  /** Tail of REA output, wrapped as data. */
  output: string;
}
export interface RunReport {
  tool: "anti-bla/run";
  target: string;
  scan: ScanReport;
  attempts: ReaAttempt[];
  /** Path REA should read; equals the target when scan found nothing. */
  prepared: string;
  verdict: "plain-rea" | "cleaned" | "capped" | "capacity-error-after-retry" | "rea-failed" | "ok";
  reason?: string;
}

function hashNode(path: string): string {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) return inputHash(`link:${readlinkSync(path)}`);
  if (!st.isDirectory()) return inputHash(readFileSync(path));
  const rows = readdirSync(path).sort().map((e) => `${e}:${hashNode(join(path, e))}`);
  return inputHash(rows.join("\n"));
}

/** Hash of a file, or of a directory's names and contents. The named path is resolved; links below it hash their link text and are never followed. */
export const treeHash = (path: string): string => hashNode(realpathSync(path));

/** Sanitize, then fold, into work/<tag>. Returns the cleaned path. */
export function prepare(target: string, work: string, tag: string, withCoverage: boolean): string {
  const san = join(work, `${tag}-san`);
  sanitize(target, san);
  const isDir = statSync(target).isDirectory();
  const sanitized = isDir ? san : join(san, basename(target));
  const folded = join(work, `${tag}-clean`, isDir ? "" : basename(target));
  mkdirSync(join(work, `${tag}-clean`), { recursive: true });
  foldPath(sanitized, folded);
  if (!withCoverage) return folded;
  const quarantined = join(work, `${tag}-quarantine`);
  quarantineCopy(folded, coverage(folded), quarantined);
  return isDir ? quarantined : join(quarantined, basename(target));
}

function runRea(template: string, copy: string, ledger: Ledger): ReaAttempt {
  const left = Math.max(1, ledger.maxSeconds - (Math.floor(Date.now() / 1000) - ledger.startedAt));
  const cmd = template.replaceAll("{target}", `'${copy.replaceAll("'", "'\\''")}'`);
  const r = Bun.spawnSync(["sh", "-c", cmd], { timeout: left * 1000, killSignal: "SIGKILL", stdout: "pipe", stderr: "pipe" });
  const text = `${r.stdout.toString()}\n${r.stderr.toString()}`;
  return { copy, exitCode: r.exitCode ?? null, capacityError: isReaCapacityError(r.exitCode ?? null, r.stdout.toString(), r.stderr.toString()), output: asData(text.slice(-4000), "rea-output") };
}

export function run(target: string, opts: { work: string; rea?: string; coverage?: boolean }): RunReport {
  mkdirSync(opts.work, { recursive: true });
  const ledgerPath = join(opts.work, "ledger.json");
  const ledger = loadLedger(ledgerPath);
  const s = scan(target);
  const cleaned = s.score > 0;
  const prepared = cleaned ? prepare(target, opts.work, "a", !!opts.coverage) : target;
  const rep: RunReport = { tool: "anti-bla/run", target, scan: s, attempts: [], prepared, verdict: cleaned ? "cleaned" : "plain-rea" };
  if (opts.rea) {
    const first = check(ledger);
    if (!first.ok) return { ...rep, verdict: "capped", reason: first.reason };
    admit(ledger, treeHash(prepared));
    let a = runRea(opts.rea, prepared, ledger);
    rep.attempts.push(a);
    if (a.capacityError) {
      const second = prepare(target, opts.work, "b", !!opts.coverage);
      const secondHash = treeHash(second);
      if (ledger.tried.includes(inputHash(secondHash))) {
        rep.verdict = "rea-failed";
        rep.reason = `capacity error; cleaning changed nothing, so the same input is not retried${opts.coverage || target.endsWith(".asar") ? "" : ". Add --coverage to prune decoy suspects"}`;
      } else {
        const v = mayRetry(ledger, secondHash);
        if (v.ok && check(ledger).ok) {
          admit(ledger, secondHash);
          a = runRea(opts.rea, second, ledger);
          rep.attempts.push(a);
          rep.prepared = second;
          rep.verdict = a.capacityError ? "capacity-error-after-retry" : "ok";
        } else {
          rep.verdict = "capacity-error-after-retry";
          rep.reason = v.ok ? "time or token cap reached before the retry" : v.reason;
        }
      }
    } else rep.verdict = a.exitCode === 0 ? "ok" : "rea-failed";
  }
  saveLedger(ledgerPath, ledger);
  return rep;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
  const target = args[0];
  const work = opt("--work");
  if (!target || target.startsWith("--") || !work) {
    console.error('usage: bun run.ts <target> --work <dir> [--rea "rea ... {target}"] [--coverage]');
    process.exit(64);
  }
  console.log(JSON.stringify(run(target, { work, rea: opt("--rea"), coverage: args.includes("--coverage") }), null, 2));
}
