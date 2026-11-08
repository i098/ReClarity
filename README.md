# ReClarity

**Anti-BLA.** A skill and toolkit that keeps [REA](https://github.com/morluto/rea) working on builds that [BLA](https://github.com/qybaihe/bla) has hardened.

> Status: JavaScript and Electron work. Other formats come after the A/B/C proof. Progress is in the issues.

## What it does

BLA makes a build hard to read for an AI agent. It plants decoy code, floods REA's fixed limits, and adds clean-looking shadow logic. BLA must keep the program behavior the same. ReClarity uses that rule:

- **Scan** the build for BLA trap shapes before the first REA call. Score 0 means plain REA, with no extra cost.
- **Clean a copy.** Fold opaque predicates, drop decoy entries, strip fuse flood. The original stays unchanged.
- **Check by running.** Run the build in a sandbox with coverage. Code that never runs is "not run". Only unreferenced never-run code that carries trap words is a "decoy suspect", never evidence.
- **Guard the budget.** Hard token and time caps per target. One retry after a REA capacity error. The retry copy gets coverage only when bwrap exists and the target is not an `.asar`. If it has the same bytes as the first copy, the retry is skipped and the report says why. The same bytes are never retried.

## Quick start

```bash
bun install                                              # at the repo root, for the tests
bun install --cwd skills/anti-bla                       # pins acorn for the skill
bun skills/anti-bla/scripts/scan.ts <target>            # score 0-100, reads only
bun skills/anti-bla/scripts/run.ts <target> --work /tmp/w --rea "rea analyze-javascript-application {target}"
```

Install the skill by copying `skills/anti-bla` into your agent's skills folder, then run `bun install` inside it. REA runs call it on these triggers:

- a REA capacity error (`resourceLimits`, ASAR header, fuse sentinel limit),
- words such as `enclave`, `attestation`, `TEE` in findings,
- `.blarc`, `bla.config.json` or `.bla-manifest.json` in the target.

Tools: `scan`, `sanitize`, `fold-js`, `coverage`, `guard`, `run`. See [docs/architecture.md](docs/architecture.md).

## BLA techniques it handles

| BLA technique | ReClarity answer |
| --- | --- |
| JS budget traps (opaque predicates, getter rings) | Fold in a copy, drop unrun branches |
| Shadow logic, honeypots, evidence lures | Plain JS only: an observation needs a run hit (`coverage`, not for ASAR) |
| Obligation flood | Fixtures for covered code only (plain JS) |
| Call-graph maze, crash lures | Cut clusters that no entry reaches |
| Electron IPC decoys | Plain JS only: keep channels that fire (`coverage`, not for ASAR) |
| ASAR header and fuse flood | Raise `REA_ASAR_MAX_HEADER_BYTES`, strip decoy entries and sentinels |
| WASM, SQLite, model, Go, Rust, BEAM caps | Planned: clean copy per format (after JS and Electron) |
| Runtime guard (CDP, Frida) | Planned: compare attached and not attached runs |
| Python `.pyc` tarpit | Planned: `coverage.py` in the sandbox |

Full table: [docs/techniques.md](docs/techniques.md). Risks: [docs/risks.md](docs/risks.md).
