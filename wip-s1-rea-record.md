# ReClarity S1 (key 1 reader) - work notes, paused 2026-11-28

Pause order from firstmate (inbox 001.msg): usage almost out. Commit WIP, push, `paused:`, stop.
No code is written yet. This file holds everything the investigation found, so a new session can continue.

## Paths

- Worktree: `/sdc-disk/host-data/administrator/.treehouse/reclarity-9827e4/2/reclarity`, branch `fm/reclarity-st-s1-rea-record`, base `c35380b` (main).
- Task data dir (scratch and proof, outside the worktree): `/sdc-disk/host-data/administrator/.treehouse/firstmate-8bf1b0/2/firstmate/data/reclarity-st-s1-rea-record/` (`$D` below).
- Plan: `/sdc-disk/host-data/administrator/.treehouse/firstmate-8bf1b0/2/firstmate/data/reclarity-smart-trigger-plan/report.md` (sections 1, 2, 3, 5, 7; "Key 1 fields for slice S1" at the end).
- Owned files only: `skills/anti-bla/scripts/rea-record.ts` (new), `skills/anti-bla/scripts/guard.ts` (changed to use it), ONE test under `skills/anti-bla/tests/`. Touch no other file.
- PR: "Refs #54" (never "Closes"). Exact export name and type at the top of the PR body. Before and after. ASD-STE100. Proof: reader run on real REA 6.10.1 output, records pasted.
- `bun install --frozen-lockfile` was run in the worktree (node_modules is gitignored).

## Tools installed in scratch (keep them)

- Real REA: `$D/reabin/node_modules/.bin/rea` = `rea-agents@6.10.1` from npm (248 MB, frida binding rebuilt).
- Real BLA: `$D/blabin/node_modules/.bin/bla` = `bla-agents@3.6.1` from npm.
- Run them with `HOME=$D/home XDG_CACHE_HOME=$D/home/.cache XDG_CONFIG_HOME=$D/home/.config` so that they write nothing outside `$D`.
- REA writes progress JSON lines to stderr and the document to stdout. It writes nothing next to the target.
- REA bundles `@toon-format/toon` 2.3.1 (spec v3.3). Readable source: `$D/reabin/node_modules/rea-agents/node_modules/@toon-format/toon/dist/index.mjs` (2066 lines). Exports `decode`, `decodeFromLines`. Not a ReClarity dependency: do not add it. Use it in scratch only, to cross-check.

## Real outputs on disk (`$D/out/`)

| File | Input | Time | Size | Result |
| --- | --- | --- | --- | --- |
| `plain.json` | `docs/benchmark/fixtures/app` copied to `$D/out/app-plain`, `--json` | 4.7 s | 771,713 B | exit 0, 2 sources `complete`, limits `[]` |
| `plain.toon` | same, no `--json` | 5.2 s | 1,002,731 B | same |
| `bla361.json` | `app-bla` = copy of the app after `bla harden . --seed s1-fixture` | 58 s | 75,111,212 B | exit 0, 2 `limited`, 2 `complete` |
| `bla361.toon` | same, no `--json` | 57 s | 97,240,680 B | same |

- `bla harden .` 3.6.1 writes a partial mirror `.bla-hardened/src/*` and leaves the sources unchanged. REA read both.
- Inspect dumps: `$D/out/inspect-plain.txt`, `inspect-toon.txt`, `inspect-bla361.txt`, `inspect-bla361-toon-ctx.txt`.

## Findings: JSON form (`--json`)

- Output is MINIFIED. No line-based reading is possible. A streaming tokenizer is needed.
- Top-level keys of a success: `evidence_id, evidence_format, subject, provider, analysis_profile, predicate_type, operation, parameters, raw_result, normalized_result, confidence, authority, environment, limitations, relationship_coverage, locations, evidence_links`.
- `normalized_result` keys: `format, graph, input_path, integrity_contradictions, inventory_graph_sha256, inventory_manifest_id, limitations, root_artifact_sha256, route_inventory, semantic_graph, statistics, summary`.
- Size on the BLA build: `semantic_graph` 74.7 MB, `graph` 378 KB, all other keys under 5 KB. Longest string anywhere: 114,688 chars.
- Key 1 path (confirmed): `normalized_result.graph.nodes[i].observations[j].properties.analysis_coverage.examination`. Only source nodes carry `analysis_coverage` (others have no such key). A node has up to 4 observations on the BLA build, so read ALL observations, not only `[0]`.
- `examination.status` is `"complete"`, `"limited"` or (plan P13) `"not-examined"`.
- `examination.semantic_resource_limits` is an ARRAY OF STRINGS: `["alias-selections","primitive-bytes","primitive-candidates"]` or `[]`.
- `limited` also sets `electron_call_paths_limited: true` and adds `controls[4]` (objects). `rea-env.md` calls these limits not tunable. Not needed for the record.
- `limitations` (top level, `normalized_result`, `graph`) is an array of REA text. `coverage` objects (`status, truncated, omitted_count, limits`) are everywhere. Neither is in the plan's key 1 fields.

