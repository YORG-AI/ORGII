# Polling Lifecycle Architecture Audit

**Date:** 2026-07-16
**Scope:** Frontend recurring backend/status polling and the Rust Git watcher health fallback
**Mode:** Audit plus remediation before commit
**Method:** `.orgii/skills/architecture-audit/SKILL.md`, all 10 layers

## Executive verdict

The polling refactor is safe to ship after remediation. Recurring frontend backend reads now share a visibility-aware, sequential scheduler, repeated resource metrics share one process-wide source, and Git watcher recovery uses one canonical health loop with a state-preserving polling fallback.

The initial audit found two commit-blocking race classes:

1. A polling episode could be replaced while its async request was still running, allowing an old consumer closure to write stale state.
2. Git watcher recovery removed the repository state before recreating the watcher, so recreation failure could delete the metadata required for polling fallback and future retries.

Both classes were fixed before this report was finalized. `useVisiblePolling` now gives every episode an `AbortSignal`, identity-sensitive consumers check it after external awaits, and Git watcher restart now drops only the native watcher while preserving `RepoState`. Watcher availability transitions atomically maintain the retry invariants.

## Evidence-backed findings

| Priority | Line / element                                                                                      | Verdict              | Reason                                                                                                                                                                                                                               | Resolution                                                                                                                                                                                                       |
| -------- | --------------------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1       | `src/hooks/async/useVisiblePolling.ts` polling episode lifecycle                                    | **fixed**            | A dependency or `restartKey` change could leave an old async consumer alive while the new episode waited for the shared in-flight request. Scheduler serialization alone cannot prevent stale consumer state writes.                 | Each episode owns an `AbortController`; cleanup aborts the episode and identity-sensitive consumers reject results after `await` when the signal is aborted.                                                     |
| P1       | `src-tauri/crates/git/src/watch/watcher.rs` watcher restart                                         | **fixed**            | `restart_watcher` previously called `unwatch_repo`, which deleted `RepoState` before recreation. A failed recreation could therefore lose fallback/retry state.                                                                      | Restart removes only the old native watcher and debounce job. The repository state remains present throughout recreation.                                                                                        |
| P1       | `src-tauri/crates/git/src/watch/{state_store.rs,watcher.rs,health_monitor.rs}` fallback transitions | **fixed**            | Watch creation and `.watch()` failures did not share one atomic transition, and a fast recovery failure needed a fresh retry backoff.                                                                                                | `mark_watcher_unavailable` and `mark_watcher_available` are the canonical transitions; both watcher-construction failure modes enter polling fallback, and each failure resets the five-minute recovery backoff. |
| P2       | Settings and Sidebar resource monitors                                                              | **fixed**            | Both surfaces owned duplicate 15-second and 60-second timers and duplicate Tauri requests.                                                                                                                                           | `useSystemResourceMetrics` is a shared external store with consumer counting, visibility gating, and request-level single-flight.                                                                                |
| P2       | Browser console/network drain APIs                                                                  | **fixed**            | Concurrent consumers could drain the same incremental backend buffer twice and cause one view to observe an empty result.                                                                                                            | Requests are coalesced by WebView label, and aborted episodes do not commit drained records into a stale session cache.                                                                                          |
| P2       | Benchmark, File Review, session files/messages, live diff, LSP and Agent Org polling                | **fixed**            | These hooks await identity-scoped backend data and then update React/Jotai state.                                                                                                                                                    | Poll callbacks validate the episode signal after external awaits before state writes. Terminal polling returns `false` to stop the episode.                                                                      |
| P2       | Team Collaboration metadata sync                                                                    | **fixed**            | The custom recursive scheduler prevented overlap, but effect cleanup during a long sync could still allow stale local writes.                                                                                                        | Cancellation is checked after setup/list/snapshot awaits, before local state updates, and before scheduling the next cycle.                                                                                      |
| P3       | Remaining production `setInterval` sites                                                            | **keep with reason** | The residual timers are UI clocks/playback, persistence flushes, WebSocket or file-watch heartbeats, bounded DOM detection, or the canonical shared metrics scheduler. They do not represent uncontrolled duplicate backend polling. | Keep. Their lifecycle semantics differ from backend status polling and should not be forced through the shared hook.                                                                                             |

## Ten-layer audit coverage

| Layer                                   | Result   | Notes                                                                                                                                                                          |
| --------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Compilation correctness              | **Pass** | Polling files pass ESLint and targeted TypeScript diagnostics. Git crate tests and Clippy pass with warnings denied.                                                           |
| 2. Dead code & structural deduplication | **Pass** | Duplicate polling loops were removed. Obsolete inline-WebView interval handle plumbing was deleted. Settings/Sidebar metrics types and requests have one owner.                |
| 3. Naming consistency                   | **Pass** | `useVisiblePolling`, `mark_watcher_available`, and `mark_watcher_unavailable` describe scheduler and state-transition intent directly.                                         |
| 4. Semantic overloading                 | **Pass** | Frontend visibility, polling continuation, and consumer identity validity are separate concerns. Git watcher availability is distinct from generic Git-status health failures. |
| 5. Default branch analysis              | **Pass** | Poll continuation is explicit (`false` stops); watcher creation and attach failures both enter the same fallback; no catch-all silently reports watcher recovery.              |
| 6. Cross-domain leakage                 | **Pass** | Scheduling stays in the async hook, resource collection stays in the perf store, and Git fallback/recovery stays in the Git watcher domain.                                    |
| 7. New-developer confusion              | **Pass** | Hook documentation states consumer error and aborted-result responsibilities. Git recovery comments explain why `RepoState` must survive watcher recreation.                   |
| 8. Wire protocol & serialization        | **N/A**  | No payload schema, serialization shape, or external protocol was changed. Existing commands are only rescheduled/coalesced.                                                    |
| 9. Init parity                          | **N/A**  | No new application/session initialization entry point was introduced. `RepoWatchManager::new` still creates exactly one health monitor.                                        |
| 10. Resolver symmetry                   | **N/A**  | No multi-field resolver or fallback chain was changed.                                                                                                                         |

## Term semantics

| Term                | Meaning in this change                                                       | Decision                                                                                                          |
| ------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| polling episode     | One enabled dependency/restart-key generation of a frontend poller           | Owns one abort signal; stale episode results cannot commit state.                                                 |
| visibility          | Whether new frontend polling work may start                                  | Hidden documents stop timers; an already-running request may settle but an aborted/replaced episode cannot write. |
| watcher available   | Native event-driven Git watcher is installed                                 | Atomic state transition clears degraded/failure state.                                                            |
| watcher unavailable | Event-driven watcher is absent; Git status is maintained by polling fallback | Atomic state transition starts a fresh recovery backoff.                                                          |
| degraded            | User-visible health condition                                                | It does not by itself delete repository state or spawn another polling task.                                      |

## Verification

- `pnpm exec eslint` on all polling-related frontend files
- targeted `tsc --noEmit` diagnostics for every changed polling consumer
- `git diff --check` on the complete polling patch
- `cargo fmt --manifest-path crates/git/Cargo.toml --check`
- `cargo test -p git --lib` — 129 tests passed
- `cargo clippy -p git --all-targets -- -D warnings`
- focused frontend regressions for File Review, inline WebView commands, Browser replay config, and sidebar selection

## Final recommendation

Ship as a dedicated polling lifecycle PR. Keep it separate from the existing Hermes branch PR and from unrelated updater UX, i18n, imported-history, key-vault, and chat-history work present in the source worktree.
