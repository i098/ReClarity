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

- **Code that ran is kept.** BLA also appends "decorative shadow runtime" blocks that execute at load. `fold-js` leaves them in place: they are not sink calls (`fold-js` drops only sink calls; it removed 0 on this fixture), and code that ran is evidence. They stay in the copy, so C has 4.5 times the tokens of A and 712 unknowns.
- **Measured upper bound.** Removing these blocks by hand from the cleaned copy gave 150165 tokens (A: 138126). This is not shipped: deleting code that ran could change behavior.
- **Identifier renaming stays.** BLA renames functions. Function names are not recovered, so a name-based recall metric would be 0 in arms B and C.

## Not run

- No agent (Claude/Codex) was run on the evidence. "Attacker tokens" and "hidden-test accuracy" from the plan are not measured. Evidence tokens above are REA's own `--token-count`.
- Other formats (WASM, SQLite, Go, Rust, BEAM, PCAP) are out of scope.
- One fixture and one BLA seed. Fuses ran on a hand-made fake Electron binary with BLA's fuse decoy shapes, not a real Electron build.
- The 300k token cap and 30 minute cap are starting values. Arm C used 618k evidence tokens, which a 300k cap would reject; tune it from more runs.

## Runtime guard

Files: `tests/fixtures/main.bla.js` (the A/B/C fixture, BLA 3.1.0) and `tests/fixtures/main.bla-seal.js` (`bla protect --intensity bankrupt --seed rg-1 --self-seal` on a small app that prints `license true` and writes `out.txt`; bla-agents 3.1.0, commit 41345ff). Both come from real BLA output.

`runtime-guard.ts` result on both builds (sandboxed; baseline with nothing attached, then probes `inspect`, `remote-debugging`, `cdp`, `frida`, `node-options`):

- It finds BLA's guard code: `inspectorObserved`, `cdpShapeBudgetGuard_*`, `fridaCaptureSaturator_*`, `__puppeteer_evaluation_script__`.
- **Output never diverges.** stdout, stderr, exit code and files are the same with every probe. The only change is one decorative global (`_enclaveRuntimeLedger_*` / `_enclaveRuntimeGateway_*`, `inspectorObserved` false to true). Verdict `state-only`. This matches BLA's own contract (`classification: "decorative-deception-signal"`).
- **`--self-seal` build:** the `node-options` probe runs one more line (line 95, the digest of `NODE_OPTIONS` and `execArgv`), and nothing else changes. Verdict `code-paths-only`. The seed stays the same: BLA masks the digest's low bit.

REA 6.8.0 has no inspector that finds these guards, so no hardened-vs-cleaned number is claimed. What I ran: `rea capture-process` and `rea compare-process-captures` on `main.bla-seal.js`, once as `node main.js` and once as `node --inspect=0 main.js`, same working directory (scenarios and captures kept under the task data folder, not in the repo).

- The comparison reports `terminal: changed`. The first divergence is Node's own line `Debugger listening on ws://...`, not a guard effect.
- It also labels `exit` and `filesystem` as `changed`, but the raw captures hold the same exit (code 0, reason `exited`) and the same `out.txt` hash. I did not find why the labels differ.
- REA cannot say which code reacted to the attach. `runtime-guard.ts` can, and it also strips Node's banner as noise.

### Real Frida and CDP runs

The `cdp` and `frida` probes only set the globals BLA reads. To check them against real tools, `main.bla-seal.js` ran under a wrapper (`w.js`) that requires it and writes the guard's `inspectorObserved` value to `state.json`. Same app, same host, four ways. `out.txt` has the same SHA-256 (`b5bea41b...`) in every run.

