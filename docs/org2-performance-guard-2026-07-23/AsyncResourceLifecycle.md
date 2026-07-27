# Performance Guard — Async Resource Lifecycle

**Scope:** migrated resource fetches, background polling, request caches, and multi-scope lifecycle.
**Date:** 2026-07-23

## Lifecycle matrix

| State | Required behavior | Audited behavior |
| --- | --- | --- |
| Visible and active | Fetch on demand at configured cadence | Recursive polling; next delay starts after settlement |
| Visible and idle | Avoid full reload unless dirty or scheduled safety refresh | DOM uses dirty-check; other retained polls are bounded safety refreshes |
| Hidden | No non-critical polling timer | Timer cleared; visibility return triggers one catch-up pass |
| Scope switch | Previous data and completion cannot appear | Complete scope key plus generation fence |
| Unmount/disable | Stop timer/listener and reject late commits | Poll controller cleanup plus coordinator supersede |
| Offline/error | Set current resource error without a retry storm | No automatic tight retry; configured cadence resumes |
| Repeated mount | No app-lifetime accumulation | Per-hook coordinator owns one active promise; listeners/timers dispose |

## Findings and evidence

| Area | Verdict | Evidence | Change or reason kept | Verification |
| --- | --- | --- | --- | --- |
| Background work | fix | DOM, Inspector, Console, Network, LSP, Git auto-fetch, and Gateway used or consumed polling | Replaced non-critical intervals with visibility-aware non-overlapping recursive polling; DOM teardown received an additional active fence | Visibility controller tests plus focused lifecycle review |
| Memory | fix/keep | Resource retains one state and one active promise; Console cache is 10 sessions × 500 rows, Network is 10 × 200, commit cache is 50 | Preserved existing caps; removed duplicate per-resource state; no new unbounded collection | Unit tests, code inspection |
| Scope/isolation | fix | Previous implementations used local mounted/cancelled flags or incomplete commit cache identity | Complete scope keys and generations now gate every commit; commit cache includes repo identity | Stale-filter, stale-scope, superseding-refresh tests |
| Rendering/hot path | fix | Foreground state was repeatedly toggled by background refreshes | Background reload retains data and avoids spinner flashes; derived grouping remains memoized | Async-resource and polling hook tests |

## Verification

- `pnpm run typecheck`: passed.
- Focused ESLint: passed.
- Focused Vitest: 10 files, 118 tests passed.
- `git diff --check`: passed.
- Real Tauri visible/hidden IPC and CPU measurement was not run in this audit environment.

**Performance verdict: blocked only on real Tauri runtime measurement; static lifecycle gates, compilation, lint, and focused regression tests pass.**
