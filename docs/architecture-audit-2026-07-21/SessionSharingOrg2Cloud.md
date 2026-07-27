# Architecture Audit — PR #482 Org2Cloud Session Sharing

Date: 2026-07-21

Base: `origin/develop` (`311320f82`)

Scope: all 78 files in PR #482 after rebase, including Org2Cloud sharing/realtime/presence,
comments, import/fork, external-session turn paging, dual-instance runtime isolation, rendered
E2E support, and the audit fixes made in this pass.

## Verdict

**Pass.** No unresolved merge-blocking architecture finding remains. This pass found and fixed
six lifecycle/correctness gaps and removed one false-path E2E pattern class. The remaining
items are explicitly bounded or pre-existing sweep candidates and are listed below.

## Ten-layer coverage

| Layer                      | Covered | Result                                                                                                                                                                                                                                            |
| -------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Compilation             | yes     | `tsc --noEmit` and `cargo check` pass; changed TS/JS lint/format and changed Rust format pass.                                                                                                                                                    |
| 2. Dead code / duplication | yes     | Production call chains traced from root hooks, share/import UI, Tauri commands, and E2E entry points. New coordinators and helpers are wired; no definition/re-export/test-only abstraction found.                                                |
| 3. Naming consistency      | yes     | `org2CloudAuthIdentityKey` remains the sole auth identity constructor. New `pruneRemovedOrgState` accurately names its wider responsibility.                                                                                                      |
| 4. Semantic overloading    | yes     | Identity, roster version, force token, active org, and session turn terms were swept; term table below.                                                                                                                                           |
| 5. Default branches        | yes     | Guest-share transient failure and comment anchor defaults remain fail-open only where the server re-authorizes. Imported `user` is now explicitly handled alongside `user_message`.                                                               |
| 6. Cross-domain leakage    | yes     | Production never imports E2E helpers. Runtime-instance isolation remains in Rust; cloud state remains in Org2Cloud/TeamCollaboration.                                                                                                             |
| 7. New-developer clarity   | yes     | Presence-topic, force-token, merge-not-replace, active-org, and cache-pruning contracts are documented at their owners.                                                                                                                           |
| 8. Wire / storage protocol | yes     | No incompatible Supabase RPC shape changed. Local turn-index v11 intentionally rebuilds its materialized cache and accepts both native `user_message` and imported `user`. OAuth-live E2E credentials preserve file version and write atomically. |
| 9. Initialization parity   | yes     | Primary, production secondary, and WebDriver secondary use the same instance isolation profile. Sync-engine start/stop is identity-keyed in every rendered entry path.                                                                            |
| 10. Resolver symmetry      | yes     | Remote-session identity filtering, visible active-org selection, parent navigation, imported repo grouping, and turn-user resolution were compared; asymmetries were fixed or retained with reason.                                               |

## Term table

| Term                    | Meaning                                                                            | Verdict                                                                    |
| ----------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `identityKey`           | normalized endpoint plus user id, used for cache ownership and async commit guards | one meaning; keep                                                          |
| `active org`            | management surface selection first, sidebar selection as fallback                  | unified for Realtime demand and entitlement backoff in this pass           |
| `rosterVersion`         | per-org Realtime invalidation counter                                              | one meaning; keep                                                          |
| `force`                 | bypass completed-TTL reuse while still joining an equal/newer in-flight request    | consistent in roster/comments loaders                                      |
| `user` / `user_message` | imported normalized user event / native user event                                 | two wire aliases for the same turn-boundary concept; explicitly normalized |

## Findings fixed

