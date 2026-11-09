#!/usr/bin/env bun
// Copy the hooks into <project>/.<agent>/hooks, write config.json, merge the hook entries into the agent's config.
// bun install.ts --target dist [--target other] [--agent claude|codex|gemini] [--project dir] [--anti-bla dir]
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

type Entry = { matcher?: string; hooks: { type: "command"; command: string; timeout?: number }[] };
type Settings = { hooks?: Record<string, Entry[]> } & Record<string, unknown>;

const FILES = ["lib.ts", "fence.ts", "guard.ts", "session.ts"];
const WRITES = "Write|Edit|MultiEdit|NotebookEdit|Bash|apply_patch";

const AGENTS = {
  claude: {
    dir: ".claude",
    file: "settings.json",
    path: (f: string) => `bun "$CLAUDE_PROJECT_DIR/.claude/hooks/reclarity/${f}"`,
    events: { pre: ["PreToolUse", WRITES], post: ["PostToolUse", ""], start: ["SessionStart", "startup|resume|clear|compact"] },
  },
  codex: {
    dir: ".codex",
    file: "hooks.json",
    path: (f: string) => `bun "$(git rev-parse --show-toplevel)/.codex/hooks/reclarity/${f}"`,
    events: { pre: ["PreToolUse", WRITES], post: ["PostToolUse", ""], start: ["SessionStart", "startup|resume"] },
  },
  gemini: {
    dir: ".gemini",
    file: "settings.json",
    path: (f: string) => `bun "$(git rev-parse --show-toplevel)/.gemini/hooks/reclarity/${f}"`,
    events: { pre: ["BeforeTool", "write_file|replace|run_shell_command"], post: ["AfterTool", ""], start: ["SessionStart", "startup|resume|clear"] },
  },
} as const;

function arg(name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < process.argv.length; i++) if (process.argv[i] === `--${name}` && process.argv[i + 1]) out.push(process.argv[i + 1]!);
  return out;
}

const agentName = (arg("agent")[0] ?? "claude") as keyof typeof AGENTS;
const agent = AGENTS[agentName];
const targets = arg("target");
if (!agent || !targets.length) {
  console.error("usage: bun install.ts --target <build path> [--target ...] [--agent claude|codex|gemini] [--project dir] [--anti-bla dir]");
  process.exit(64);
}
const project = resolve(arg("project")[0] ?? process.cwd());
const antiBla =
  arg("anti-bla")[0] ??
  ["skills", ".claude/skills", ".agents/skills", ".codex/skills", ".gemini/skills"].map((d) => `${d}/anti-bla`).find((d) => existsSync(join(project, d, "scripts/scan.ts"))) ??
  "skills/anti-bla";

const hooksDir = join(project, agent.dir, "hooks", "reclarity");
mkdirSync(hooksDir, { recursive: true });
for (const f of FILES) copyFileSync(join(import.meta.dir, f), join(hooksDir, f));
writeFileSync(join(hooksDir, "config.json"), JSON.stringify({ targets, antiBla, root: project }, null, 2) + "\n");

const cfgPath = join(project, agent.dir, agent.file);
const settings: Settings = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, "utf8")) : {};
settings.hooks ??= {};
const ours = (e: Entry) => e.hooks.some((h) => h.command.includes("/hooks/reclarity/"));
for (const [kind, file] of [["pre", "guard.ts"], ["post", "fence.ts"], ["start", "session.ts"]] as const) {
  const [event, matcher] = agent.events[kind];
  const keep = (settings.hooks[event] ?? []).filter((e) => !ours(e));
  const entry: Entry = { hooks: [{ type: "command", command: agent.path(file), timeout: agentName === "gemini" ? 10000 : 10 }] };
  if (matcher) entry.matcher = matcher;
  settings.hooks[event] = [...keep, entry];
}
writeFileSync(cfgPath, JSON.stringify(settings, null, 2) + "\n");
console.log(JSON.stringify({ agent: agentName, hooks: hooksDir, settings: cfgPath, targets, antiBla, antiBlaFound: existsSync(join(project, antiBla, "scripts/scan.ts")) }));
