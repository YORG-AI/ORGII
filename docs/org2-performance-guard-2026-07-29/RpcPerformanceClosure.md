# Performance Guard — RPC Performance Closure

**Scope:** the final PR #512 diff after removing unrelated product features.
**Date:** 2026-07-29

## Lifecycle matrix

| Dimension | Audited behavior |
| --- | --- |
| App | App-lifetime diagnostics and indexes are bounded; per-store coordinators are weakly owned; optional heap profiling is disabled by default. |
| Document | Non-critical polling and proposal countdowns pause hidden and revalidate once on return. |
| Network | Equivalent requests are single-flight; stronger or changed-scope requests serialize one trailing pass. |
| Identity | Existing authenticated/account resolution is preserved; this PR adds no cross-user cache. |
| Scope | Repo, project, browser, and sidebar requests carry scope/generation fences. |
| Session | Turn intents reach terminal state; restart reconciliation closes orphaned in-flight rows. |
| Instance | Jotai loader state is isolated per store; browser retention and diagnostic state have explicit teardown. |

## Findings and evidence

| Area | Verdict | Evidence | Change or reason kept | Verification |
| --- | --- | --- | --- | --- |
| Background work | fix | Visibility-aware pollers and the agent-control countdown previously retained work while hidden. | At most one recursive timer; clear hidden/unmount; one catch-up on return. | Visibility and countdown-focused frontend tests passed. |
| Memory | fix | RPC diagnostics, file indexes, browser webviews, and loader maps can live for the app lifetime. | Diagnostic/index bounds, two retained webviews, `WeakMap<Store, ...>` coordinators, explicit eviction/generation fences. | Browser lifecycle, cache, and coordinator tests passed. |
| Scope/isolation | fix | Sidebar consumers could overlap or let a stale source scope commit. | Per-store single-flight plus scope-aware serialized trailing refresh. | Sidebar loader suites: 23/23 passed, including store isolation and source changes. |
| Rendering/hot path | fix | A mixed commit removed project-list virtualization. | Restored `VirtualizedGroupedList`; retained only request-generation fencing. | Typecheck and UI audit passed. |
| Streaming/hot path | fix | Async chunk/snapshot helpers were invoked without polling their Futures. | Awaited every ACP, app-server, and standard-transport call; terminal events remain ordered after persistence work. | Rust workspace check passes with zero warnings. |
| I/O and persistence | fix | Adjacent session/intent writes and reconnect status reads could fan out or split. | Connection-scoped atomic helpers and one-connection bounded batch projection. | Turn-intent suite: 12/12 passed. |

## Verification

- Rust workspace `cargo check`: passed, zero warnings.
- Turn-intent persistence tests: 12/12 passed.
- Focused frontend lifecycle tests: 56/56 passed.
- TypeScript typecheck: passed.
- Rust formatting and final diff checks are delivery gates for this branch.
- Real Tauri visible-idle, hidden-idle, active-streaming, and repeated open/close measurements were not collected in this shell-only cleanup pass.

**Performance verdict: blocked — static lifecycle gates, compilation, and focused tests pass, but the required real Tauri runtime measurement was not collected.**
