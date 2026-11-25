# Auto-trigger

REA exits 1 when the ASAR header crosses its 16 MiB limit, the case in run 2 below. Claude Code sends a failed tool call as `PostToolUseFailure`, not `PostToolUse`. The installer registered the fence hook only for `PostToolUse`, so the capacity route never ran in that case. `setup-clarity/hooks/install.ts` now registers `fence.ts` for both.

## Live check (2026-11-25)

Setup: Claude Code 2.1.331, REA (`rea-agents`) 6.10.1, Sonnet 5.5. ReClarity installed from `main` with `npx skills add i098/ReClarity --skill anti-bla --skill setup-clarity`, then `bun .claude/skills/setup-clarity/hooks/install.ts --target dist --target app.asar`. Each session was fresh (`claude -p`). No prompt named ReClarity or anti-bla.

| Run | Target | Result |
| --- | --- | --- |
| 1 | BLA 3.5.9 build (`--seed s1`, one JS app, `dist/`) | REA ran with exit 0 and returned enclave and vsock bait. The fence fired on the Read and Bash results (`enclave_words`, `bait_text`, `claim_logic_elsewhere`). The guard blocked a direct scan of `dist` (`run-in-sandbox`). |
| 2 | ASAR (21.6 MB header, over the 16 MiB limit), one command with no pipe | REA exited 1 with the ASAR header error. Claude Code sent `PostToolUseFailure:Bash`. `fence.ts` answered with `additionalContext`: "This looks like a capacity limit ... Next: bun .claude/skills/anti-bla/scripts/run.ts <target>". |

Run 2 is the case this fix targets: a non-zero REA exit.

Limits:
- Committed artifacts cover run 1 ([hook log](proof/auto-trigger-bait-hooks.jsonl)) and run 2 ([hook log](proof/auto-trigger-failure-hooks.jsonl), [condensed transcript](proof/auto-trigger-failure-transcript.txt)). No artifact records the prompts or the agent's own steps, so the process details for run 1 rest on the session notes from that day. The transcript drops one empty `PostToolUseFailure output` line of unknown source.
- In run 2 the prompt said "run exactly this single command", so the agent read the hint but did not run `run.ts`. The hook does what it is built to do: it puts the route in context. Whether the agent follows it depends on the prompt. In run 1 the agent loaded `anti-bla` and used `run.ts` without a prompt about ReClarity.
- Run 1 shows the route on a piped command (`| head` hides the REA exit code), which is the `PostToolUse` path.
- One model, one sample, one seed. Under `--max-semantic-nodes 100` REA exits 0 with `budget exceeded` text, so that limit goes through `PostToolUse`.
- omp does not read `.claude/settings.json` hooks, so this check covers Claude Code only.
