# Proof: A/B/C runs

Run on 2026-11-08 on this host, recorded at commit 67c7245. Tool: `skills/anti-bla/scripts/bench.ts`. Later fold changes (per-file fold, `node_modules` kept, stricter sink rules: loops and member access are now refused, so no sink call is removed on the real BLA fixture) are not re-measured: the packed plain and hardened ASAR pair and the REA build are not in this repository, so `bench.ts` was not re-run. Arm C numbers describe the older fold code.

## Setup

- **Fixture is real BLA output.** BLA 3.1.0 (`bla-agents`, commit `41345ff`) was built locally. A small Electron-style app (`tiny-notes`: `slugify`, `wordCount`, `checkLicense`, `rareExport`, preload with two IPC channels) was packed to ASAR and hardened with `bla protect --intensity bankrupt --seed fixture-1`.
- **REA** 6.8.0, built locally. Same command for every arm: `rea analyze-javascript-application <asar> --format json`.
- **Arms.** A: plain app. B: BLA-hardened app. C: the hardened app after `bench.ts` cleaned a copy (sanitize and fold-js; no coverage, because coverage does not cover ASAR). The clean time is added to arm C.
- **Facts.** `notes:save`, `notes:count`, `PRO`: literals that BLA's renaming keeps. Function names are not used, because BLA renames them in every arm.
- 3 runs per arm. Numbers do not change between runs except wall time.

## Result

| Arm | REA outcome | Wall time (ms) | Evidence tokens | Recall of 3 facts | Trap words in evidence | Unknowns |
| --- | --- | --- | --- | --- | --- | --- |
| A plain | ok | 5350-5499 | 138126 | 1.00 | 0 | 111 |
| B hardened | capacity error: ASAR header 16 MiB limit | 1904-2066 | 783 (the error text) | 0.00 | 0 | 0 |
| C cleaned | ok | 6205-7362 (+450 clean) | 618233 | 1.00 | 12 | 712 |

BLA's ASAR header flood (4000 decoy entries, 17.4 MiB header) stops REA before any analysis. ReClarity drops the flood entries and REA runs again. Arm B shows the failure. Arm C restores the analysis and the IPC facts.

## What ReClarity did not fix

Arm C is not equal to arm A:

- **Code that ran is kept.** BLA also appends "decorative shadow runtime" blocks that execute at load. `fold-js` leaves them in place, because code that ran is evidence. They stay in the copy, so C has 4.5 times the tokens of A and 712 unknowns.
- **Measured upper bound.** Removing these blocks by hand from the cleaned copy gave 150165 tokens (A: 138126). This is not shipped: deleting code that ran could change behavior.
- **Identifier renaming stays.** BLA renames functions. Function names are not recovered, so a name-based recall metric would be 0 in arms B and C.

## Not run

- No agent (Claude/Codex) was run on the evidence. "Attacker tokens" and "hidden-test accuracy" from the plan are not measured. Evidence tokens above are REA's own `--token-count`.
- Other formats (WASM, SQLite, Python, Go, Rust, BEAM, PCAP) are out of scope.
- One fixture and one BLA seed. Fuses ran on a hand-made fake Electron binary with BLA's fuse decoy shapes, not a real Electron build.
- The 300k token cap and 30 minute cap are starting values. Arm C used 618k evidence tokens, which a 300k cap would reject; tune it from more runs.
