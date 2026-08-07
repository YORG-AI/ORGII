# Architecture Audit — Orgtrack Round Metadata

**Scope:** Issues #387 and #388: per-round resource/development metadata, whole-session edit impact, and Kanban file search.

## Completion criteria

- [x] One Orgtrack projector owns per-round read/search/write/create/delete/rename observations.
- [x] The same projector owns modified-file line stats and development artifacts (commits/PRs).
- [x] ORG2, Claude Code, Codex, Cursor, and other normalized providers enter through the same tool metadata boundary.
- [x] `session_turns` is a rebuildable ORG2 read cache, not the semantic owner.
- [x] Historical rows rebuild lazily through a versioned index; existing DBs keep working.
- [x] Session, turn, and actor/execution-thread identities are not conflated.
- [x] The chat footer renders resource observations and edit/development metadata.
- [x] Kanban file search uses the whole-session edit projection without parsing transcripts per keystroke.
- [x] Session Blame pages by complete root-session groups and refreshes from a durable SQLite revision.
- [x] Historical backfill ownership/progress survives restarts without retaining an in-memory job registry.
- [x] The chat loads metadata only for rendered turns and removes atoms when those turns leave the view.

## Ownership and extraction boundary

| Layer                    | Owns                                                                                        | Does not own                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `orgtrack-protocol`      | Stable action/outcome/envelope vocabulary                                                   | Provider payload parsing, SQLite, UI                                 |
| `orgtrack-core`          | Provider adapters, resource extraction, `TurnMetadataAccumulator`, Git artifact recognition | ORG2 database paths, Tauri commands, React                           |
| `session-persistence`    | Versioned `session_turns` materialized cache and lazy rebuild                               | Tool-name constants, provider-specific result parsing, Git semantics |
| app `session_provenance` | stdin/inbox/SQLite/filesystem adapters and actor lifecycle wiring                           | Round aggregation rules                                              |
| frontend                 | Validated display and navigation                                                            | Raw transcript aggregation                                           |

Moving Orgtrack to a future repository/submodule therefore requires changing Cargo dependency locations and supplying host adapters; the protocol/projector does not depend on the ORG2 app crate.

## Incremental memory and freshness model

| Concern                  | Durable source of truth                                                         | Bounded in-memory state                                                                                |
| ------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| File-history freshness   | Per-resource SQLite revision advanced by interaction insert/delete triggers     | Current visible page plus one numeric revision; no process-wide history cache                          |
| Session Blame pagination | SQLite query pages root sessions, then returns all interactions for those roots | 30 root sessions by default (100 hard maximum); children never split from their root                   |
| Historical backfill      | SQLite job row with owner, token, status, progress, error, and update time      | One process-owner UUID; transcript batches are released after projection                               |
| Per-round chat metadata  | Versioned `session_turns` rows                                                  | Only currently rendered turn atoms; stale/session-unmounted atoms are explicitly removed               |
| Live invalidation        | Revision remains authoritative across every writer and restart                  | A payload-free Tauri event accelerates refresh; visible-only 5 s revision probes recover missed events |

Every inbox consumer emits the same invalidation after a successful drain. This prevents a query from consuming a hook envelope before the periodic drain loop can broadcast it. The event is only a hint: the frontend rechecks the SQLite revision before replacing a page, and an ordering change during “load more” restarts from page zero.

## Identity semantics

| Field        | Meaning                                     | Source                                                    |
| ------------ | ------------------------------------------- | --------------------------------------------------------- |
| `session_id` | Durable conversation/session                | Provider canonical session identity                       |
| `turn_id`    | User-message-bounded conversational round   | Latest non-synthetic user-message id                      |
| `actor_id`   | Root agent/subagent identity                | Hook lifecycle or reconciled actor mapping                |
| `thread_id`  | Provider execution thread/process dimension | Preserved on normalized events; never reused as `turn_id` |

Native ORG2 associates completed tool calls with the nearest preceding real user message in the in-memory production event store. Reconciled histories infer the same boundary from normalized `user_message` chunks. A provider thread id may identify an execution lane or subagent and is intentionally not promoted to a conversational round.

## Provider coverage

| Capture surface            | Providers                                                                                                | Projection path                                                                                   |
| -------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Managed hooks              | Claude Code, Codex, Cursor, Qwen Code, Factory Droid, Trae, OpenCode, Windsurf, Kimi, Antigravity, ZCode | hook adapter → privacy-safe `ResourceInteractionEnvelopeV1`                                       |
| Imported history           | Claude Code, Codex, Cursor, OpenCode, Windsurf, WorkBuddy, Trae, Cline, Warp, ZCode                      | existing provider loader → normalized `ActivityChunk` → Orgtrack resource projector               |
| Native ORG2                | Rust-agent event pipeline                                                                                | merged production tool event → Orgtrack interaction store; turn cache → `TurnMetadataAccumulator` |
| Cloud collaboration replay | Authorized ORG2 team-session event cache                                                                 | checkout-safe path remap → normalized `ActivityChunk` → Orgtrack interaction store                |

Hook-only providers gain live provenance immediately. Providers with imported-history loaders also gain lazy historical projection. Adding a future provider means implementing an adapter/loader to the normalized boundary, not adding another turn metadata implementation.

## Production call-chain trace