## Findings: toon text form (no `--json`)

- Indent 2 spaces per level. `key: value`, `key:` (block), `key[N]:` (list, items `- `), `key[N]: a,b,c` (inline primitive array), `key: []`, `key[N]{f1,f2}:` plus rows `v1,v2` (tabular array).
- A list item `- label: x` puts its first key 2 columns after the hyphen; the other keys of that item sit at that same column.
- Key 1 in toon (confirmed, `$D/out/inspect-bla361-toon-ctx.txt`):
  - `status: limited` and `semantic_resource_limits[3]: alias-selections,primitive-bytes,primitive-candidates`
  - or `semantic_resource_limits: []`
  - then `controls[4]{...}:` with 4 tabular rows, which a line reader must skip as data rows.
- Grammar of `@toon-format/toon` 2.3.1, read from its source:
  - NO multi-line block strings. `encodeStringLiteral` gives a bare string or `"..."` with `\n` escaped. Every line boundary is structural.
  - A bare string has no `:`, `"`, `\`, `[ ] { }`, control char, comma; does not start with `-`; is not `true`, `false`, `null` or number-like.
  - Depth is `indent / 2`. A block under `key:` at depth D has its fields at depth D+1. List items are at depth D+1; the keys inside an item count as depth D+2.
  - A line with no unquoted colon is not a key line. At the root this is an error (`Top-level document must start with a key-value or array-header line`).
  - Unknown so far: key folding (`a.b: 1`). The real outputs show none (`subject:` then `identity:` on separate lines). Check `resolveOptions` in the toon source before a path reader relies on it.
- Target strings can hold a copy of REA's limit line only inside a quoted single-line value (newlines are escaped). The reader must find fields by path, so such a copy must not count.

## Not done yet (open questions)

1. Refusal output in both forms from a real ASAR with a header over 16 MiB (plan P8: `code: truncated`, `details.admission: asar-header`, `details.limit.setting: asar.max_header_bytes`, `effective_value` 16777216, `required_value` 25785176). Build the ASAR with `buildAsar` from `skills/anti-bla/scripts/lib/asar.ts` in scratch (long paths, 17 MB or more). Check whether the text form has `details` lines or only `error:`, `code:`, `message:`.
2. Shape of `not-examined` (plan P13: react-dom development build). Not run.
3. Toon: does the text error envelope parse as toon? Does REA fold keys?
4. Fixture sizes for the committed test. 75 MB and 97 MB cannot be committed. Try a much smaller input (one tiny file hardened by BLA 3.6.1, lowest intensity) and see if REA still says `limited` with a small output. Keep fixtures small.
5. How `guard.ts` must use the reader. Facts:
   - `isReaCapacityError(exitCode, stdout, stderr)` is called with STRINGS by `run.ts` (not owned) and `bench.ts` (not owned). Its signature cannot change in S1.
   - It returns false for exit 0 before it reads stdout. It reads stderr with the `CAPACITY` regex, the text envelope on stdout (`^error: `) with the same regex, and the JSON error by `code`.
   - `guard.test.ts` (not owned) pins: text envelope with `code: truncated` is true; the same under a `report` line is false; JSON `{"error":"x","message":"ASAR header/index admission is limited to 16 MiB"}` with exit 1 is true. A path-based reader does not know that JSON shape (no `code`). Decide on resume: keep that branch as it is, or change the test (ask firstmate, because the file is not owned).
   - Candidate: the one export takes a file path for the 72 to 94 MB case and also the text itself, so that `guard.ts` needs no temp file. Not decided.
6. Reader design candidate: one export `readReaRecord(path)`, synchronous, chunked `readSync`. JSON: streaming tokenizer with a path stack; toon: line reader with a frame stack (object, list, item, table). Both feed the same wanted-path list. A malformed document gives no record (no limit hit). Cap the captured bytes.

## Status file and inbox

- Status file: `/sdc-disk/host-data/administrator/.treehouse/firstmate-8bf1b0/2/firstmate/state/reclarity-st-s1-rea-record.status`
- Inbox: `/sdc-disk/host-data/administrator/.treehouse/firstmate-8bf1b0/2/firstmate/state/reclarity-st-s1-rea-record.inbox` (`001.msg` handled: the pause order).
- On resume: read the inbox first, then this file.
