#!/usr/bin/env bun
// Find BLA runtime guards: code that changes what a build does when an inspector (CDP, Frida, node --inspect)
// is attached. Runs each entry in the bwrap sandbox, first with nothing attached (twice, to learn what varies
// between identical runs), then once per probe that sets the signal an attached tool leaves. It compares
// stdout, stderr, exit status, files written, calls into a stand-in `electron` module (IPC), child processes,
// network connects, globals the target added, and V8 coverage. What differs is the guarded code. The
// "not attached" run is the trusted observation: use it instead of attaching a debugger.
//   bun runtime-guard.ts <dir|file.js|app.asar> [--entry rel]... [--probes inspect,cdp,...] [--timeout sec]
// A probe is not a real debugger: it sets what BLA 3.1.0 reads (runtime-shield.ts, self-seal.ts,
// cdp-shape-budget-breaker.ts, frida-capture-saturation.ts). Target code runs only inside bwrap.
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { SANDBOX_DIR, hasSandbox, jsFiles, loadCounts, mainOf, sandboxBase } from "./coverage.ts";
import { asData } from "./guard.ts";
import { openAsar } from "./lib/asar.ts";
import { findMarkers } from "./lib/guard-markers.ts";
import { isFloodEntry } from "./scan.ts";

export type Probe = "inspect" | "node-options" | "remote-debugging" | "cdp" | "frida";
export const PROBES: readonly Probe[] = ["inspect", "node-options", "remote-debugging", "cdp", "frida"];
/** `output-diverges`: I/O, files, IPC, children or exit status change. `state-only`: only globals the target set change. `code-paths-only`: other code runs, nothing visible changes. */
export type Verdict = "output-diverges" | "state-only" | "code-paths-only" | "no-divergence" | "probe-failed";

export interface Marker {
  file: string;
  /** 1-based lines, at most 10. */
  lines: number[];
  id: string;
  strong: boolean;
  signal: string;
}
export interface Divergence {
  /** `stdout`, `stderr`, `exit`, `file:<path>`, `<kind>:<name>` (electron, handler, spawn, net) or `global:<name>`. */
  channel: string;
  /** Target text, wrapped as data. */
  baseline: string;
  probed: string;
}
export interface CodePath {
  file: string;
  line: number;
  col: number;
  /** Which run executed this code: the one with nothing attached, or the probed one. */
  ranOnlyIn: "baseline" | "probed";
  /** First 100 characters, target text. */
  text: string;
}
export interface ProbeResult {
  probe: Probe;
  verdict: Verdict;
  divergences: Divergence[];
  codePaths: CodePath[];
  codePathsOmitted: number;
}
export interface EntryReport {
  entry: string;
  /** The run with nothing attached. */
  baseline: { exitCode: number | null; timedOut: boolean; stdout: string; stderr: string; files: { path: string; sha256: string }[]; events: string[]; globals: Record<string, string> };
  /** Channels that differed between the two baseline runs; left out of every probe result. */
  varies: string[];
  probes: ProbeResult[];
}
export interface GuardReport {
  tool: "anti-bla/runtime-guard";
  target: string;
  markers: Marker[];
  entries: EntryReport[];
  /** True when some probe changed an output channel (not only which code ran). */
  diverged: boolean;
  notes: string[];
}

interface Event {
  kind: string;
  name: string;
  args: string[];
}
interface Observation {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  files: Map<string, string>;
  events: Event[];
  hits: Map<string, Uint8Array>;
}