| Entry point       | Path                                                                                        | Result                                                         |
| ----------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Live native tool  | production event merge → nearest user-message turn → `persist_native_event_interactions`    | Canonical session/turn/actor/resource fact                     |
| External hook     | provider hook → `hook_adapter` → privacy-safe spool → bounded drain                         | Canonical live resource fact without raw content/query/output  |
| Historical round  | existing provider loader/event cache → normalized tool metadata → `TurnMetadataAccumulator` | Lazy read/search/edit/Git metadata                             |
| Cloud replay      | authorized event cache → owner/viewer checkout remap → user-message round boundary          | Exact-owner resource facts without persisting the owner's path |
| Session aggregate | `load_turn_index` → fold unique modified paths and line totals                              | Final edit impact and Kanban search input                      |
| Chat UI           | validated RPC → per-turn atom → `TurnMetadataFooter`                                        | Read/search paths, edits, commits, and PRs                     |
| Open file history | SQLite revision probe → root-session page → Session Blame                                   | Incremental refresh without a resident process-wide cache      |

## Ten-layer audit

| Layer                                 | Verdict | Evidence / decision                                                                                                                                                                                                 |
| ------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Compilation correctness            | Pass    | Rust check and 1,187 Rust tests, TypeScript typecheck, 5,127 Vitest tests, full ESLint, targeted Clippy, and two rendered desktop E2E scenarios passed.                                                             |
| 2. Dead code / structural duplication | Pass    | Removed the unbounded file-interaction read path and the process-wide backfill `HashMap`; one paged store query, one durable job table, and existing provider loaders remain.                                       |
| 3. Naming consistency                 | Pass    | `TurnMetadata` names the UI/cache projection; `ResourceInteraction` names protocol facts; `modifiedFiles` remains the edit-only review subset.                                                                      |
| 4. Semantic overloading               | Pass    | Session, turn, actor, and thread meanings are documented and enforced; the former `thread_id → turn_id` assignment was removed.                                                                                     |
| 5. Default branches                   | Pass    | Malformed JSON is tolerated, unknown tools are skipped, failed writes do not claim modifications, missed events recover through revision polling, and prior-process jobs are reclaimed without racing a live owner. |
| 6. Cross-domain leakage               | Pass    | Provider/tool/Git semantics live in `orgtrack-core`; `session-persistence` calls one provider-neutral accumulator; filesystem/SQLite concerns remain host adapters.                                                 |
| 7. New-developer clarity              | Pass    | Module docs and the ownership/provider/identity tables identify the one extension point and why the cache is rebuildable.                                                                                           |
| 8. Wire protocol / serialization      | Pass    | Rust serde camelCase, Zod, and TS interfaces agree on revision/page fields and the optional bounded turn-id request (500 maximum).                                                                                  |
| 9. Init parity                        | Pass    | Fresh and legacy DBs both gain parent identity, revisions, triggers, seeded revision rows, indexes, and durable job storage in safe migration order.                                                                |
| 10. Resolver symmetry                 | Pass    | Live hooks, native events, cloud replay, and imported histories converge on Orgtrack rules; provider discovery and transcript parsing continue to reuse existing loaders.                                           |

## Systematic sweeps

| Issue class                | Sweep                                                              | Outcome                                                                                         |
| -------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Duplicate provider parsing | Searched provider loaders, hook adapters, and turn-cache code      | Existing loaders/adapters are reused; no new transcript reader was introduced.                  |
| Duplicate round projection | Searched file/Git accumulators and host tool-name constants        | One `TurnMetadataAccumulator` remains in `orgtrack-core`.                                       |
| Identity conflation        | Searched `turn_id` assignments from `thread_id`                    | Native and reconciled paths now derive turns from user-message boundaries.                      |
| Schema parity              | Checked create/ALTER/insert/select/Rust/Zod/TS shapes              | All include `resource_interactions_json`; v10 rebuilds historical rows lazily.                  |
| Localization               | Parsed every locale JSON and compared the new feature keys         | All 13 locales include read/search/failure labels.                                              |
| Unbounded reads/state      | Searched file history queries, backfill registries, and turn atoms | Root pages are bounded, job state is durable, and invisible turn atoms are evicted.             |
| Invalidation consumers     | Searched every hook-inbox drain call and interaction writer        | Every drain broadcasts; native/collaboration writers broadcast; revision remains authoritative. |

## Final verdict

No blocking architecture finding remains. Orgtrack owns the reusable protocol, provider-neutral projection, paged store contract, and durable metadata; ORG2 owns host adapters and disposable UI state. A future extraction is repository packaging/versioning plus host wiring, not a domain redesign. Runtime memory no longer grows with indexed session count: persisted history/job/turn data remains on disk and the open surfaces keep bounded pages only.

## Verification

| Gate                | Result                                                                                                                                                                                                     |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rust app tests      | Pass: `cargo test --lib --no-fail-fast` — 936 tests                                                                                                                                                        |
| Rust crate tests    | Pass: `orgtrack_core` 230 tests + `session_persistence` 21 tests                                                                                                                                           |
| Rust compilation    | Pass: `cargo check`                                                                                                                                                                                        |
| Rust lint           | Pass for changed crates with `cargo clippy ... --all-targets --no-deps -D warnings`; whole workspace remains blocked by unrelated existing lint debt in `integrations`, `system-services`, and `key-vault` |
| Frontend types      | Pass: `npm run typecheck`                                                                                                                                                                                  |
| Frontend lint       | Pass: `npm run lint`                                                                                                                                                                                       |
| Frontend unit tests | Pass: 444 files / 5,127 tests                                                                                                                                                                              |
| Session Blame E2E   | Pass: isolated macOS Tauri/WebDriver with real Claude Code 2.1.210, Codex 0.144.1, and Cursor Agent 2026.07.09-a3815c0 hooks; live refresh, distinct transcripts, and sidebar reveal verified              |
| Round metadata E2E  | Pass: isolated macOS Tauri/WebDriver `turn-metadata` scenario against the real Tauri command and SQLite cache                                                                                              |
| Localization        | Pass: all 13 session locale JSON files parse and contain the new keys                                                                                                                                      |
