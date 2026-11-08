# REA settings that matter for BLA builds

Read from REA 6.8.0 (`src/domain/analysisSettingDefinitions.ts`, `src/domain/javascript/javascriptSemanticResourceLimits.ts`). Check the version you run.

## Tunable

| Setting | Default | Max | Use |
| --- | --- | --- | --- |
| `REA_ASAR_MAX_HEADER_BYTES` | 16 MiB | 256 MiB | A BLA flood puts 4000 long-path entries in the ASAR header (17 MiB on `bankrupt`). Raising this lets REA read the original. `sanitize.ts` prints the value to use in `reaEnv`. A clean copy needs no change. |
| `--analysis-timeout-ms` | 300000 ms | see REA | `rea analyze-javascript-application` option (setting `javascript.analysis_timeout_ms`). Raise it for a large decoy build only after the clean copy still times out. |
| `--max-heap-mb` | 1024 MiB | see REA | Same command (setting `javascript.max_heap_mb`). Same rule. |
| `REA_REGEX_MATCHING_DEADLINE_MS`, `REA_REGEX_WORKER_HEAP_REQUEST_MIB` | REA default | see REA | String and procedure search over a decoy-heavy native binary. |
| `REA_NATIVE_MATCHING_REPRESENTATION_BYTES` | REA default | see REA | Function matching. |
| `REA_GHIDRA_*`, `REA_HOPPER_*`, `REA_JADX_*` timeouts | REA default | see REA | Native and Android. Out of scope for JS and Electron. |

## Not tunable (constants)

These cannot be raised. The answer is a clean copy.

| Limit | Value | BLA shape that hits it |
| --- | ---: | --- |
| `primitive-candidates` | 256 alternatives | `ternary_chunks` (one string built from 9+ conditional pieces) |
| `primitive-bytes` | 1 MiB estimated JSON | `string_doubling` |
| `expression-depth` | 256 nested expressions | nested seed expressions |
| `getter-expansion` | 512 scheduled states | `getter_ring` |
| `alias-selections` | 512 additional selector states | `selector_pyramid` (4,194,304 states at `bankrupt`) |
| Electron fuse sentinels per slice | 32 | `fuse_decoy` (34 decoys beside the real block) |
| Safetensors JSON nesting, GGUF metadata array frames | 32 | `model_nesting_breaker` (depth 33+) |
| Flutter snapshot hash candidates | 64 (and 500 pool URIs, 2000 tokens) | `dart_pool_decoy` (66 fake records, 516 URIs) |
| EVM input | 4 MiB (a hex carrier counts its characters) | `evm_trailer` (JUMPDEST filler up to the limit) |
| tshark JSON for a capture | 8 MiB | `pcap_flood` (not reproduced as an error on the proof fixture, see `docs/proof.md`) |
| SQLite inspection | none hit on the proof fixture | `sqlite_honey` (REA lists the honey tables as schema) |

The messages these limits print are matched by `isCapacityError` in `scripts/guard.ts`.

## Run REA on a copy

`rea analyze-javascript-application <path>` reads an ASAR or an extracted application. Give it the path `run.ts` prints as `prepared`. `--integrity-policy record-and-continue` keeps REA going when a cleaned ASAR no longer matches its declared integrity; use it only on a copy and note it in the report.
