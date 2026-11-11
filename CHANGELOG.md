# Changelog

This file follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and uses [Semantic Versioning](https://semver.org).

## [Unreleased]

### Added

- `untrusted-repo-read` skill: `isolate.ts` writes a view copy where planted instructions in comment and doc spans become markers, plus `isolation.json`.
- `scan.ts` and `sanitize.ts` cover BLA 3.2.2 formats: DEX, IL2CPP, .NET, ZIP, APK, Bun sidecar and native headers.
- `fold-js.ts` removes BLA's decorative init block and shadow-heap churn calls. `pycclean.py` cleans tarpit bytecode and Python 3.7 and 3.8 `.pyc`.
- Open-source files: `LICENSE` (MIT), `setup.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, issue forms, PR template, `CODEOWNERS` and `dependabot.yml`.

## [0.1.0] - 2026-11-08

### Added

- `anti-bla` skill: scan, sanitize, fold-js, coverage, runtime-guard, guard, run and bench tools.
- Clean copies for JavaScript, Python (`.pyc`, PyInstaller), SQLite, models, PCAP, EVM and Flutter targets.
