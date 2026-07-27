# Performance Guard — Uncommitted Runtime Batch

**Scope:** changed polling, listeners, caches, queues, scans, request coordinators, webviews, session lifecycles, and streaming finality on `junyu/rpc-performance-closure`.
**Date:** 2026-07-27

## Lifecycle matrix

| Dimension | Audited behavior |
| --- | --- |
| App | Module caches are bounded or weakly owned; durable queue initialization retries after transient failure; Rust blocking scans stay off async executor threads. |
| Document | Proposal countdown pauses while hidden; native webview layout/URL work is active only for visible webviews; focus-based GitHub verification unregisters after confirmation. |
| Network | Equivalent repo/project/benchmark/history requests coalesce; generations reject stale completions; failures do not become permanent queue-store state. |
| Identity | Team Inbox cloud state keys endpoint + authenticated user + org; receipt overlays use the latest identity-scoped state. |
| Scope | Repo/project/file-index keys include the complete resource scope and invalidate by generation. |
| Session | Queue persistence is per Jotai store; secondary ChatView releases its pipeline claim; session deletion/disposal paths retain their explicit cleanup. |
| Instance | No new cross-process shared mutable frontend cache was added; filesystem and auth separation for secondary processes is unchanged. |

## Findings and evidence

| Area | Verdict | Evidence | Change or reason kept | Verification |
| --- | --- | --- | --- | --- |
| Background work | fix | Proposal countdown previously rendered at animation-frame cadence; GitHub star fallback retained a focus listener after success; hidden webviews could retain layout work. | Countdown now updates at most once per second and pauses hidden; confirmation clears fallback/listener state; layout work is visibility gated. | Changed frontend suite includes GitHub focus regression and webview visibility/layout tests; 214/214 passed. |
| Background work | keep | Existing visible inline-webview URL polling owns one startup timeout and one interval, cleared on hidden/unmount/destroy. | Kept as navigation-state fallback; no overlap is introduced by this batch. | Visibility and native-layout lifecycle tests passed. |
| Memory | fix | File indexes, RPC validation diagnostics, browser webviews, repo/project coordinators, and durable queue state are app/session lifetime structures. | File index uses bounded keyed cache + generation invalidation; RPC diagnostics cap at 200; browser retains at most two navigable webviews; queue subscription is `WeakMap<Store, ...>` owned. | File-index coalescing/invalidation/recovery tests, RPC bound tests, browser retention tests, and queue persistence tests passed. |
| Scope/isolation | fix | Team Inbox page completion captured an old receipt map; repo/file/project requests can finish after invalidation. | Latest receipt ref is applied at commit; identity-complete keys and generation guards reject stale writes. | Team Inbox identity tests, project cache/purge tests, repo coordination tests, file-index invalidation tests, and sidebar loader stale-result tests passed. |
| Rendering/hot path | fix | Agent proposal countdown previously woke the full creator tree at about 60 FPS; ChatView lifecycle logic was duplicated inline. | Timer cadence is one second and hidden-paused; session side effects have one lifecycle owner. | ESLint/TypeScript passed; affected hook and state suites passed. |
| I/O and scans | fix | Concurrent file searches, repo loads, external-history rescans, benchmark loads, and project refreshes could duplicate work or accept stale results. | Equivalent work is single-flight; scans run in blocking Rust context; mutation/invalidation generations fence old completions. | Rust search tests and changed frontend coordinator/rescan tests passed. |
| Streaming/finality | fix | `agent:complete` was treated as authoritative completion before `agent:turn_completed`. | Intermediate completion is tagged and terminal/final events remain authoritative. | Rust-agent stream handler suite passed. |

## Verification

- Changed frontend ESLint: passed.
- TypeScript typecheck: passed.
- Changed frontend tests: 33 files, 214 tests passed.
- Rust workspace all-target check: passed.
- Affected Rust library tests: passed, including 3,081 `agent_core`, 508 `project_management`, 51 `search`, and 5 `transport` tests.
- Changed Rust files `rustfmt --check`: passed.
- `git diff --check`: passed.
- Real Tauri primary/secondary visible-idle, hidden-idle, active-streaming, and repeated open/close measurement was not run in this audit environment.

**Performance verdict: blocked — compilation and lifecycle/bound tests pass, but the required real Tauri runtime measurement was not collected.**
