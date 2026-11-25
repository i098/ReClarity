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
The first session (`b70828c7-29cb-412d-98d4-91bdecb1d006`) ran the hint before the runner fix. Its result is below.

- REA failed on the header limit and `fence.ts` gave the complete command.
- The agent ran that command with `app.asar` for `'./app.asar'`, after its own `scan.ts` run. `run.ts` cleaned a copy and ran REA on it.
- REA exited 1 on the cleaned copy: the cleaned copy keeps the 21.6 MB header. The verdict was `rea-failed`.
- `run.ts` did not retry, because it judged the REA error as `capacityError: false`.

## Runner check (2026-11-25)

The session above showed two faults in `run.ts`.
REA prints its error as text on stdout, and `isReaCapacityError` read only stderr and JSON, so the verdict was `rea-failed` with `capacityError: false`.
The cleaned copy also keeps the 21.6 MB header, and `run.ts` did not pass `REA_ASAR_MAX_HEADER_BYTES` to REA.
Now `isReaCapacityError` reads REA's text error when stdout starts with `error: `, and `run.ts` runs REA with the `reaEnv` from `sanitize.ts` (here 22 MiB).

Run by hand on the same archive: `bun run.ts app.asar --work w --rea 'rea analyze-javascript-application {target}'`.
REA passed the header limit and ran for the whole 1801 s time cap of `run.ts`, then `run.ts` killed it: `exitCode: null`, verdict `rea-failed`.
An earlier try of the same command stopped at 280 s with REA still running.
So REA does not finish on this archive within 30 min.
Then a new Claude Code session (3eb168b4-e959-4a81-814c-f44355707dcb, same first message, skills and hooks with this fix) was recorded in the [transcript](proof/hint-runnable-transcript.txt).
The agent ran the hinted command, and `run.ts` started REA on the cleaned copy.
REA did not fail with the header error this time: it was still running when I stopped the session at about 300 s.
Before the fix, REA failed with that error on the same copy after 3 s.
The session did not reach a REA result, so it does not show a passing REA result.

Limits:
- The hint makes the retry run, and REA now starts on the cleaned copy with the raised header limit. It does not finish on this archive within 30 min; that is tracked in [issue #40](https://github.com/i098/ReClarity/issues/40).
- Earlier sessions with the same hook and a first message that did not name the command read `SKILL.md` first. Text from the skill matched the capacity pattern, so the hook gave the hint before REA had failed. In those sessions the hint stayed in its placeholder form.
- The placeholder form is also what the agent gets when the failed command is not a plain `rea` command or does not name a configured target.
- This check used one model and one archive, and the session stopped at the 300 s limit.
- omp does not read `.claude/settings.json` hooks, so this check covers Claude Code only.

## ASAR flood cut (2026-11-25, refs #40)

The sample has 90000 entries of 1 byte with short paths (`d0/f0.js`), so the old rule (path of 200+ chars) found none, and the cleaned copy kept the 21.6 MB header.
Now, when the header is over 16 MiB, `scan.ts` and `sanitize.ts` also count tiny entries (256 B or less) with the same size and the same content (read from the archive, not from `integrity` or offset; empty files group by size 0) 100 times or more as flood.
Limit: the rule ignores the path, so 100 or more identical tiny real files (empty files, stubs) in such an archive are dropped too. The run note names each repeated group: count, size and first 3 paths.
`sanitize.ts` drops them and writes a new header. All other entries stay byte-identical (unit test).
`REA_ASAR_MAX_HEADER_BYTES` is set only if the cleaned header is still over 16 MiB. `run.ts` adds the dropped count to the run notes.

Measured with real REA, `bun run.ts app.asar --work w --rea 'rea analyze-javascript-application {target}'`:

| | Before (header kept, limit raised) | After |
|---|---|---|
| Header of the copy | 21662601 B | 12 B |
| `REA_ASAR_MAX_HEADER_BYTES` | 22 MiB | not set |
| Wall time | killed at the 1801 s cap | 87 s, then 75 s (second run) |
| REA exit code | null (killed) | 0 |
| Verdict | `rea-failed` | `ok` |

Row above: the empty sample (90000 flood entries, no real file). Note: `90000 entries dropped, header 21662601 B -> 12 B`. The sample has no real file, so REA found 0 sources.
New Claude Code session (b420fc95-7e72-4bdb-891c-b467a86f148e, first message does not name ReClarity): the agent ran `run.ts` and REA finished; see the [transcript](proof/asar-flood-cleaned-transcript.txt). One session, one sample.


Second measured run, an ASAR with a real small JS app (`dist/main.js` and `package.json` from the test fixtures) plus 90000 flood entries (22013342 B header), same `run.ts` command:

| | Result |
|---|---|
| Header before / after cleaning | 22013342 B / 108 B |
| Entries dropped (run note) | 90000 |
| `REA_ASAR_MAX_HEADER_BYTES` | not set |
| REA wall time, exit, verdict | 74 s, 0, `ok` |
| REA input | "Processing 2 selected application files": `dist/main.js` and `package.json` |
| Real files in the cleaned copy | `dist/main.js`, `package.json`, byte-identical to the original (compared by read-back) |

Limit of the rule: it applies only when the header is over 16 MiB. Then real files of 256 B or less with 100 or more identical copies (same bytes, same size) are dropped too.
