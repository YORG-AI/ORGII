# Architecture Audit — Team Inbox

**Scope:** `src/modules/MainApp/TeamInbox`, local Team Inbox Rust read/write model, cloud mention client, current-user member resolver, Sidebar consumer

**Date:** 2026-07-28
**Auditor:** Codex

## Findings

| Priority | Area                                     | Final verdict | Evidence                                                                     | Resolution                                                                                                                                                                                            |
| -------- | ---------------------------------------- | ------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1       | Shared pagination and request ownership  | fixed         | `teamInboxCoordinator.ts`; `teamInboxCoordinator.test.ts` shared-cursor case | A `WeakMap<Store, CoordinatorRuntime>` now owns scope generation, local/cloud cursors, single-flight refresh/load-more, mutation ordering and cancellation for every consumer in one Jotai store.     |
| P1       | Independent source failure semantics     | fixed         | Coordinator partial-initial and partial-pagination tests                     | Local and cloud promises settle independently. Successful rows/counts commit; only the failed source retains its previous projection/cursor and emits a structured issue.                             |
| P1       | Ambiguous viewer identity                | fixed         | `useCurrentUserMemberId.test.ts` exact-domain/name-negative cases            | Resolution accepts stable account/member ids, exact full emails/linked emails and exact provider usernames. Display-name and email-local-part guesses were removed.                                   |
| P2       | Assignment episode receipts              | fixed         | Rust `assignee_change_atomically_resets_team_inbox_receipts` test            | `assigned_human_id` and receipt deletion now commit in the same SQLite transaction whenever assignee identity/type changes. Non-human assignees are excluded.                                         |
| P2       | Duplicate mutable UI/cache state         | fixed         | `TeamInboxView.tsx`; coordinator optimistic rollback test                    | The coordinator is authoritative for items, counts, optimistic receipt state and Work Item reconciliation. The view retains only a subscribed render snapshot plus filter/query/selection intent.     |
| P2       | Empty-result pagination                  | fixed         | `TeamInboxList.test.ts`                                                      | `Load more` remains mounted when the current filter/search has no visible rows, so later pages remain reachable.                                                                                      |
| P2       | Retry and stale request behavior         | fixed         | View retry test; coordinator scope-switch test; cloud abort test             | Retry calls the backing refresh boundary. Scope switches abort cloud work, synchronously clear cross-identity data and reject late commits by generation.                                             |
| P2       | Work Item context and update ordering    | fixed         | `useTeamInboxWorkItem.test.ts`                                               | The body is the required read; project/member context degrades independently. Same-item partial writes run through a bounded invocation-order queue.                                                  |
| P2       | Unbounded retained work                  | fixed         | 500-row coordinator bound test; eight-worker member loader                   | The app-lifetime row snapshot and mutation queue are capped; project member I/O is single-flight, concurrency-bounded and partial-failure aware.                                                      |
| P3       | Presentation fallbacks and accessibility | fixed         | localized issue codes/thread counts; row/list tests                          | Semantic cloud values are localized in presentation, internal thread/comment ids were removed from normal metadata, row names are localized, and the conflicting active-descendant model was removed. |

## Ten-layer coverage

| Layer                      | Verdict                           | Notes                                                                                                                                                                                            |
| -------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Compilation             | pass with external clippy blocker | TypeScript typecheck, scoped ESLint, Rust format/check and targeted tests pass. Strict clippy remains blocked by the pre-existing `search/src/file/index_cache.rs:34` `type_complexity` warning. |
| 2. Dead code / duplication | pass                              | Both mounted consumers use the production coordinator; the old instance-local cursor/request/mutation implementation was removed.                                                                |
| 3. Naming                  | pass                              | Wire `work_item_assigned` and UI `assigned_work_item` remain explicitly translated and cursor-tested. Structured `TeamInboxIssue` replaces user-visible raw failure strings.                     |
| 4. Semantic overload       | pass                              | The hook resolves prerequisites and binds React; the coordinator owns state transitions; SQLite/cloud clients own durable writes.                                                                |
| 5. Defaults                | pass                              | Identity is fail-closed rather than guessed. Cloud DTO fallbacks use stable ids only; localized copy is selected in presentation.                                                                |
| 6. Layer boundaries        | pass                              | Persisted receipts remain behind Rust/cloud commands; runtime coordination is store-scoped; filter/query/selection remain component-local.                                                       |
| 7. Control flow / FSM      | pass                              | Request versions, scope generations, AbortControllers, shared single-flight promises and per-item mutation epochs define supersession/rollback.                                                  |
| 8. Wire protocol           | pass                              | Zod validates mention pages/mutations; viewer identity remains JWT-derived; timeout/cancellation do not alter RPC bodies.                                                                        |
| 9. Init parity             | pass                              | Sidebar and full Inbox instantiate the same hook and converge on the same per-store runtime/cache/cursors.                                                                                       |
| 10. Resolver symmetry      | pass                              | Account id, primary email, linked email and provider username follow exact matching rules across all member entries; assignee display enrichment uses the same member roster.                    |

## Ownership map

| Value                                              | Owner                                | Lifetime                         | Write boundary                               | Readers                 |
| -------------------------------------------------- | ------------------------------------ | -------------------------------- | -------------------------------------------- | ----------------------- |
| Assignment and local receipt                       | SQLite Work Item / Team Inbox tables | durable                          | atomic Work Item update and receipt commands | coordinator local page  |
| Cloud mention and receipt                          | managed-cloud RPC                    | durable/collaborative            | JWT-scoped mention RPCs                      | coordinator cloud page  |
| Items, totals, cursors, request and mutation state | `TeamInboxCoordinator` + Jotai atom  | current store and identity scope | coordinator only                             | Sidebar and full Inbox  |
| Filter, query and selected row                     | `TeamInboxView`                      | component mount                  | React handlers                               | list/detail composition |
| Full selected Work Item                            | `useTeamInboxWorkItem`               | selected target                  | canonical partial-update API                 | shared Work Item thread |

## Verification

- `npm run typecheck` — passed.
- Scoped ESLint for Team Inbox, cloud clients and identity resolver — passed.
- `pnpm test` — 751 files / 6,609 tests passed.
- `npx vitest run src/modules/MainApp/TeamInbox/__tests__ src/features/Org2Cloud/teamInboxMentionsClient.test.ts src/features/Org2Cloud/org2CloudFetchRetry.test.ts src/hooks/project/useCurrentUserMemberId.test.ts` — 81 tests passed.
- `cargo test --manifest-path src-tauri/Cargo.toml -p project_management projects::io::work_items::atomic::tests -- --nocapture` — 32 tests passed.
- `cargo check --manifest-path src-tauri/Cargo.toml -p project_management --all-targets` — passed.
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` — passed.
- `cargo clippy --manifest-path src-tauri/Cargo.toml -p project_management --all-targets -- -D warnings` — blocked outside this module by the existing `crates/search/src/file/index_cache.rs:34` warning.
