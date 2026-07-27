---
name: org2-performance-guard
description: Prevent CPU, RAM, I/O, and background-work regressions in ORG2. Use when adding or reviewing polling, timers, Realtime subscriptions, event listeners, workers, streaming paths, caches, pagination, external-history scans, cloud sync, source-control loading, per-session state, or multi-instance behavior; also use before delivering a performance refactor or any feature that stays alive while the UI is idle or hidden.
---

# ORG2 Performance Guard

Apply a lifecycle-first performance audit to every changed runtime path. Preserve correctness and realtime behavior while making idle work demand-driven, shared, bounded, scoped, and disposable.

## Non-negotiable invariants

Require all applicable invariants before delivery:

- Keep idle CPU close to zero. Do not add continuous work merely to detect possible change.
- Prefer push invalidation over polling. Keep polling only as a documented, low-frequency safety net.
- Pause non-critical polling, scans, animation work, and retries while `document.visibilityState === "hidden"`; revalidate once on visibility/focus return.
- Treat durable outbox, lease, and safety work as explicit exceptions. Bound their frequency, backoff, and scope instead of disabling correctness-critical work blindly.
- Single-flight equivalent requests. Concurrent consumers must share one promise or coordinator.
- Key cloud/user data by endpoint + authenticated user + resource scope. Never key security-sensitive caches by `orgId` or `sessionId` alone.
- Bound every app-lifetime `Map`, `Set`, array, buffer, queue, log, and worker-owned session registry. Use LRU/TTL/pagination and explicit eviction.
- Evict per-session state on session deletion, worker crash/dispose, auth or endpoint switch, org removal, and feature unmount as applicable.
- Subscribe to the narrowest state slice. A session view must not rerender for unrelated sessions' streaming deltas.
- Coalesce bursty updates before crossing React, IPC, database, or serialization boundaries.
- Keep hot streaming/parser loops allocation-light. Avoid repeated clones, full-buffer parses, formatting, and JSON conversion per delta.
- Keep blocking filesystem, database, git, and process work off async executor threads and render-critical paths.
- Load large histories, request rounds, diffs, and replay segments on demand; do not eagerly materialize invisible data.
- Isolate secondary Tauri identities completely: data home, external-history home, ports, cookies/auth, and app-lifetime caches.
- Keep rendered E2E strict. Missing UI must fail with diagnostics; never turn a regression into `console.warn`, catch-and-continue, or a debug-helper bypass.

## Required workflow

### 1. Establish the performance surface

Read the changed call chain from its production entry point. Inventory every resource the change can create or retain:

- `setInterval`, recursive `setTimeout`, `requestAnimationFrame`, debounce, retry, backoff
- DOM/Tauri/network listeners and Realtime channels
- workers, subprocesses, watchers, file scans, git operations, database reads
- module globals, atom maps, per-store maps, promises, abort controllers, buffers
- React subscriptions, selectors, derived arrays, render-time sorting/grouping
- eager list/history/diff/replay loading

Use targeted searches, adapting paths to the diff:

```powershell
rg -n "setInterval|setTimeout|requestAnimationFrame|addEventListener|listen\(|subscribe|channel\(" src src-tauri
rg -n "new Map|new Set|WeakMap|cache|inFlight|buffer|queue|history" src src-tauri
rg -n "poll|refresh|retry|scan|watch|stream|delta|dispose|cleanup|abort" src src-tauri
```

Do not treat grep hits as findings. Trace ownership, start conditions, steady-state behavior, and cleanup.

### 2. Build the lifecycle matrix

For each resource, record the required behavior in these states:

| Dimension | States to check |
| --- | --- |
| App | start, idle, active, shutdown |
| Document | visible, hidden, focus return |
| Network | online, offline, retry/backoff |
| Identity | signed out, signed in, refresh, account switch, endpoint switch |
| Scope | personal org, cloud org, removed org, revoked share |
| Session | unopened, active, inactive, deleted, forked |
| Instance | primary, direct-launched secondary, launcher-created secondary |

Flag any resource whose owner or terminal state is ambiguous.

### 3. Choose the correct pattern

Apply the smallest applicable pattern:

