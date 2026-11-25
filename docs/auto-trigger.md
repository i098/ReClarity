# Auto-trigger

In the live check below, REA exited with code 1 because the ASAR header exceeded its 16 MiB limit.
Claude Code sends a failed tool call as `PostToolUseFailure`, not `PostToolUse`.
The installer registered the fence hook only for `PostToolUse`, so the capacity route did not run for that failure.
`setup-clarity/hooks/install.ts` now registers `fence.ts` for both events.

## Live check (2026-11-25)

Setup: Claude Code 2.1.331, REA (`rea-agents`) 6.10.1, Sonnet 5.5.
ReClarity was installed from `main` with `npx skills add i098/ReClarity --skill anti-bla --skill setup-clarity`.
The hook installer command included `bun .claude/skills/setup-clarity/hooks/install.ts --target app.asar` with one additional target.
The session was fresh (`claude -p`), and the prompt did not name ReClarity or anti-bla.

The session ran `rea analyze-javascript-application app.asar` without a pipe.
REA exited with code 1 because the archive had a 21.6 MB header.
Claude Code sent `PostToolUseFailure` for Bash, and `fence.ts` returned the capacity hint in `additionalContext`.
See the [hook log](proof/auto-trigger-failure-hooks.jsonl) and [condensed transcript](proof/auto-trigger-failure-transcript.txt).
The transcript omits one empty `PostToolUseFailure output` line of unknown source.

Limits:
- The prompt asked for exactly one command, so the agent did not run `run.ts`.
- The recorded hint does not retry REA as shown. `run.ts` requires `--work` for the output directory and `--rea` for the REA command.
- This check used one model and one archive. With `--max-semantic-nodes 100`, REA reports `budget exceeded` but exits with code 0, which uses `PostToolUse`.
- omp does not read `.claude/settings.json` hooks, so this check covers Claude Code only.