const PRELOAD = join(import.meta.dir, "lib", "guard-preload.cjs");
const MAX_OUT = 4 << 20;
const MAX_FILES = 2000;
const MAX_PATHS = 40;
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}...(${s.length - n} more)` : s);
/** Both texts, cut to the same window that opens just before their first difference. */
function around(a: string, b: string): [string, string] {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  const from = Math.max(0, i - 60);
  const cut = (s: string): string => `${from ? "..." : ""}${clip(s.slice(from), 300)}`;
  return [cut(a), cut(b)];
}
// Node's own inspector chatter appears only on a probed run: not a behavior of the target.
const INSPECTOR_NOISE = /^(Debugger (listening on|attached|ending)|For help, see:|Waiting for the debugger to disconnect)/;
const dropInspectorNoise = (s: string): string => s.split("\n").filter((l) => !INSPECTOR_NOISE.test(l)).join("\n");

function readEvents(path: string): Event[] {
  let text = "";
  try {
    if (lstatSync(path).isFile()) text = readFileSync(path, "utf8").slice(0, MAX_OUT);
  } catch {
    return [];
  }
  return text.split("\n").flatMap((line): Event[] => {
    if (!line) return [];
    try {
      const e: Partial<Event> = JSON.parse(line);
      return typeof e.kind === "string" && typeof e.name === "string" && Array.isArray(e.args) ? [{ kind: e.kind, name: e.name, args: e.args.map(String) }] : [];
    } catch {
      return []; // a line the target wrote itself
    }
  });
}

/** Hash every regular file under `root`; links the target made are never followed. */
function hashTree(root: string, rel = "", out = new Map<string, string>()): Map<string, string> {
  for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
    const p = join(rel, e.name);
    if (out.size >= MAX_FILES) break;
    if (e.isDirectory()) hashTree(root, p, out);
    else if (e.isFile()) out.set(p, createHash("sha256").update(readFileSync(join(root, p))).digest("hex"));
  }
  return out;
}

function runOnce(root: string, entry: string, probe: Probe | undefined, timeoutSec: number, sizes: Map<string, number>): Observation {
  const tmp = mkdtempSync(join(tmpdir(), "antibla-guard-"));
  const [work, cov, obs] = ["w", "cov", "obs"].map((d) => join(tmp, d)) as [string, string, string];
  for (const d of [work, cov, obs]) mkdirSync(d);
  try {
    const { node, args } = sandboxBase();
    args.push("--proc", "/proc", "--dev", "/dev", "--bind", work, "/tmp", "--ro-bind", root, SANDBOX_DIR, "--bind", cov, "/cov", "--bind", obs, "/obs", "--ro-bind", PRELOAD, "/guard-preload.cjs");
    args.push("--setenv", "PATH", `${dirname(node)}:/usr/bin:/bin`, "--setenv", "HOME", "/tmp", "--setenv", "NODE_V8_COVERAGE", "/cov", "--setenv", "GUARD_OBS", "/obs/events.jsonl");
    if (probe) args.push("--setenv", "GUARD_PROBES", probe);
    if (probe === "node-options") args.push("--setenv", "NODE_OPTIONS", "--inspect=127.0.0.1:0");
    args.push("--chdir", "/tmp", node, ...(probe === "inspect" ? ["--inspect=127.0.0.1:0"] : []), "--max-old-space-size=512", "--require", "/guard-preload.cjs", `${SANDBOX_DIR}/${entry}`);
    const r = Bun.spawnSync(["bwrap", ...args], { timeout: timeoutSec * 1000, killSignal: "SIGKILL", env: { PATH: process.env.PATH ?? "/usr/bin" }, stdout: "pipe", stderr: "pipe", maxBuffer: MAX_OUT });
    return {
      exitCode: r.exitCode ?? null,
      timedOut: r.signalCode === "SIGKILL" || r.exitedDueToTimeout === true,
      stdout: r.stdout.toString(),
      stderr: dropInspectorNoise(r.stderr.toString()),
      files: hashTree(work),
      events: readEvents(join(obs, "events.jsonl")),
      hits: loadCounts(cov, sizes),
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Output channels of one run as `channel -> text`. Events group by kind and name, keeping call order. */
function channels(o: Observation): Map<string, string> {
  const m = new Map<string, string>([
    ["stdout", o.stdout],
    ["stderr", o.stderr],
    ["exit", `${o.exitCode}${o.timedOut ? " (timed out)" : ""}`],
  ]);
  for (const [p, h] of o.files) m.set(`file:${p}`, h);
  for (const e of o.events) {
    const k = e.kind === "global" ? `global:${e.name}` : `${e.kind}:${e.name}`;
    m.set(k, `${m.get(k) ?? ""}${e.args.join(" | ")}\n`);
  }
  return m;
}

function diffChannels(a: Map<string, string>, b: Map<string, string>): Map<string, [string, string]> {
  const out = new Map<string, [string, string]>();
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(k) ?? "(absent)";
    const y = b.get(k) ?? "(absent)";
    if (x !== y) out.set(k, [x, y]);
  }
  return out;
}

/** Runs of bytes where the probed run and the baseline disagree, minus bytes that vary between baseline runs. */
function diffCode(root: string, base: Observation, noise: Observation, probed: Observation): { paths: CodePath[]; omitted: number } {
  const paths: CodePath[] = [];
  let omitted = 0;
  for (const file of new Set([...base.hits.keys(), ...probed.hits.keys()])) {
    const src = readFileSync(join(root, file), "utf8");
    const a = base.hits.get(file);
    const b = probed.hits.get(file);
    const n = noise.hits.get(file);
    const at = (h: Uint8Array | undefined, i: number): number => h?.[i] ?? 0;
    let start = -1;
    let side: CodePath["ranOnlyIn"] = "baseline";
    const flush = (end: number): void => {
      if (start < 0) return;
      const text = src.slice(start, end).replace(/\s+/g, " ").trim();
      if (text) {
        if (paths.length >= MAX_PATHS) omitted++;
        else {
          const before = src.slice(0, start).split("\n");
          paths.push({ file, line: before.length, col: (before.at(-1)?.length ?? 0) + 1, ranOnlyIn: side, text: asData(clip(text, 100), "code-path") });
        }
      }
      start = -1;
    };
    for (let i = 0; i < src.length; i++) {
      const x = at(a, i);
      const y = at(b, i);
      const differs = x !== y && x === at(n, i);
      const s: CodePath["ranOnlyIn"] = x ? "baseline" : "probed";
      if (start >= 0 && (!differs || s !== side)) flush(i);
      if (differs && start < 0) {
        start = i;
        side = s;
      }
    }
    flush(src.length);
  }
  return { paths, omitted };
}

function extractAsar(path: string, out: string): void {
  const asar = openAsar(path);
  try {
    for (const f of asar.files) {
      const dest = resolve(out, f.path);
      if (isFloodEntry(f) || f.node.link || f.node.unpacked || !dest.startsWith(resolve(out) + sep)) continue;
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, asar.read(f));
    }
  } finally {
    asar.close();
  }
}

function findGuardMarkers(root: string, files: string[]): Marker[] {
  const out: Marker[] = [];
  for (const file of files) {
    if (statSync(join(root, file)).size > 16 << 20) continue;
    const byId = new Map<string, Marker>();
    for (const { marker, line } of findMarkers(readFileSync(join(root, file), "utf8"))) {
      const m = byId.get(marker.id) ?? { file, lines: [], id: marker.id, strong: marker.strong, signal: marker.signal };
      if (m.lines.length < 10) m.lines.push(line);
      byId.set(marker.id, m);
    }
    out.push(...byId.values());
  }
  return out.slice(0, 200);
}

export interface GuardOptions {
  entries?: string[];
  probes?: readonly Probe[];
  timeoutSec?: number;
}

export function runtimeGuard(target: string, opts: GuardOptions = {}): GuardReport {
  if (!hasSandbox()) throw new Error("refusing to run target code: bwrap not found (sandbox required, this host only)");
  const real = realpathSync(target);
  const notes: string[] = [];
  let extracted: string | undefined;
  try {
    let root = real;
    let main: string | undefined;
    if (real.endsWith(".asar")) {
      root = extracted = mkdtempSync(join(tmpdir(), "antibla-guard-asar-"));
      extractAsar(real, root);
      notes.push("ASAR extracted to a temp dir to run it under node; flood entries, links and unpacked files were not extracted");
    } else if (!statSync(real).isDirectory()) {
      root = dirname(real);
      main = basename(real);
    }
    const files = jsFiles(root);
    const sizes = new Map(files.map((f) => [f, statSync(join(root, f)).size]));
    const entries = opts.entries?.length ? opts.entries : [main ?? mainOf(root)];
    const probes = opts.probes ?? PROBES;
    const timeout = opts.timeoutSec ?? 30;
    const markers = findGuardMarkers(root, files);
    const reports: EntryReport[] = [];
    for (const entry of entries) {
      if (!sizes.has(entry)) {
        notes.push(`${entry}: not a JS file under the target; skipped`);
        continue;
      }
      const base = runOnce(root, entry, undefined, timeout, sizes);
      const again = runOnce(root, entry, undefined, timeout, sizes);
      const baseCh = channels(base);
      const varies = [...diffChannels(baseCh, channels(again)).keys()];
      if (base.exitCode !== 0 || base.timedOut) notes.push(`${entry}: baseline ${base.timedOut ? "hit the time limit" : `exited with ${base.exitCode ?? "a signal"}`}; a guard past that point is not reached`);
      const results = probes.map((probe): ProbeResult => {
        const p = runOnce(root, entry, probe, timeout, sizes);
        const divergences = [...diffChannels(baseCh, channels(p))].filter(([k]) => !varies.includes(k)).map(([channel, [b, x]]): Divergence => {
          const [from, to] = around(b, x);
          return { channel, baseline: asData(from, "divergence"), probed: asData(to, "divergence") };
        });
        const code = diffCode(root, base, again, p);
        // The inspector could not start (port, sandbox): every difference would be blamed on the guard.
        const failed = (probe === "inspect" || probe === "node-options") && /Starting inspector .* failed|EADDRINUSE/.test(p.stderr);
        const visible = divergences.some((d) => !d.channel.startsWith("global:"));
        const verdict: Verdict = failed ? "probe-failed" : visible ? "output-diverges" : divergences.length ? "state-only" : code.paths.length ? "code-paths-only" : "no-divergence";
        return { probe, verdict, divergences: failed ? [] : divergences, codePaths: failed ? [] : code.paths, codePathsOmitted: code.omitted };
      });
      const trusted = base.events.filter((e) => e.kind !== "global").map((e) => `${e.kind} ${e.name}(${e.args.join(", ")})`);
      reports.push({
        entry,
        baseline: {
          exitCode: base.exitCode,
          timedOut: base.timedOut,
          stdout: asData(clip(base.stdout, 2000), "baseline-stdout"),
          stderr: asData(clip(base.stderr, 1000), "baseline-stderr"),
          files: [...base.files].map(([path, sha256]) => ({ path, sha256 })),
          events: trusted.slice(0, 100).map((e) => asData(clip(e, 300), "baseline-event")),
          globals: Object.fromEntries(base.events.filter((e) => e.kind === "global").map((e) => [e.name, asData(clip(e.args.join(" | "), 300), "baseline-global")])),
        },
        varies,
        probes: results,
      });
    }
    if (!markers.some((m) => m.strong) && reports.every((r) => r.probes.every((p) => p.verdict === "no-divergence"))) notes.push("no BLA guard marker and no divergence under any probe");
    if (markers.length === 0 && reports.some((r) => r.probes.some((p) => p.verdict !== "no-divergence"))) notes.push("a divergence with no marker may be the target's own debugger check or noise the two baseline runs did not show");
    return { tool: "anti-bla/runtime-guard", target, markers, entries: reports, diverged: reports.some((r) => r.probes.some((p) => p.verdict === "output-diverges")), notes };
  } finally {
    if (extracted) rmSync(extracted, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const all = (name: string): string[] => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]!] : []));
  const target = args[0];
  const wanted = all("--probes").flatMap((s) => s.split(","));
  const bad = wanted.find((p) => !PROBES.includes(p as Probe));
  if (!target || target.startsWith("--") || bad) {
    console.error(`usage: bun runtime-guard.ts <dir|file.js|app.asar> [--entry rel]... [--probes ${PROBES.join(",")}] [--timeout sec]${bad ? `\nunknown probe: ${bad}` : ""}`);
    process.exit(64);
  }
  const timeout = all("--timeout")[0];
  console.log(JSON.stringify(runtimeGuard(target, { entries: all("--entry"), probes: wanted.length ? (wanted as Probe[]) : undefined, timeoutSec: timeout ? Number(timeout) : undefined }), null, 2));
}
