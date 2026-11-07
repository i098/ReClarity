# ReClarity

**Anti-BLA.** A skill and toolkit that keeps [REA](https://github.com/morluto/rea) working on builds that [BLA](https://github.com/qybaihe/bla) has hardened.

> Status: under construction. JavaScript and Electron come first. Progress is in the issues.

## What it does

BLA makes a build hard to read for an AI agent. It plants decoy code, floods REA's fixed limits, and adds clean-looking shadow logic. BLA must keep the program behavior the same. ReClarity uses that rule:

- **Scan** the build for BLA trap shapes before the first REA call. Score 0 means plain REA, with no extra cost.
- **Clean a copy.** Fold opaque predicates, drop decoy entries, strip fuse flood. The original stays unchanged.
- **Check by running.** Run the build in a sandbox with coverage. Code that never runs is a "decoy suspect", never evidence.
- **Guard the budget.** Hard token and time caps per target. One retry on a cleaner copy after a REA capacity error.

## Quick start

```bash
bun install
bun run scan ./app            # trap score and findings, JSON
```

Add `skills/anti-bla` to your agent. REA runs then call the skill when they see a trigger:

- a REA capacity error (`resourceLimits`, ASAR header, fuse sentinel limit),
- words such as `enclave`, `attestation`, `TEE` in findings,
- `.blarc`, `bla.config.json` or `.bla-manifest.json` in the target.

## BLA techniques it handles

| BLA technique | ReClarity answer |
| --- | --- |
| JS budget traps (opaque predicates, getter rings) | Fold in a copy, drop unrun branches |
| Shadow logic, honeypots, evidence lures | An observation needs a run hit |
| Obligation flood | Fixtures for covered code only |
| Call-graph maze, crash lures | Cut clusters that no entry reaches |
| Electron IPC decoys | Keep channels that fire |
| ASAR header and fuse flood | Raise `REA_ASAR_MAX_HEADER_BYTES`, strip decoy entries and sentinels |
| WASM, SQLite, model, Go, Rust, BEAM caps | Clean copy per format (after JS and Electron) |
| Runtime guard (CDP, Frida) | Compare attached and not attached runs |
| Python `.pyc` tarpit | `coverage.py` in the sandbox |

Full table, risks and diagrams: [docs/index.md](docs/index.md).

## Use

Use ReClarity only on software you own or may analyze. Run target code only in the sandbox.
