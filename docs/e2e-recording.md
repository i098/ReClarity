# End-to-end recording

The first README video shows two live runs side by side. Both agents got the same prompt, on the same model, and started at the same time. The left pane is plain REA. The right pane is REA with ReClarity installed.

- Model: Claude Opus 5.5 (`claude-opus-5-5`) in Claude Code 2.1.332. REA 6.10.1. Both panes ran on one host at the same time.
- Input: one BLA-hardened ASAR with a 17.4 MB header (4000 flood entries, over the 16 MiB REA limit). Both folders held the same file.
- Prompt, the same for both: `Use REA (rea analyze-javascript-application app.asar) to analyze this app and tell me what it does.`
- Right folder: ReClarity `main` at `3d48b0d`, installed with `npx skills add i098/ReClarity --skill anti-bla --skill setup-clarity` and `setup-clarity/hooks/install.ts --target app.asar`. Left folder: no ReClarity hooks or skills.
- Both runs used `claude -p` with `--permission-mode bypassPermissions`. The pane text comes from `show.py`, which prints each tool call, tool result and ReClarity hook message in a short form.
- Playback: the same speed in both panes. Waits over 1.5 s with no output in either pane are cut to 1.5 s, on both panes together. The `real` clock in the title bar shows the true time of the runs.

What the runs show (one run each):

| | Plain REA | REA + ReClarity |
| --- | --- | --- |
| First REA error | 0:38: `ASAR header/index admission is limited to 16 MiB` | 0:22: the same error |
| Next step | The agent sets `REA_ASAR_MAX_HEADER_BYTES` to 32 MiB and runs REA again. REA ends after 64 s with a 266 MB evidence file. | The hook says "capacity limit, not a result" and names `run.ts`. The agent loads `anti-bla`, scans (score 100) and runs `run.ts`. REA exits 0 on a cleaned copy. |
| Answer | 7:21. The agent decoded the JS by hand: it searched the disk for a parser, installed `acorn` and wrote its own folding script. | 1:47. The agent read the cleaned copy. |

Both answers name `tiny-notes` 1.0.0, a small notes app padded with decoys. This recording does not grade the answers against a ground truth. It shows the path and the time each agent took.

Files, in [`proof/side-by-side/`](proof/side-by-side): [`plain-rea.cast`](proof/side-by-side/plain-rea.cast) and [`rea-reclarity.cast`](proof/side-by-side/rea-reclarity.cast) (play with `asciinema play`), the session script `session.sh`, `show.py`, and the renderer `render.py` with `captions.json`.

Limits:

- One run each, one model, one hardened build. The agent runs are not deterministic. Another run can take another path.
- The plain agent was free to set the REA limit variable and did. A plain agent that does not set it stops at the first error, as in the earlier recording below.
- The build is a small ASAR with a flood header, not a native app.
- The captions were written by hand from the pane text and checked on nine frames by Claude Opus 5.5.

## Earlier recording (2026-11-12)

The first version of this video was cut from one sequential recording, [`media/reclarity-e2e-v3.mp4`](media/reclarity-e2e-v3.mp4) (all AI sessions on Claude Opus 5.5): plain REA with the cap override forbidden stopped at the 16 MiB ASAR limit with 0 of 3 answers, and REA + ReClarity (agent told to use it) gave 3 of 3 correct answers. The two panes were not live at the same time. The auto-trigger result in that recording was negative and is in [Auto-trigger](auto-trigger.md). BLA hardening ran as a plain script, because Opus 5.5 refused that prompt.