| ID  | Finding                                                                                                                                                                               | Fix                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | `SessionViewersIndicator` scanned every org's remote rows without the active identity filter.                                                                                         | Reused the identity-filtered active-org resolver chain.                                                                                      |
| F2  | Comment viewer capability could be decided from an unfiltered stale remote row.                                                                                                       | Applied `remoteSessionsEntryForIdentity`; documented the server-authorized fail-open fallback.                                               |
| F3  | Identity-mismatch panel renders allocated a fresh empty member array.                                                                                                                 | Hoisted a stable empty constant.                                                                                                             |
| F4  | Sync-engine timers and per-identity maps survived sign-out/account switch.                                                                                                            | Keyed start/stop to endpoint + user identity; `stop()` drains timers/waiters and resets state.                                               |
| F5  | Presence heartbeats rewrote semantically identical roster objects and rebuilt broad UI consumers.                                                                                     | Added semantic equality that ignores heartbeat-only `updatedAt`.                                                                             |
| F6  | Share refresh could call `setState` after unmount.                                                                                                                                    | Added unmount plus identity commit gates.                                                                                                    |
| F7  | Comment signal counters grew per `(org, session)` without a cap.                                                                                                                      | Routed all writers through a 256-key LRU bump helper.                                                                                        |
| F8  | Presence track/broadcast failures retried forever at 1 Hz.                                                                                                                            | Added 1s-to-30s capped exponential backoff with success/re-subscribe reset.                                                                  |
| F9  | Presence topics had an undocumented no-sequence-suffix contract.                                                                                                                      | Documented the peer/RLS invariant at `joinPresence`.                                                                                         |
| F10 | Switching from a heavy Worker-projected session to a small main-thread session retained the previous event/projection graph.                                                          | Clear Worker state and previous Worker input whenever the current input no longer uses the Worker; regression covers Worker → main → Worker. |
| F11 | Org removal pruned only four backoff maps; hydration, alias, inbound, pending, full-state, and session-sync caches survived. Deleted local sessions also stayed in session-sync maps. | Replaced the partial helper with `pruneRemovedOrgState` and added `Org2CloudSessionSync.prune(liveOrgIds, liveSessionIds)` on every pass.    |
| F12 | Persisted roster reconciliation ran once per identity, so same-account leave/delete could retain backend-owned per-org state.                                                         | Reconcile key now includes the sorted authoritative membership set and reruns when that set changes.                                         |
| F13 | Inactive-org backoff only considered the sidebar, while Realtime considered an open management surface active.                                                                        | Unified the visible-org fallback chain: management selection, then sidebar.                                                                  |
| F14 | Turn indexing accepted imported `function_name = "user"`, but placeholder preview stripped only `user_message`.                                                                       | Normalized both aliases and added Rust coverage.                                                                                             |
| F15 | Six rendered E2E actions used page-script `.click()`/`dispatchEvent()` for behavior under assertion.                                                                                  | JavaScript now only locates/marks/checks; WebDriver performs the actual click, right-click, selection, and submit.                           |
| F16 | Adding direct `webdriverio` rewrote thousands of unrelated lockfile lines.                                                                                                            | Restored the develop lock representation and kept only the three required importer lines; frozen-lock install passes.                        |

## Resolver and initialization matrices

| Concept                     | Primary chain                                             | Secondary chain                               | Result                                                                                 |
| --------------------------- | --------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------- |
| Session cloud refs          | auth identity → active org entry → rows                   | indicator/comments/parent navigation          | indicator and comments fixed; parent navigation is event-time and server re-authorized |
| Visible active org          | management panel org → sidebar org                        | Realtime scope and entitlement retry audience | unified in F13                                                                         |
| External-session repo scope | explicit repo metadata → normalized cwd/upstream resolver | personal or cloud import/fork                 | symmetric; fork becomes an ordinary local continuation                                 |
| User turn boundary          | native `user_message`                                     | imported normalized `user`                    | symmetric in index and placeholder rendering after F14                                 |

| Entry point          | Data home                                          | External history home      | Cloud engine lifecycle                         |
| -------------------- | -------------------------------------------------- | -------------------------- | ---------------------------------------------- |
| Primary Tauri        | primary profile                                    | primary profile            | starts only with auth identity                 |
| Production secondary | `instance{N}` profile                              | matching secondary profile | independent Jotai/Tauri process                |
| WebDriver secondary  | `e2e.instance{N}` mapped to same isolation profile | matching secondary profile | independent seeded auth; no shared OAuth chain |

