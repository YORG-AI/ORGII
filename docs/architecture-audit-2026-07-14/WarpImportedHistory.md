# Architecture audit: Warp imported history

## Acceptance criteria

- Detect Warp's local database on supported desktop platforms.
- Import list metadata and replayable user, assistant, reasoning, model, and tool events without mutating Warp data.
- Reuse the shared imported-history cache, aggregation, recent-path, sidebar, replay, and source-rescan pipelines.
- Keep Warp Agent history distinct from the separate Warp CLI/TUI integration.

## Ten-layer audit

| Layer                                     | Coverage                                                                                       | Result                                                                                                                                                                                                    |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Compilation correctness                | Core crate, Tauri command registration, TypeScript source registry and filters                 | Targeted Rust and frontend tests pass. The complete `org2` desktop crate compiles.                                                                                                                        |
| 2. Dead code and structural deduplication | Database discovery, Kanban source mapping, imported cache                                      | One shared Warp path resolver feeds both detection and import. One shared source→Kanban map replaces two former copies.                                                                                   |
| 3. Naming consistency                     | `warp`, `warpapp-`, `SOURCE_WARP`, command names, icon ID                                      | Source IDs and prefixes are consistent across Rust, Tauri, TypeScript, tests, and docs. `warpapp-` identifies imported app history; it is not a CLI-agent ID.                                             |
| 4. Semantic overloading                   | Warp conversation IDs, ORGII session IDs, Warp terminal sessions                               | Source IDs remain raw conversation IDs in cache keys; only ORGII-facing IDs receive `warpapp-`. Terminal restoration data is not presented as Agent conversation history.                                 |
| 5. Default branch analysis                | Unknown protobuf messages/tools, missing summary, missing timestamps                           | Unknown tools preserve raw names/payloads. Missing optional data uses explicit fallback order; missing schema or malformed tasks returns an empty/safe result.                                            |
| 6. Cross-domain concept leakage           | Warp parser versus shared import infrastructure                                                | Warp schema/protobuf knowledge is isolated under `sources/warp`; generic cache/query/replay contracts remain source-neutral.                                                                              |
| 7. New-developer confusion                | Module docs, storage note, constants                                                           | The storage schema, paths, mappings, fallbacks, privacy limits, and #331 boundary are documented in `docs/architecture/warp-imported-history.md`.                                                         |
| 8. Wire protocol and serialization        | Official Warp protobuf descriptor, JSON projection, Tauri payloads                             | Uses Warp's pinned published descriptor rather than a hand-copied proto. Outputs existing `ActivityChunk` and imported-session wire types. Fixture tests exercise protobuf encode/decode and SQLite rows. |
| 9. Init parity                            | Sidebar list, replay, recent paths, source stats, rescan aggregation, spotlight, Kanban filter | Every existing imported-history entry point has a Warp registration. No separate partial initialization path was introduced.                                                                              |
| 10. Resolver symmetry                     | Detect path → source cache → list/replay command → frontend descriptor/filter                  | The same source ID/prefix/path candidates resolve end to end, with tests for paths, prefix round-trip, registry lookup, replayability, and filter mapping.                                                |

## Deliberately skipped

| Area                                         | Reason                                                        |
| -------------------------------------------- | ------------------------------------------------------------- |
| Warp CLI process launch and live TUI capture | Out of scope for #366; tracked by #331.                       |
| Cloud-history API                            | No local-import contract and would change privacy/auth scope. |
| Mutation or migration of `warp.sqlite`       | Imported history is strictly read-only.                       |

## Verification

- Six Rust fixture/schema/path/cache tests under `sources::warp::history::tests`.
- Frontend registry, replayability, session-dispatch, pagination, and Kanban mapping tests.
- `cargo check -p org2`.
- ESLint over every changed TypeScript/TSX file.
- Full TypeScript checking reaches one unrelated pre-existing error in `ContextInfoButton.tsx:468`; no Warp file reports a type error.
- `git diff --check`.
