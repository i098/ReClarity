# Technique table

Each BLA trap, how ReClarity sees it, how it cleans it, and the REA step it protects. Shapes are pinned to BLA 3.1.0; the long form with weights is in [signatures.md](../skills/anti-bla/references/signatures.md).

JS, Electron, SQLite, models, PCAP, EVM and Flutter are built. The other formats are listed so the gap is visible.

| BLA technique | REA step it hits | Seen by (`scan.ts`) | Cleaned by | Status |
| --- | --- | --- | --- | --- |
| Opaque predicates on a seed constant | `analyze_javascript_application` (all JS limits) | `opaque_predicate` | `fold-js.ts` folds predicates that give one answer for every seed value, drops the dead branch | built |
| Decoy clusters kept alive by `void [...]` | JS call graph | `keepalive_array` | `fold-js.ts` removes declarations no live code reaches, and literal-argument calls to sink functions (no `this`, `throw`, loop, member access, recursion or call to a non-sink; only own locals and private state) | built |
| Ternary chunk strings | `primitive-candidates` (256) | `ternary_chunks` | `fold-js.ts` folds the chunk conditions | built |
| String doubling | `primitive-bytes` (1 MiB) | `string_doubling` | `fold-js.ts` removes the unread doubling chain | built |
| Getter rings | `getter-expansion` (512) | `getter_ring` | Removed when unreached | built |
| Selector pyramid | `alias-selections` (512) | `selector_pyramid` | Removed when unreached | built |
| Shadow logic, honeypots, evidence lures | Evidence contract | `bait_text`, `enclave_words` | Plain JS only (`coverage.ts` does not cover ASAR). `coverage.ts`: not run and unreferenced and trap words = decoy suspect, quarantined. Ran but carries trap words = `bait_ran`, listed, never an Observation | built |
| Obligation flood | Reconstruction obligation ledger | none (it is in REA output) | `guard.ts` `fixtureTargets`: fixtures for `run` statements only, at most 200 | built |
| Electron IPC decoys | IPC pairing | `decoy_ipc` | Plain JS only (`coverage.ts` does not cover ASAR). Kept by `coverage.ts` when the channel fires; suspect when not run and trap-worded | built |
| ASAR header flood | `REA_ASAR_MAX_HEADER_BYTES` (16 MiB) | `asar_header_flood` | `sanitize.ts` drops flood entries (long path, tiny body); `reaEnv` names the limit that reads the original | built |
| Fuse decoys | sentinel limit (32 per slice) | `fuse_decoy` | `sanitize.ts` zeroes decoy sentinels (wire byte `9`); real blocks stay | built |
| BLA config files | none | `config_file` | `sanitize.ts` drops them from the copy | built |
| Embedded source map with bait text | JS evidence | none | `fold-js.ts` strips the `sourceMappingURL` data URL after folding | built |
| SQLite honey tables and `GENERATED ... VIRTUAL` trap columns | `inspect_sqlite_database` | `sqlite_honey` | `sanitize.ts` (`lib/sqlite.ts`) drops BLA's five honey tables and its view, only when name and full column list match; vacuums the copy; a database with a live `-wal` or `-journal` is copied unchanged | built |
| Model JSON nesting (safetensors, GGUF) | `inspect_model_artifact` (nesting 32) | `model_nesting_breaker` | `sanitize.ts` (`lib/model.ts`) removes the extra descriptor key (or the GGUF key) that is deeper than 32 and holds BLA's literal note, and the `enclave.*` bait entries; tensor bytes are copied unchanged | built |
| PCAP flood | `inspect_pcap_capture`, tshark JSON (8 MiB) | `pcap_flood` | `sanitize.ts` (`lib/pcap.ts`) drops frames whose whole shape is BLA's; real frames stay byte for byte; classic libpcap only (BLA 3.1.0 does not write pcapng) | built |
| EVM trailer and JUMPDEST filler | `inspect_evm_interface` (4 MiB input) | `evm_trailer` | `sanitize.ts` (`lib/evm.ts`) removes BLA's metadata and the filler run; raw and hex carriers | built |
| Flutter pool and snapshot-hash decoys | `identify_flutter_build` (64 hashes) | `dart_pool_decoy` | `sanitize.ts` (`lib/dart.ts`, `lib/zip.ts`) zeroes the decoy ranges in a native binary or in `libapp.so` inside an APK (the copy of an APK has no signature) | built |
| WASM, Go, Rust, BEAM caps | format inspectors | not yet | not yet | planned |
| Runtime guard (CDP, Frida, `--inspect` detection; self-seal `NODE_OPTIONS` digest) | runtime capture | `runtime_guard` (BLA's own markers: `inspectorObserved`, `cdpShapeBudgetGuard_`, `fridaCaptureSaturator_`, `__puppeteer_evaluation_script__`) | Not cut from the copy. `runtime-guard.ts` runs each entry in the sandbox with nothing attached (twice, to find what varies) and once per probe (`inspect`, `node-options`, `remote-debugging`, `cdp`, `frida`). It reports every channel that differs (stdout, stderr, exit, files, IPC, children, connects, added globals) and the code that ran in only one run. The not-attached run is the observation | built |
| Python `.pyc` tarpit | PyInstaller route | not yet | `coverage.py` in the sandbox | planned |

## What stays

A clean copy keeps everything it cannot prove dead:

- Code that only runs on rare input is "not run". It is kept.
- Not-run code that carries trap words but that kept code still names is kept.
- Code that ran is kept, bait words or not. It is marked `bait_ran`, so it never counts as an Observation. The one exception is a sink call that `fold-js.ts` proves has no effect (see the table); on the real BLA fixture none qualifies.
