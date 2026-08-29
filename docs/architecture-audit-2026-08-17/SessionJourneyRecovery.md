# Architecture audit — PR 770 Journey recovery

**Scope:** recovery of the contributor Journey feature onto current `develop`, covering canonical Project/Session projection, the Session Journey lifecycle, review handoff, persistence membership, and exact transcript navigation.

## Acceptance criteria

- Projects contain canonical sessions directly; Work Items are optional metadata and never own sessions.
- Journey tasks, forks, checkpoints, reviews, and message memberships use explicit persisted identifiers and sequence anchors rather than titles, timestamps, or UI inference.
- Lifecycle mutations are CAS-protected, fail closed on missing provenance or anchors, and keep review publication separate from parent return.
- Provider history is filtered at the persistence boundary before reconstruction and receives only the active branch plus exact ancestor prefixes and confirmed handoff capsules.
- Existing sessions without Journey membership retain their legacy transcript, while partially Journey-tagged sessions deny unknown or mismatched rows.
- Current tab, history, persistence, and Agent Org inbox architecture remains authoritative; obsolete PR 770 shell/routes and unrelated provider/key-vault/search changes remain excluded.

## Entry-point and ownership trace

| Boundary           | Owner                                             | Contract                                                                                          |
| ------------------ | ------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Project tree       | session aggregate + explicit project metadata     | Project → Session is canonical; Work Item association annotates but does not re-parent a session  |
| Journey state      | `SessionJourney` + `SqliteJourneyRepository`      | One revisioned aggregate per session; every mutation supplies the expected revision               |
| Message membership | session persistence transaction                   | Durable message, sequence, branch, and task membership are committed atomically                   |
| Review execution   | durable review queue/outbox                       | Frozen source range and runtime provenance are claimed by one worker; failures remain retryable   |
| Provider prompt    | Journey visibility projector                      | Rows are filtered before provider reconstruction; confirmed capsules are append-only context      |
| UI navigation      | workstation tab target + ChatHistory exact target | Task/fork/checkpoint routes carry durable message IDs through page selection and scroll/highlight |

## Ten-layer review

| Layer                                  | Coverage                                                                         | Verdict                                                                                                                                                                                                                                                                                                             |
| -------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Compilation and boundaries          | Rust crates, Tauri commands, TypeScript API and component props                  | Pass. `pnpm typecheck`, focused ESLint, `cargo check -p org2`, and package tests compile the recovered cross-layer contract.                                                                                                                                                                                        |
| 2. Types, dead code, and deduplication | Journey aggregate, request/response DTOs, current history/tab architecture       | Pass. One canonical lifecycle/application-service path and one Tauri API surface remain. The unreachable pre-application-service implementation and its private formatting/lookup helpers were removed; obsolete Journey Station routes, duplicated gateway code, and mixed contributor commits were not recovered. |
| 3. Dependency direction                | orgtrack projection, agent-core persistence/application service, Tauri, React    | Pass. Projection depends on canonical session/project inputs; UI invokes typed Tauri commands and does not own lifecycle invariants. Persistence filters provider history before reconstruction.                                                                                                                    |
| 4. Terminology and semantic overload   | Project, Session, Work Item, Task, Fork, Checkpoint, Review                      | Pass. Work Item is metadata only; a Journey Task is not overloaded as a Work Item. Exact anchors are durable message IDs plus sequences, never display labels.                                                                                                                                                      |
| 5. Defaults and fail-closed behavior   | legacy history, direct fork, strict lifecycle anchors, unavailable Journey state | Pass. Legacy sessions with no memberships retain history. Once memberships exist, unknown/mismatched rows are denied. Direct Fork may resolve only the latest durable user row on the active branch; checkpoint, finish, and close require an explicit durable anchor.                                              |
| 6. Variant leakage                     | provider/runtime variants and UI render variants                                 | Pass with scope note. Runtime provenance is stored as typed metadata; provider-wide review output-limit changes from the contributor branch were excluded, so the existing 1,024-token side-query budget remains.                                                                                                   |
| 7. Control flow and FSM                | task/fork/review transitions, CAS, queue recovery                                | Pass. State transitions are explicit, revisioned, and tested for conflicts, failure recovery, single-consumer claims, close/review/confirm/discard/return ordering, and exact parent anchors.                                                                                                                       |
| 8. Wire and persistence protocol       | SQLite tables, serialized Journey snapshots, Tauri payloads                      | Pass. Tables are additive; message membership is written in the owning transaction; snake_case Rust DTOs are mapped by the typed frontend adapter. Invalid JSON and missing provenance fail closed.                                                                                                                 |
| 9. Initialization parity               | normal startup, existing database, read-only load, queue reconciliation          | Pass. Persistence initialization installs the additive Journey schema, Tauri handlers are registered in the current application shell, read-only loads do not create schema, and orphaned running review jobs are reconciled on startup.                                                                            |
| 10. Resolver symmetry                  | project/session ownership, branch visibility, exact navigation                   | Pass. Project ownership uses explicit persisted project fields and linked workspaces; branch visibility uses membership and lineage anchors; navigation carries the same durable target through tree, tab, pagination, scroll, and highlight. No timestamp/string inference path was retained.                      |

## Recovery integrity

- Contributor commits were cherry-picked with provenance footers and resolved onto current `develop`; commits whose Journey changes were already represented were skipped rather than replayed as duplicates.
- Unrelated provider, key-vault, search, release, and ProgressMindMap changes were excluded.
- Current idempotent Agent Org inbox materialization, modular ChatHistory components, session header actions, and workstation tab architecture were preserved.
- The persistence regression test now stores the published capsule at revision 3 before returning to the parent at revision 4, matching production CAS sequencing.

## Result

Architecture verdict: **pass for draft review**. The recovered feature has one explicit ownership path from persisted domain state to UI navigation. Remaining release gates are rendered Tauri coverage and real-process performance measurements, recorded separately in the performance report and PR risks.