| Run | Tool | `state.json` (`inspectorObserved`) | stdout and `out.txt` |
| --- | --- | --- | --- |
| Nothing attached | `node w.js` | `false` (`98557895...`) | `license true`, same file |
| Frida spawn | REA 6.8.0 `instrument-with-frida spawn` (Frida 17.23.2, QJS script, via REA's Node binding) | `false` (`98557895...`) | same |
| Frida spawn | `frida -f node -l hook.js` (frida-tools, Frida 17.26.2, venv) | `false` (`98557895...`) | same |
| Real CDP client | `node --inspect-brk`, WebSocket client sends `Runtime.enable`, `Debugger.enable`, `Profiler.enable`, then resumes | `true` (`589aa6b7...`) | same |

- **CDP:** the guard flips because `--inspect-brk` is in `process.execArgv`. I did not run the client without the flag, so I cannot say the client alone changes nothing. Only the one decorative flag changes.
- **Frida:** the guard does not flip. BLA's own source says Frida's globals live in its isolated Gum realm, not in `globalThis`, and the run agrees. The `frida` probe therefore shows an upper bound, not what a real Frida does to this build. It is the case for a build whose guard reads another Frida signal.
- **Probe vs real:** `runtime-guard.ts` on the same wrapper (`--entry w.js`) reports `output-diverges` for `inspect`, `remote-debugging`, `cdp` and `frida` through `file:state.json`. For `inspect` and `cdp`, its probed `state.json` is `[["_enclaveRuntimeGateway_27e3",true]]`, the same as the real CDP run. For `frida` the real run stays `false`.
- **Frida attach to a running node** (`instrument-with-frida attach <pid>`) failed: `Unable to access /proc/<pid>/mem: Permission denied` (`kernel.yama.ptrace_scope=1`, the target is not a child of REA). Spawn works, so spawn is what I ran.
- Not run: a real CDP client against an Electron window (no display here), and any guard that checks timing or `TracerPid`. I found no such check in the BLA 3.1.0 runtime shields I read.

## Python tarpit and `.pyc` decoys

Run on 2026-11-08 on this host. REA 6.8.0 (`inspect-python-pyc`), BLA 3.1.0 (`bla-agents`, commit `41345ff`).

**Fixture is real BLA output.** `tests/fixtures/ledger.py` (a 40-line ledger program with one real helper named `hydrate_session_cache_1234`, shaped like a BLA decoy name) went through `bla protect --intensity bankrupt --seed fixture-1 --weave-decoys`: once as source (`ledger.bla.py`, 935 B to 43681 B), and as `.pyc` compiled by CPython 3.9, 3.12 and 3.14 (`ledger.py<ver>.bla.pyc`, 1.4-1.9 KB to 11.7-13.1 KB).

### `.py` source

| Arm | Result |
| --- | --- |
| BLA output | 19 tarpit defs, shared slot, state int, warm-up call, weave lines in the real defs, honey docstring |
| After `coverage.ts --out` (coverage.py 7.17.2 in bwrap) | 43681 B to 938 B; 43 entries in `quarantine.json` (31 tarpit top-level statements ran only in the warm-up, the rest never ran or are weave lines); the file equals `ledger.py` apart from blank lines; `python3` prints the same 3 lines as the original |
| Real helper `hydrate_session_cache_1234`, `rare_export` | kept (called by `main`, or not run but not tarpit-shaped) |

REA 6.8.0 has no inspector for Python source, so there is no REA number for this arm. The check is behavior (same output) and the diff with the plain source. `python.test.ts` repeats it and also checks that a decoy named by live code, or imported by another file, stays with what it needs.

### `.pyc`

Same command for every row: `rea inspect-python-pyc <file> --format json` (`--token-count` for tokens). The three arms are the plain `.pyc`, the BLA `.pyc`, and the BLA `.pyc` after `sanitize.ts` (27 decoy code objects and the 7521 B honey trailer dropped).

| CPython | Arm | REA outcome | Evidence tokens | Facts found (`total`, `apply_discount`, `check_license`, `rare_export`, `PRO-`, `main`) |
| --- | --- | --- | --- | --- |
| 3.9 | plain | ok | 2396 | 6 of 6 |
| 3.9 | hardened | error `invalid_format`: trailing bytes after the marshal object (exit 1) | 189 (the error text) | 0 of 6 |
| 3.9 | cleaned | ok | 2396 | 6 of 6 |
| 3.12 | plain | ok | 2285 | 6 of 6 |
| 3.12 | hardened | error `invalid_format`: trailing bytes (exit 1) | 190 (the error text) | 0 of 6 |
| 3.12 | cleaned | ok | 2285 | 6 of 6 |

The honey trailer alone stops REA. With the trailer cut by hand and the 27 decoys left in (3.12), REA runs but reports 6750 tokens against 2285 for the plain file, and its evidence lists 27 decoy code objects as functions. The cleaned copy has the same token count as the plain file and runs the same on its own interpreter (the test compares the output of `python -I` on the plain, hardened and cleaned files). The 3.14 `.pyc` was cleaned and run, but REA 6.8.0 decodes only CPython 3.7-3.13, so there is no REA number for it.

### Not covered

- A `.pyc` compiled from already hardened source keeps the tarpit as ordinary functions (they are referenced by bytecode). Only the source route removes them. A PyInstaller bundle holds such files, so it is a limit: clean the `.py` files before bundling. `scan.ts` prints a note when it sees a PyInstaller archive.
- One fixture, one seed, one BLA version. Python 3.7 and 3.8 `.pyc` layouts (BLA `py37`, `py38`) were not built here.
- Coverage covers one run of the entry. A branch the run did not take is "not run", and stays unless it matches the tarpit shape.
