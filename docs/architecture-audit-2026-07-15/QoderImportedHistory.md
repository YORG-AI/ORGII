# Architecture audit: Qoder imported history

## Acceptance criteria

- Detect Qoder CLI and IDE-companion transcript stores on supported desktop platforms.
- Import metadata, messages, reasoning, tool calls/results, diffs, token totals, and subagent linkage without mutating Qoder data.
- Reuse shared imported-history cache, pagination, source stats, recent paths, rescan, Kanban, Spotlight, and SessionCore replay paths.
- Keep clear/rescan and cache invalidation source-scoped.

## Ten-layer audit

| Layer                                     | Coverage                                                                    | Result                                                                                                                                                                                 |
| ----------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Compilation correctness                | Core parser, Tauri commands/registry, TypeScript descriptors and loaders    | Eight Qoder/cache tests, 38 frontend tests, and `cargo check -p org2` pass.                                                                                                            |
| 2. Dead code and structural deduplication | Discovery, cache, pagination, stats, replay                                 | Qoder-specific code only parses its disk schema; shared imported-history helpers own delta sync, queries, rescan, and wire models. One candidate resolver serves detection and import. |
| 3. Naming consistency                     | `qoder`, `qoderapp-`, `SOURCE_QODER`, icon ID, command names                | IDs are consistent across Rust, Tauri, TypeScript, tests, fixtures, and docs. Raw source IDs remain unprefixed in cache signatures.                                                    |
| 4. Semantic overloading                   | Primary sessions, subagents, ORGII session IDs                              | Primary Qoder IDs and composite child IDs are distinct; only ORGII-facing IDs receive `qoderapp-`. Qoder config JSONL outside the transcript layouts is not treated as history.        |
| 5. Default branch analysis                | Missing directories/fields, invalid JSON, unknown tools, timestamp forms    | Missing stores return empty results; invalid lines are skipped; unknown tools preserve payloads; explicit metadata fallback order covers absent titles/models/timestamps.              |
| 6. Cross-domain concept leakage           | Qoder schema versus generic import contracts                                | Qoder JSONL field knowledge and tool normalization stay under `sources/qoder`; generic cache and UI registries remain provider-neutral.                                                |
| 7. New-developer confusion                | Module docs and architecture note                                           | Both observed primary layouts, IDE paths, subagent keys, metadata precedence, cache semantics, and privacy limits are documented.                                                      |
| 8. Wire protocol and serialization        | Anthropic-style JSONL blocks, tool sidecars, Tauri payloads                 | Parser accepts text or block arrays, pairs call IDs, and emits existing `ActivityChunk` / imported-session shapes. Fixtures include malformed-line tolerance and structured patches.   |
| 9. Init parity                            | Detection, list, replay, recent paths, stats, rescan, Spotlight, Kanban     | Qoder is registered at every existing imported-history entry point; no parallel initialization route was introduced.                                                                   |
| 10. Resolver symmetry                     | Candidate path → cache source → session prefix → frontend descriptor/filter | Candidate and prefix functions are shared/tested; registry tests cover source/category/prefix/replayability, and disabled-source tests cover sidebar gating.                           |

## Entry-point parity matrix

| Entry point                      | Qoder registration                                               |
| -------------------------------- | ---------------------------------------------------------------- |
| Local source detection           | `external_cli_detection` source spec + shared candidate resolver |
| Metadata list/sidebar pagination | `EXTERNAL_HISTORY_SOURCE_LOADERS` → Qoder paginated loader       |
| Session replay                   | `qoder_history_chunks` → SessionCore imported-history dispatch   |
| Recent repositories              | `qoder_recent_paths` → Spotlight aggregate                       |
| Data Sources stats/rescan        | imported descriptor + source-scoped shared cache operations      |
| Kanban filtering/icon            | descriptor-derived filter + `qoder` model icon                   |

## Fallback matrix

| Missing/unknown input        | Behavior                                          |
| ---------------------------- | ------------------------------------------------- |
| Qoder directory absent       | Empty discovery result; other sources continue    |
| One malformed JSONL line     | Skip line; retain valid records in the file       |
| Missing title metadata       | First user prompt, then source session ID         |
| Missing event timestamp      | File modification time                            |
| Unknown tool                 | Normalized tool name with raw JSON args/result    |
| Missing matching tool result | Tool chunk with empty result, preserving the call |

## Deliberately skipped

| Area                                                | Reason                                                                                     |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Launching or controlling Qoder                      | #365 is local history import; live CLI execution has a different lifecycle/security scope. |
| Cloud history APIs                                  | No local read-only contract and would introduce authentication/privacy changes.            |
| Recursive import of arbitrary `~/.qoder/**/*.jsonl` | Would risk treating config, hooks, or unrelated logs as sessions.                          |
| Qoder source mutation/migration                     | Imported history is strictly read-only.                                                    |

## Verification

- `cargo test -p orgtrack_core qoder --lib`
- `cargo test -p orgtrack_core qoder_clear_and_rescan_pruning_does_not_touch_other_sources --lib`
- `cargo test -p org2 qoder_probe --lib`
- `cargo check -p org2`
- Six frontend registry/routing/pagination/sidebar suites: 38 tests passed.
- Full TypeScript checking reaches one unrelated existing error in `ContextInfoButton.tsx:468`; no Qoder file reports an error.
- Targeted Prettier, ESLint, and `git diff --check` are part of the final verification pass.
