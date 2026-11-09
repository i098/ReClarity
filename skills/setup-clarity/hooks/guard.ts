#!/usr/bin/env bun
// PreToolUse: a target is read-only and is never run raw. Blocks (exit 2): writes into a target, and a run of a
// target outside anti-bla's sandbox. Reads and greps are allowed: the fence flags what they return.
import { resolve } from "node:path";
import { inTarget, loadConfig, log, readInput, root } from "./lib.ts";

const WRITE = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "write_file", "replace", "apply_patch"]);
const SHELL = new Set(["Bash", "run_shell_command", "shell"]);
const START = String.raw`^\s*(?:\w+=\S*\s+)*`;
const RUNNER = new RegExp(START + String.raw`(?:node|nodejs|bun|deno|python3?|java|ruby|perl|php|go run|cargo run|dotnet|wasmtime|wasmer|electron|npx|bash|sh|zsh|source)\s`);
const MUTATE = new RegExp(START + String.raw`(?:rm|mv|sed\s+-i|tee|truncate|chmod|patch|dd|ln)\s`);
const COPY = new RegExp(START + String.raw`(?:cp|install)\s+(.*)$`);
/** Destination of `cp`/`install`: the `-t` value, else the last argument that is not a flag. */
function copyDest(part: string): string | undefined {
  const args = part.match(COPY)?.[1]?.trim().split(/\s+/).map((a) => a.replace(/^['"]|['"]$/g, ""));
  if (!args) return undefined;
  const t = args.findIndex((a) => a === "-t" || a === "--target-directory");
  return t >= 0 ? args[t + 1] : args.filter((a) => !a.startsWith("-")).at(-1);
}
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A piece that starts with one of anti-bla's own tools, in the configured anti-bla folder. */
const ANTI_BLA = new RegExp(String.raw`^\s*bun\s+(?:\S*/)?${esc(loadConfig().antiBla.replace(/^\.\//, ""))}/scripts/[\w-]+\.ts\b`);

const i = await readInput();
const cfg = loadConfig();
if (!cfg.targets.length) process.exit(0);
const dir = root(i);
const input = i.tool_input ?? {};
const tool = i.tool_name ?? "";
const deny = (rule: string, why: string): never => {
  log(dir, { event: "guard", tool, rule });
  console.error(`[reclarity] Blocked (${rule}). ${why}`);
  process.exit(2);
};

if (WRITE.has(tool)) {
  const p = String(input.file_path ?? input.path ?? input.notebook_path ?? "");
  if (p && inTarget(p, cfg, dir)) deny("target-read-only", `${p} is inside a target. Do not edit it. Clean a copy: bun ${cfg.antiBla}/scripts/sanitize.ts <target> --out <copy>.`);
  const patch = String(input.input ?? input.patch ?? "");
  const hit = patch.match(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)?.find((l) => inTarget(l.replace(/^\*\*\* \w+ File: /, ""), cfg, dir));
  if (hit) deny("target-read-only", `${hit} is inside a target. Clean a copy instead.`);
}

if (SHELL.has(tool)) {
  const alt = Object.fromEntries(cfg.targets.map((t) => [t, [t.replace(/^\.\//, ""), resolve(cfg.root ?? dir, t)].map(esc).join("|")]));
  // Judge each piece of a compound command alone: `bun .../scan.ts dist; node dist/app.js` must still block the second.
  for (const part of String(input.command ?? "").split(/&&|\|\||[;|\n]/)) {
    const named = cfg.targets.find((t) => new RegExp(String.raw`(?:^|[\s'"=<>(])(?:\./)?(?:${alt[t]})(?=[/\s'"]|$)`).test(part));
    if (!named) continue;
    const e = `(?:${alt[named]})`;
    const dest = copyDest(part);
    if (dest && inTarget(dest, cfg, dir)) deny("target-read-only", `This command would copy into ${named}. Copying out of a target is allowed; copying in is not.`);
    const redirected = [...part.matchAll(/>>?\s*(\S+)/g)].some((m) => inTarget((m[1] ?? "").replace(/^['"]|['"]$/g, ""), cfg, dir));
    if (MUTATE.test(part) || redirected) deny("target-read-only", `This command would change ${named}. Work on a copy.`);
    if (ANTI_BLA.test(part)) continue;
    if (RUNNER.test(part) || new RegExp(`^\\s*(?:\\./)?${e}(?:[/\\s]|$)`).test(part))
      deny("run-in-sandbox", `This command would run ${named} outside the sandbox. A hardened build can hold decoy code. Use: bun ${cfg.antiBla}/scripts/run.ts ${named} --rea "<command with {target}>".`);
  }
}
