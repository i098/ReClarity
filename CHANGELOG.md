# Changelog

This file follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and uses [Semantic Versioning](https://semver.org).

## [Unreleased]

### Fixed

- ASAR flood: when the header is over 16 MiB, `scan.ts` and `sanitize.ts` treat tiny entries (256 B or less) with repeated bytes (100 or more) as flood, and the cleaned copy drops them (refs #40). On the 21.6 MB sample the copy header went from 21662601 B to 12 B and REA finished (exit 0, verdict `ok`, 87 s); before, REA ran past the 1801 s cap. `run.ts` reports in its notes, per repeated group, the count, the size and the first 3 paths.
- `fence.ts` capacity hint is a complete `run.ts` command with `--work` and `--rea`, rebuilt from the failed `rea` call when it names a configured target (refs #38). One live Claude Code session ran it; REA failed on the cleaned copy because the 21.6 MB ASAR header stays above 16 MiB.
- `run.ts` runs REA with the `REA_ASAR_MAX_HEADER_BYTES` that `sanitize.ts` computes, and `isReaCapacityError` reads REA's text error on stdout. Before, REA's ASAR header error (text, on stdout) was not a capacity error. On the 21.6 MB sample REA then passed the header limit and did not finish in the 30 min cap. See `docs/auto-trigger.md`.

### Added

- BLA 3.5.x: `fold-js.ts` folds the digest seed (`const S = L | (F.length >= 0 && D === K ? 1 : 0)`) and its alias, and prunes the dead bindings; coverage cleaning removes the 3.5.x Python tarpit (base-36 name suffix, unannotated shared slot, builtins alias, prefixed honeypot names). On 3.5.9 samples `fold-js.ts` folded nothing before.
- `fold-js.ts` leaves a build unfolded when two or more JS files carry the `--self-seal` check (any fold made it throw) and reports `selfSealed`.
- `scan.ts` notes when a build uses shapes newer than the pinned BLA 3.2.2.
- `setup-clarity` installer registers `fence.ts` for `PostToolUseFailure`, so the fence sees failed REA calls.
- Live Claude Code check of the auto-trigger, with a hook log and a transcript in `docs/proof/`.
- `docs/benchmark/`: side-by-side harness (plain, LASIK, ReClarity) with raw results.
- `untrusted-repo-read` skill: `isolate.ts` writes a view copy where planted instructions in comment and doc spans become markers, plus `isolation.json`.
- `scan.ts` and `sanitize.ts` cover BLA 3.2.2 formats: DEX, IL2CPP, .NET, ZIP, APK, Bun sidecar and native headers.
- `fold-js.ts` removes BLA's decorative init block and shadow-heap churn calls. `pycclean.py` cleans tarpit bytecode and Python 3.7 and 3.8 `.pyc`.
- Open-source files: `LICENSE` (MIT), `setup.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, issue forms, PR template, `CODEOWNERS` and `dependabot.yml`.

## [0.1.0] - 2026-11-08

### Added

- `anti-bla` skill: scan, sanitize, fold-js, coverage, runtime-guard, guard, run and bench tools.
- Clean copies for JavaScript, Python (`.pyc`, PyInstaller), SQLite, models, PCAP, EVM and Flutter targets.
