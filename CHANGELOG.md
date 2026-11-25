# Changelog

This file follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and uses [Semantic Versioning](https://semver.org).

## [Unreleased]

### Fixed

- `fence.ts` capacity hint is a complete `run.ts` command with `--work` and `--rea`, rebuilt from the failed `rea` call when it names a configured target (refs #38). One live Claude Code session ran it; REA still failed on the cleaned copy because the 21.6 MB ASAR header stays above 16 MiB. See `docs/auto-trigger.md`.

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