## Kept with reason / non-blocking sweep candidates

| Site                                                      | Verdict            | Reason                                                                                                                                    |
| --------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `SessionForkHeaderExtras.handleOpenParent` raw entry read | keep               | Event-handler-time lookup; server call re-authorizes and identity-owned atoms are cleared before paint on account switch.                 |
| Member roster 30s fallback interval                       | keep               | Hidden ticks skip fetch; push invalidation is primary; effect tears down on org/identity/unmount.                                         |
| Guest-validation overlap after abort                      | keep               | Commit/evict is abort-gated; at most one obsolete HTTP request can finish.                                                                |
| Project push retry while hidden                           | keep               | Durable-outbox exception; one-shot, single-flight, and bounded.                                                                           |
| Native `TauriMenu.new(...).popup()` disposal              | follow-up sweep    | Click-driven, not idle growth, and repeated at 12+ unrelated call sites. If handles leak, fix once with a shared popup-and-close helper.  |
| Member-filter row keyboard focus                          | follow-up UI sweep | Pre-existing `DropdownItem`/`role=option` pattern outside this PR's added lines; not a regression and should be fixed design-system-wide. |

## Systematic sweeps

| Pattern class                          | Scope                                                          | Result                                                                                                        |
| -------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Unfiltered remote-session reads        | all `.rows` consumers                                          | F1/F2 fixed; event-time parent path kept with reason.                                                         |
| Per-identity/org/session maps and sets | sync engine, session sync, atoms, coordinators                 | identity reset plus live roster/session pruning now bounds every app-lifetime cache.                          |
| Fixed retry/timer chains               | realtime, sync, guest validation, panel fallback               | F8 fixed; remaining chains bounded with lifecycle owners.                                                     |
| Async UI commits                       | Org2Cloud hooks/models                                         | F6 fixed; other commits have identity/epoch/abort guards.                                                     |
| Worker/session retained graphs         | projection hook and turn-window path                           | F10 fixed; turn bodies page by turn and unload on close.                                                      |
| E2E false behavior paths               | all `execute`/`dispatchEvent`/script clicks in cloud dual spec | production user actions now go through WebDriver. Seed/inspect/sync helpers remain setup or observation only. |
| Lockfile/package churn                 | E2E package diff                                               | F16 fixed; final lock diff is 3 additions.                                                                    |

## Verification

- `pnpm exec tsc --noEmit`: pass.
- Changed TS/JS ESLint, Prettier, `node --check`, and `git diff --check`: pass.
- Targeted regressions: 4 files / 83 tests pass.
- Wider Org2Cloud + TeamCollaboration + ChatPanel sweep: 153 files / 1,496 tests pass.
- Full repository Vitest run (the same command as CI): 592 files / 5,727 tests pass.
- Full repository ESLint and `cargo clippy --workspace` (the same commands as CI): pass;
  Clippy reports only the develop baseline's advisory warnings.
- `cargo check`: pass. Changed Rust file `rustfmt --check`: pass.
- `cargo test -p session_persistence imported_user_alias_starts_turn`: 1/1 pass.
- Full-workspace `cargo fmt --all -- --check` reports three pre-existing develop formatting
  differences outside this PR. Root-crate unit execution on this Windows host exits before tests
  with `STATUS_ENTRYPOINT_NOT_FOUND`; the changed root helper is covered by compile and
  formatting, while the independently runnable turn-index test covers the imported alias.
- E2E dependency install with `--frozen-lockfile --ignore-scripts`: pass.
- `tauri:build:fast:dual`: both final-head executables compiled successfully in parallel and
  copied with matching source/destination hashes. Windows Smart App Control then rejected the
  newly unsigned binaries at process creation (Code Integrity event 3077), so this final head was
  not represented as a successful rendered run.
