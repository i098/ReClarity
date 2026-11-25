# Auto-trigger

In the live check below, REA exited with code 1 because the ASAR header exceeded its 16 MiB limit.
Claude Code sends a failed tool call as `PostToolUseFailure`, not `PostToolUse`.
The installer registered the fence hook only for `PostToolUse`, so the capacity route did not run for that failure.
`setup-clarity/hooks/install.ts` now registers `fence.ts` for both events.

## Live check (2026-11-25)

Setup: REA (`rea-agents`) 6.10.1 and Sonnet 5.5.
The [transcript header](proof/auto-trigger-failure-transcript.txt) records Claude Code 2.1.331, the session ID, and the first user message.
ReClarity was installed from `main` with `npx skills add i098/ReClarity --skill anti-bla --skill setup-clarity`.
The hook installer command included `bun .claude/skills/setup-clarity/hooks/install.ts --target app.asar` with one additional target.
The first message in the fresh session did not name ReClarity or anti-bla.

The session ran `rea analyze-javascript-application app.asar` without a pipe.
REA exited with code 1 because the archive had a 21.6 MB header.
Claude Code sent `PostToolUseFailure` for Bash, and `fence.ts` returned the capacity hint in `additionalContext`.
See the [hook log](proof/auto-trigger-failure-hooks.jsonl) and [condensed transcript](proof/auto-trigger-failure-transcript.txt).
The transcript omits one empty `PostToolUseFailure output` line of unknown source.

Limits:
- The first user message in the transcript asks for exactly one command. The agent did not run `run.ts`.
- The recorded hint does not retry REA as shown. `run.ts` requires `--work` and invokes REA only if you supply `--rea`.
- This check used one model and one archive.
- omp does not read `.claude/settings.json` hooks, so this check covers Claude Code only.
