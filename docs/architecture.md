# Architecture

![ReClarity flow: scan, sanitize, fold, coverage, REA, with guard caps](architecture.svg)

Source: [architecture.mmd](architecture.mmd). Re-render with `ondine docs/architecture.mmd`.

| Step | Tool | Writes |
| --- | --- | --- |
| Scan | `scripts/scan.ts` | JSON report; reads only |
| Sanitize | `scripts/sanitize.ts` | clean copy (ASAR, fuses, config files) |
| Fold | `scripts/fold-js.ts` | copy with folded predicates and pruned dead code |
| Coverage | `scripts/coverage.ts` | JSON live set; optional copy plus `<copy>.quarantine.json` beside it |
| Guard | `scripts/guard.ts` | `ledger.json`: tokens, start time, tried input hashes, retry flag |
| Wrapper | `scripts/run.ts` | work folder with `a-*` and `b-*` copies, JSON run report |
| Bench | `scripts/bench.ts` | A/B/C arms on one app; JSON bench report |

`scripts/lib/` holds the parts the tools share: `asar.ts` (read and write the Chromium pickle header), `fuses.ts` (fuse wire), `js.ts` (parse, seed discovery, tiny evaluator), `prune.ts` (reachability).
