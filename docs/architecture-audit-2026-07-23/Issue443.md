# Issue #443 architecture audit

Scope: bounded replay for all built-in imported-history sources, managed CLI mirrors, replay consumers, SQLite turn-index projection, and the native-SDE isolation boundary.

## Ten-layer review

| Layer                        | Evidence checked                                                                                                                                    | Verdict                                                                                                                                                                       |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Compilation and contracts | Rust/TS wire schemas, targeted `cargo check`, typecheck, serialized compatibility tests                                                             | Pass. Workspace `cargo check`, typecheck, lint, circular-dependency check, full Vitest, and scoped pre-commit clippy completed.                                               |
| 2. Old/dead paths            | Global caller sweep for `loadFullTranscriptChunks`, `supportsWindowedReplay`, `cursorIdeFullRefresh`, `cli_agent_chunks`, and provider full loaders | Pass; production callers are zero. Removed the remaining Cursor full-refresh API. Legacy provider loaders remain only as parser/test compatibility surfaces.                  |
| 3. Naming consistency        | `ReplayCursor`, generation/revision, source/session identity, descriptor/payload naming                                                             | Pass                                                                                                                                                                          |
| 4. Semantic overloading      | Core descriptor encoding versus app `PayloadRefEncoding`; EventStore hydration modes                                                                | Pass after making generation resets use `set_external_replay_window`. The two encoding enums intentionally separate persistent-core compatibility from the public event wire. |
| 5. Defaults and fallbacks    | Unknown source routing, missing adapter behavior, legacy cached payload descriptors, watcher fallback                                               | Pass. Unknown built-ins fail closed; only old cached descriptors may infer encoding. Watcher failure returns the typed active/visible bounded poll fallback.                  |
| 6. Domain boundaries         | Native SDE versus imported/managed CLI, collaboration snapshot secondary reads                                                                      | Pass. Native adapters never resolve the primary replay target; Rust validates identities before creating watcher/request state.                                               |
| 7. Registry clarity          | Rust authoritative 15-source registry, TS metadata mirror, managed native transcript remap                                                          | Pass after centralizing an exhaustive compile-time storage-driver classifier shared by sync and payload reads.                                                                |
| 8. Wire and memory bounds    | 10 turns, 200 events, 4 MiB IPC, 256 KiB payload ranges/cloud segments, EventStore byte cap                                                         | Pass in code, wire tests, deterministic 30/300 MiB performance tests, a 3.0 GiB real SQLite DB migration, and the 335 MiB Issue 272 Codex JSONL core acceptance test.         |
| 9. Entry-point parity        | Open, poll, older/seek, prewarm, metadata/hover, provenance, Fork, Cloud, Raw Transcript, JSON/Markdown export                                      | Pass. Background/read-only consumers use compact indexes or bounded scans and do not acquire foreground watchers.                                                             |
| 10. Resolver symmetry        | Source/session validation, public-to-native cursor remap, generation/revision pinning, reset/release/late-result guards                             | Pass. Sync and payload range now share the same exhaustive driver routing.                                                                                                    |

## Findings fixed during the audit

| Severity | Finding                                                                                                                | Resolution                                                                                             |
| -------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| P1       | A replay generation reset called generic `EventStore::set`, marking a bounded suffix as fully hydrated.                | Use `set_external_replay_window` and assert `HydrationMode::RoundWindow`.                              |
| P1       | Driver dispatch used guarded matches plus runtime catch-alls, so a future source could compile without a real adapter. | Added exhaustive `replay_driver_kind` and a storage-family contract test.                              |
| P2       | Cursor IDE's unused `load_full_refresh_for_session` production API remained after consumer migration.                  | Removed the type/function; retained the single-bubble parser used by SQLite/KV replay.                 |
| P1       | Payload meaning was inferred from a dotted field path and array export recursion reused the parent path.               | Added explicit encoding/body projection and indexed array paths, with legacy-cache compatibility only. |

## Acceptance boundary

- All 15 built-in sources must stay `Incremental` and route through the exhaustive driver classifier.
- A native SDE session must make zero external replay calls and retain its existing EventStore/FSM behavior.
- No renderer API may expose a built-in full-transcript loader.
- Completed evidence includes 6,063 Vitest tests, 446 `orgtrack_core` tests, 401 event-pipeline tests, 3,086 `agent_core` tests, the #425 ignored RSS stress, streamed 327 MiB export hash verification, bounded 30→300 MiB growth, and first-open/reopen of the real DB.
- The Issue 272 core run parsed 52,477 rows from a 335 MiB JSONL into a 200-event/10-turn window, then performed an unchanged poll and reopen with zero parsed bytes.
- Final delivery still requires the rendered five-cycle Issue 272 app run after the latest `develop` merge. The live dual-instance sharing/presence smoke remains an external credential gate because no `E2E_CLOUD_*` test credentials are configured.
- Workspace-wide clippy still reports two pre-existing findings outside this change (`perf_utils` duplicate test module and `usage_dashboard::usage_overview` argument count); scoped clippy for every package changed by this implementation passes.