- **Push + safety TTL:** subscribe to authoritative change events; use a slow TTL only to recover missed events.
- **Visibility-aware recursive timeout:** keep at most one timer, clear it while hidden, run once and reschedule on return. Prefer this over overlapping intervals.
- **Single-flight coordinator:** key by identity and resource, share the in-flight promise, carry an invalidation version/generation, and prevent stale completion from overwriting newer state.
- **Bounded LRU/TTL:** refresh recency on read, cap entry count, give failures a short TTL, and provide lifecycle eviction.
- **Per-store state:** use `WeakMap<Store, ...>` when multiple Jotai stores or rendered instances can exist in one process.
- **Narrow subscription:** use per-session atoms/selectors or keyed stores rather than reading a global delta map.
- **Burst coalescing:** batch updates once per frame or bounded debounce; preserve terminal/final events.
- **Demand-driven loading:** paginate or fetch details only after expansion/selection; retain only the visible or recently used window.
- **Generation guard:** discard late async results after stop, restart, account switch, endpoint switch, or a newer request.

### 4. Sweep equivalent paths

After finding one issue, search for every semantic peer. A fix is incomplete if another surface still owns a parallel implementation.

Typical ORG2 sweeps:

- Sidebar + management panel + share dialog + Work Item hooks fetching the same roster
- Visible and hidden polling paths
- Primary launcher and direct secondary executable startup
- Positive, negative, and in-flight cache entries
- Worker success, crash, dispose, session deletion, and app shutdown
- Local session, cloud member session, guest import, fork, and external CLI history
- Production action and rendered E2E action

Unify duplicate resource ownership before tuning individual call sites.

### 5. Protect correctness and privacy

Performance changes must not weaken:

- realtime propagation after push invalidation
- revocation/removal disappearance
- durable outbox retries and tombstones
- account/endpoint/org data isolation
- first-load and focus-return freshness
- session fork/history integrity
- terminal streaming events

Capture identity and generation at request start. Before committing a result, confirm the current identity/generation still matches. Do not display a previous identity's cached rows while refreshing.

### 6. Verify proportionally

Always run:

- targeted unit tests for cache bounds, coalescing, invalidation, visibility, and stale-result rejection
- TypeScript typecheck and lint for changed frontend files
- Rust unit tests/checks for changed backend modules; if the shared Cargo cache is corrupt or policy-blocked, report it and use the narrowest valid independent compilation without deleting broad caches
- `git diff --check`

For rendered/background changes, also run the real Tauri surface when available:

1. Observe primary and secondary instances separately.
2. Measure visible idle, hidden idle, active streaming, and post-close/post-delete behavior.
3. Exercise account switch, endpoint switch, and direct secondary launch when relevant.
4. Confirm request/subscription/timer counts stabilize rather than grow after repeated open/close cycles.
5. Confirm strict rendered E2E uses user-visible actions for the behavior under assertion.

Do not claim a performance improvement from code shape alone. State the evidence actually collected and any environment blocker.

## Review rejection rules

Reject or revise a change when any applicable answer is unknown or false:

- Who owns this background resource, and exactly when is it stopped?
- Can this timer overlap itself or continue while hidden?
- Why is polling necessary instead of invalidation?
- Can two mounted consumers issue the same request?
- Does the cache have a maximum size, freshness rule, identity key, and eviction event?
- Can an old async completion write after a newer request or identity switch?
- Does one session's update wake unrelated session views?
- Does a growing transcript/history/diff require full eager materialization?
- Does a direct secondary launch inherit primary external history or auth state?
- Can a missing rendered element be skipped while the E2E still passes?

## Required delivery output

Report findings and evidence in this compact form:

| Area | Verdict | Evidence | Change or reason kept | Verification |
| --- | --- | --- | --- | --- |
| Background work | fix / keep | timer/subscription owner and cadence | exact lifecycle decision | test or measurement |
| Memory | fix / keep | retained structure and growth bound | cap/TTL/eviction | bound/eviction test |
| Scope/isolation | fix / keep | cache/request key | identity/generation guard | switch/revocation test |
| Rendering/hot path | fix / keep | subscription/allocation trace | narrowing/coalescing | render or unit evidence |

End with:

- `Performance verdict: pass` only when every applicable invariant is evidenced.
- `Performance verdict: blocked` when required real measurement or compilation cannot run; name the blocker.
- `Performance verdict: fail` when an unbounded, duplicate, hidden-active, stale-write, or cross-identity path remains.

Never promise that a skill can make regressions impossible. Enforce the gates, expose unknowns, and refuse an unsupported green verdict.
