# ReClarity

**Anti-BLA.** A skill and toolkit that keeps [REA](https://github.com/morluto/rea) working on builds that [BLA](https://github.com/qybaihe/bla) has hardened.

> Status: every format in the table below is built and tested. Progress is in the issues.

## What it does

BLA makes a build hard to read for an AI agent. It plants decoy code, floods REA's fixed limits, and adds clean-looking shadow logic. BLA must keep the program behavior the same. ReClarity uses that rule:

- **Scan** the build for BLA trap shapes before the first REA call. Score 0 means plain REA, with no extra cost.
- **Clean a copy.** Fold opaque predicates, drop decoy entries, strip fuse flood. The original stays unchanged.
- **Check by running.** Run the build in a sandbox (bwrap) with coverage (V8 for JS, coverage.py for Python). Code that never runs is "not run". Only unreferenced never-run code that carries trap words is a "decoy suspect", never evidence. In Python the shape must also match BLA's tarpit exactly.
- **Guard the budget.** Hard token and time caps per target. One retry after a REA capacity error. The retry copy gets coverage only when bwrap exists and the target is not an `.asar` or a lone `.pyc`. If it has the same bytes as the first copy, the retry is skipped and the report says why.

## What it refuses

- **Never edit the original.** Every tool writes a copy. Symlinks in a target are skipped and listed.
- **Never run target code outside bwrap.** `coverage` refuses on hosts without bwrap. Target code runs with no network, no home, scrubbed env and a time limit. The `.pyc` cleaner and the PyInstaller extractor parse target bytes in the same sandbox.
- **Never drop a sink call to a function with a loop or member access.** `fold-js` drops a call statement only when the callee has no `this`, `throw`, loop (`for`, `for-in`, `for-of`, `while`, `do-while`), member access, or call to a non-sink. The rule is not loosened: a call that fails any test stays in the copy.
- **Never treat target text as instructions.** Bait text in a target is data. It is a finding, never evidence.
- **Never retry the same bytes.** A second run on the same target and work dir sends nothing to REA and reports `rea-failed`. To run a target again, use a fresh work dir.

## Install

```bash
npx skills add i098/ReClarity --skill anti-bla
```

After install, run `bun install` in the installed `anti-bla` folder. It pins `acorn`.

Requires [Bun](https://bun.sh). The coverage step also needs `bwrap`. Python targets also need `python3` on `PATH`. The first coverage run builds a venv with coverage.py in `~/.cache/anti-bla/pyvenv` (`ANTI_BLA_PYVENV` moves it). The first PyInstaller bundle builds a venv with pyinstxtractor-ng in `~/.cache/anti-bla/pyxvenv` (`ANTI_BLA_PYXVENV` moves it). Each build needs the network once. Cleaning a `.pyc` needs a `python3.X` on `PATH` that matches the file's version.

For the tests, run `bun install` at the repo root, then `bun test`.

## Run

```bash
bun skills/anti-bla/scripts/scan.ts <target>            # score 0-100, reads only
bun skills/anti-bla/scripts/run.ts <target> --work /tmp/w --rea "rea analyze-javascript-application {target}"
bun skills/anti-bla/scripts/run.ts <target> --work /tmp/w --rea "..." --coverage   # plain JS or Python source
bun skills/anti-bla/scripts/runtime-guard.ts <target>   # JS, Electron main or .asar: run with and without inspector signals, report what differs
```

`run.ts` scans, cleans a copy, runs REA under the caps and retries once on a capacity error.

REA runs call the skill on these triggers:

- a REA capacity error (`budget exceeded`, `conservatively bounded`, ASAR header or index limit, fuse sentinel limit),
- words such as `enclave`, `attestation`, `TPM`, `vsock` or `hardware-sealed` in findings,
- `.blarc`, `.blarc.json`, `bla.config.json` or `.bla-manifest.json` in the target.

Tools: `scan`, `sanitize`, `fold-js`, `coverage`, `runtime-guard`, `guard`, `run`, `bench`. See [docs/architecture.md](docs/architecture.md). Rules for the agent: [skills/anti-bla/SKILL.md](skills/anti-bla/SKILL.md).

## BLA techniques it handles

| BLA technique | ReClarity answer |
| --- | --- |
| JS budget traps (opaque predicates, getter rings) | Fold in a copy, drop unrun branches |
| Shadow logic, honeypots, evidence lures | Plain JS only: an observation needs a run hit (`coverage`, not for ASAR) |
| Obligation flood | Fixtures for covered code only (plain JS) |
| Call-graph maze, crash lures | Cut clusters that no entry reaches |
| Electron IPC decoys | Plain JS only: keep channels that fire (`coverage`, not for ASAR) |
| ASAR header and fuse flood | Raise `REA_ASAR_MAX_HEADER_BYTES`, strip decoy entries and sentinels |
| SQLite honey tables, model nesting breaker, PCAP flood, EVM filler, Flutter pool decoys | Clean copy per format: drop BLA's entries, keep real content (`sanitize`) |
| WASM, Go, Rust, BEAM caps | `sanitize.ts` writes a clean copy: alias exports and decoy sections, Go build-info plant, BLA native trailer, decoy rustc paths, BEAM decoy chunks and atoms |
| Runtime guard (CDP, Frida, `--inspect`) | `runtime-guard.ts` runs the build in the sandbox with nothing attached, then once per inspector signal, and reports the output, IPC, file and code-path differences. The not-attached run is the observation |
| Python tarpit in `.py` source (decoy defs, opaque guards, chaff) | `coverage.py` in the sandbox; only BLA-shaped defs that never ran and no live code names are dropped (`coverage.ts`) |
| Python `.pyc` decoy code objects and honey trailer | Unreferenced BLA-shaped code objects and the trailer are dropped from a copy (`sanitize.ts`, `lib/pycclean.py`) |
| PyInstaller bundle (onefile or onedir) | Unpack in the sandbox with pyinstxtractor-ng, clean each `.pyc` as above, write a folder of the unpacked files, not a rebuilt bundle (`sanitize.ts`). Decoys woven into `.py` source before bundling stay: clean the `.py` files first |

Full table: [docs/techniques.md](docs/techniques.md). Risks: [docs/risks.md](docs/risks.md).

## Proof

[docs/proof.md](docs/proof.md) has the A/B/C runs on a BLA 3.1.0 hardened sample app. On that run, plain REA failed on the hardened ASAR (ASAR header limit), and the cleaned copy restored the analysis. That ASAR run is older than the latest fold rules and was not repeated. The other sections (data formats, WASM, Go, Rust, BEAM, Python, PyInstaller) are single runs on real BLA output. The proof also lists what ReClarity does not fix.
