# Technique table

Each BLA trap, how ReClarity sees it, how it cleans it, and the REA step it protects. Shapes are pinned to BLA 3.1.0; the long form with weights is in [signatures.md](../skills/anti-bla/references/signatures.md).

JS, Electron, Python, WASM, Go, Rust and BEAM are built. Other formats are listed so the gap is visible.

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
| WASM alias exports and decoy custom sections | `inspect_wasm_artifact` (interface budget, 32 MiB) | `wasm_export_flood`, `wasm_decoy_sections` | `sanitize.ts` drops alias exports of real functions (`enclave_export_*`, `bla_enclave_verify_*`) unless host JS names them, and `bla.*`, `enclave.attestation.*` and honey `name` sections. Code, types, imports and real exports stay byte for byte | built |
| Go build-info plant | `inspect_go_binary` (1 MiB build info, module framing) | `go_buildinfo_flood` (claim over 1 MiB, or `[BLA-GO-MAPPED]` marker) | `sanitize.ts` zeroes the planted header through the `[BLA-GO-MAPPED]` marker, at bankrupt and balanced intensity. BLA overwrote the real build info, so it is not recovered | built |
| Rust rustc hash flood, native shield trailer | `inspect_rust_binary` (64 rustc hashes) | `rustc_hash_flood`, `native_shield_trailer` | `sanitize.ts` cuts the appended `[BLA-NATIVE-SHIELD-V1]` trailer and zeroes decoy `/rustc/<hash>/library/core/src/enclave*.rs` hashes when over 64 | built |
| BEAM chunk flood and canary atoms | `inspect_erlang_beam` (64 chunks, 4096 atoms) | `beam_chunk_flood` | `sanitize.ts` drops chunks that start with `[BLA-BEAM-SHIELD]` and the canary atoms at the end of the atom table. Code, ExpT, ImpT and the atoms before the canary stay | built |
| SQLite, model, PCAP caps | format inspectors | not yet | not yet | planned |
| Runtime guard (CDP, Frida, `--inspect` detection; self-seal `NODE_OPTIONS` digest) | runtime capture | `runtime_guard` (BLA's own markers: `inspectorObserved`, `cdpShapeBudgetGuard_`, `fridaCaptureSaturator_`, `__puppeteer_evaluation_script__`) | Not cut from the copy. `runtime-guard.ts` runs each entry in the sandbox with nothing attached (twice, to find what varies) and once per probe (`inspect`, `node-options`, `remote-debugging`, `cdp`, `frida`). It reports every channel that differs (stdout, stderr, exit, files, IPC, children, connects, added globals) and the code that ran in only one run. The not-attached run is the observation | built |
| Python tarpit in `.py` source: decoy defs `<domain>_<hex4>`, shared slot and state int, warm-up call, opaque-false guards and slot touches woven into real defs | Python call graph and constants | `python_tarpit` (state int, slot and 3+ decoy defs) | `coverage.ts` runs the program under coverage.py in bwrap. A top-level statement goes only if its text matches a BLA shape, no live code in any file names it, and (for defs) its body never ran. Weave lines in real defs go when their decoys go | built |
| Python `.pyc` decoy code objects `<stem>_<1000-9999>` and honey trailer | `inspect_python_pyc` (trailing bytes error, 16384 objects) | `pyc_decoy_code`, `bait_text` | `sanitize.ts` runs `lib/pycclean.py` in bwrap with the interpreter that matches the magic. It drops code objects that have a BLA stem, no args or names, `(None,)` consts, and no bytecode reference, then the trailer of marshal strings. Other trailers stay. No coverage run: nothing references these objects, so they cannot run | built |
| PyInstaller bundle of hardened Python | `PyInstallerArtifactReader` | note only | not cleaned (limit): a frozen app has no source for coverage.py and its decoy defs are normal defs. Clean the `.py` files, then bundle | limit |

## What stays

A clean copy keeps everything it cannot prove dead:

- Code that only runs on rare input is "not run". It is kept.
- Not-run code that carries trap words but that kept code still names is kept.
- Code that ran is kept, bait words or not. It is marked `bait_ran`, so it never counts as an Observation. The one exception is a sink call that `fold-js.ts` proves has no effect (see the table); on the real BLA fixture none qualifies.
