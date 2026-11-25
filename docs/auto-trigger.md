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
Limit: the rule applies only when the header is over 16 MiB and ignores the path, so 100 or more identical tiny real files (empty files, stubs) in such an archive are dropped too. The run note names each repeated group: count, size and first 3 paths.
`sanitize.ts` drops them and writes a new header. All other entries stay byte-identical (unit test).
`REA_ASAR_MAX_HEADER_BYTES` is set only if the cleaned header is still over 16 MiB. `run.ts` adds the dropped-group note (above) to the run notes.

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

## New-user end-to-end check (2026-11-25)

Setup, from a fresh empty project: Claude Code 2.1.332, Sonnet 5.5, REA (`rea-agents`) 6.10.1.
`npx skills add i098/ReClarity --skill anti-bla --skill setup-clarity -a claude-code -y` installed `main` at `b510c3a`.
Then `bun install` in the `anti-bla` folder and `bun .claude/skills/setup-clarity/hooks/install.ts --target app.asar`.
The sample `app.asar` has `dist/main.js`, `package.json` and 90000 one-byte flood entries (22215232 B header).
Each session was a new `claude -p` run with `--permission-mode bypassPermissions` and the hooks from `.claude/settings.json`.

Result, run 6 (session `0ed8cfaa-becc-43d9-ba14-a73d7b8f8640`, wall time 65 s): pass.
First message: `Use REA (rea analyze-javascript-application app.asar) to analyze this app and tell me what it does.` It does not name ReClarity or anti-bla.
1. The agent ran `rea analyze-javascript-application <abs path>/app.asar`. REA failed: `ASAR header/index admission is limited to 16 MiB`.
2. `fence.ts` fired on that call (`PostToolUse`, `capacity: true`) and returned the complete command: `bun .claude/skills/anti-bla/scripts/run.ts '<abs path>/app.asar' --work .reclarity/work --rea 'rea analyze-javascript-application {target}'`.
3. The agent loaded the `anti-bla` skill, ran `scan.ts` (score 40, `asar_header_flood`), then ran `run.ts "$PWD/app.asar" --work .reclarity/work --rea 'rea analyze-javascript-application {target}'`.
4. `run.ts` cleaned a copy and ran REA on it: exit 0, verdict `ok`, `capacityError: false`.
5. The agent gave a correct answer: `tiny-notes`, a 779 B module with `slugify`, `wordCount`, `checkLicense` and `rareExport`, and no Electron API calls.

Proof: [transcript](proof/autotrigger-e2e-transcript.txt), [hook log](proof/autotrigger-e2e-hooks.jsonl), [terminal recording](proof/autotrigger-e2e.cast) (`asciinema play`).

Seven sessions in total, same project, same sample:

| Run | First message | First REA call | Hint form | `run.ts` verdict | Wall time (agent) |
|---|---|---|---|---|---|
| 1 | `Analyze the app in this folder (app.asar) with REA and tell me what it does and which entry points it has.` | none; read `SKILL.md` first | placeholder, fired on the `SKILL.md` read | `ok` | 92 s |
| 2 | `Run rea on app.asar and tell me what the app does.` | none; `cat SKILL.md` first | placeholder, fired on `cat SKILL.md` | `ok` | 44 s |
| 3 | same as run 2 | none; `Skill anti-bla` first | none (hook did not fire) | `ok` | 45 s |
| 4 | same as run 2 | none; `cat SKILL.md` first | placeholder, fired on `cat SKILL.md` | exit 0 | 52 s |
| 5 | `Use REA (rea analyze-javascript-application app.asar) to analyze this app and tell me what it does.` | failed on header limit | complete command | `ok` | 49 s |
| 6 | same as run 5 | failed on header limit | complete command | `ok` | 59 s |
| 7 | same as run 5 | failed on header limit | placeholder (the command has `$(date +%s)`) | `ok` | 62 s |

- In runs 1 to 4 the first message did not name the command. The agent listed `.claude/skills` and read the `anti-bla` skill before it called REA, so the failed-REA hook path did not run. The agent still reached `run.ts` and a real answer, by way of the skill.
- In runs 5 to 7 the hook fired on the failed REA call, and the agent ran `run.ts` and got a real answer. Runs 5 and 6 got the complete command. Run 7 got the placeholder form, because the failed command has `$(...)`, which the rebuild does not accept.
- The agent did not paste the hinted command word for word: it ran `run.ts` with the same arguments from another working directory or with `$PWD` for the target.
- Limits: one model, one sample, 7 sessions, `claude -p` (not the interactive UI). A user-level hook (`subcon-agents/agent-hook`) that is not part of ReClarity exited 127 in each session.
