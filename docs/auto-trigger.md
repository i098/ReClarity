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

## Hint check (2026-11-25)

The first hint named `run.ts <target>`, which exits 64 without `--work` and does not call REA without `--rea` (issue #38).
`fence.ts` now rebuilds the failed call into one complete command: `run.ts '<target>' --work .reclarity/work --rea '<failed rea command with {target}>'`.
It does this when the failed Bash command is a `rea` command and one of its words is a configured target.
Otherwise it prints the same command with placeholders.

Setup: the same sample (21.6 MB ASAR header), Claude Code 2.1.331, Sonnet 5.5, and the skills and hooks from this branch.
The first message did not name ReClarity or anti-bla, and did not ask for one single command.
See the [transcript](proof/hint-runnable-transcript.txt) for session `b70828c7-29cb-412d-98d4-91bdecb1d006`.

- REA failed on the header limit and `fence.ts` gave the complete command.
- The agent ran that command with `app.asar` for `'./app.asar'`, after its own `scan.ts` run. `run.ts` cleaned a copy and ran REA on it.
- REA exited 1 on the cleaned copy: the cleaned copy keeps the 21.6 MB header. The verdict was `rea-failed`.
- `run.ts` did not retry, because it judged the REA error as `capacityError: false`.

Limits:
- The hint makes the retry run. It does not make REA pass on this archive: the header stays above 16 MiB. The agent then raised `REA_ASAR_MAX_HEADER_BYTES` itself.
- Earlier sessions with the same hook and a first message that did not name the command read `SKILL.md` first. Text from the skill matched the capacity pattern, so the hook gave the hint before REA had failed. In those sessions the hint stayed in its placeholder form.
- The placeholder form is also what the agent gets when the failed command is not a plain `rea` command or does not name a configured target.
- This check used one model and one archive, and the session stopped at the 300 s limit.
- omp does not read `.claude/settings.json` hooks, so this check covers Claude Code only.
