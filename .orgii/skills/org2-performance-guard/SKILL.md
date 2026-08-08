---
name: org2-performance-guard
description: Prevent CPU, RAM, I/O, background-work, and false-green lifecycle regressions in ORG2. Use when adding or reviewing polling, timers, Realtime subscriptions, event listeners, workers, streaming paths, caches, pagination, provider-owned transcript ingestion or identity/dedupe, external-history scans, cloud sync, source-control loading, per-session state, true-machine verification, or multi-provider/multi-instance behavior; also use before delivering a performance refactor or any feature that stays alive while the UI is idle or hidden.
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
- Treat provider ingestion, local identity/listability, UI hydration, cloud transport, and remote rendering as separate verification boundaries. Passing A-to-B sync does not prove the upstream local lifecycle.
- Test every provider and raw source transition claimed by the change. Do not infer Claude Code compaction coverage from Codex append coverage, or vice versa.
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

| Dimension | States to check                                                 |
| --------- | --------------------------------------------------------------- |
| App       | start, idle, active, shutdown                                   |
| Document  | visible, hidden, focus return                                   |
| Network   | online, offline, retry/backoff                                  |
| Identity  | signed out, signed in, refresh, account switch, endpoint switch |
| Scope     | personal org, cloud org, removed org, revoked share             |
| Session   | unopened, active, inactive, deleted, forked                     |
| Instance  | primary, direct-launched secondary, launcher-created secondary  |
| Source    | discover, append, large append, compact/rewrite, rotate, delete |
| UI        | clean load, old row active/open/pinned during refresh, restart  |
| Transport | local ingest, upload, remote download, reconnect                |

Flag any resource whose owner or terminal state is ambiguous.

### 3. Separate provider lifecycle from machine topology

For provider history, session identity, dedupe, or sync work, build a coverage matrix before testing:

| Axis           | Minimum relevant states                                                          |
| -------------- | -------------------------------------------------------------------------------- |
| Provider       | every changed provider plus every provider explicitly claimed as working         |
| Raw transition | create, append, large append, compact/rewrite, rotate, fork/subagent, delete     |
| App timing     | cold start, source changes while ORG2 is open, rescan, restart                   |
| UI state       | clean roster, previous row active/open/pinned, search/filter/load-more as needed |
| Topology       | local ingest, isolated secondary, A upload, B download/reconnect                 |

Apply these validity rules:

- Treat each matrix cell as independent evidence. Two machines exercise topology; they do not create provider compaction, rotation, or lineage transitions automatically.
- Exercise the raw provider artifact or a faithful before/after fixture. Do not seed only normalized cache/database rows when the parser, watermark, identity, lineage, or dedupe contract is under test.
- Derive identity markers from the raw artifact. Do not fabricate identical group keys that merely restate the implementation assumption.
- Include an assumption-breaking fixture for identity logic: for example, a rewritten transcript head with a changed first-message UUID but a preserved ancestry marker.
- Observe local ingest and listability before enabling or asserting cloud upload. Then verify upload cursor/payload and remote rendering separately.
- Keep the previous session active, open, or pinned while applying the source transition when exact-id hydration or force-reveal paths exist.
- Repeat rescan/restart once to prove idempotence and stable row/resource counts.
- Name every unexecuted provider or transition. Never summarize partial coverage as “multi-provider,” “dual-machine,” or “full lifecycle.”

### 4. Choose the correct pattern

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

### 5. Sweep equivalent paths

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

### 6. Protect correctness and privacy

Performance changes must not weaken:

- realtime propagation after push invalidation
- revocation/removal disappearance
- durable outbox retries and tombstones
- account/endpoint/org data isolation
- first-load and focus-return freshness
- session fork/history integrity
- terminal streaming events

Capture identity and generation at request start. Before committing a result, confirm the current identity/generation still matches. Do not display a previous identity's cached rows while refreshing.

### 7. Verify proportionally

Always run:

- targeted unit tests for cache bounds, coalescing, invalidation, visibility, and stale-result rejection
- TypeScript typecheck and lint for changed frontend files
- Rust unit tests/checks for changed backend modules; if the shared Cargo cache is corrupt or policy-blocked, report it and use the narrowest valid independent compilation without deleting broad caches
- `git diff --check`

For rendered/background changes, also run the real Tauri surface when available:

1. Isolate primary and secondary data homes, provider roots, auth, ports, and processes.
2. Capture a baseline: raw files, cache rows/listability, active/open/pinned row, cursor/epoch, payload count, process count, CPU, and RSS as applicable.
3. Apply the raw source transition while ORG2 is already open. For compaction/rewrite/rotation, stage or produce the actual before/after artifact instead of pre-populating the final database state.
4. Assert local parsing, identity/lineage, exact row count, listability, timestamp, and sidebar behavior before cloud transport can hide the owning-boundary failure.
5. Keep an old row active/open/pinned, rescan, and assert that hydration does not resurrect a superseded sibling or hide the active row entirely.
6. Verify A upload and B download/reconnect separately, including cursor/epoch and exact appended payload counts when incremental behavior is claimed.
7. Rescan and restart once; confirm data and request/subscription/timer/process counts remain stable.
8. Measure visible idle, hidden idle, active work, and post-close/post-delete behavior.
9. Exercise account switch, endpoint switch, and direct secondary launch when relevant.
10. Confirm strict rendered E2E uses user-visible actions for the behavior under assertion.

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
- Which provider and raw source transition produced the evidence for each compatibility claim?
- Did the test inspect local ingest and identity before testing cloud transport?
- Did it keep the previous row active/open/pinned across rescan or only test a clean roster?
- Were family/identity keys parsed from raw artifacts, or fabricated to match the implementation?
- Did “dual-machine” testing merely replicate an already-normalized final state?
- Can a missing rendered element be skipped while the E2E still passes?

## Required delivery output

Report findings and evidence in this compact form:

| Area               | Verdict    | Evidence                             | Change or reason kept     | Verification            |
| ------------------ | ---------- | ------------------------------------ | ------------------------- | ----------------------- |
| Background work    | fix / keep | timer/subscription owner and cadence | exact lifecycle decision  | test or measurement     |
| Memory             | fix / keep | retained structure and growth bound  | cap/TTL/eviction          | bound/eviction test     |
| Scope/isolation    | fix / keep | cache/request key                    | identity/generation guard | switch/revocation test  |
| Rendering/hot path | fix / keep | subscription/allocation trace        | narrowing/coalescing      | render or unit evidence |

For provider ingestion, session identity, or sync work, also report:

| Provider       | Raw transition    | App/UI state                 | Topology/boundary           | Expected invariant                        | Observed evidence            |
| -------------- | ----------------- | ---------------------------- | --------------------------- | ----------------------------------------- | ---------------------------- |
| exact provider | actual transition | cold/live/active-row/restart | local/A-to-cloud/cloud-to-B | exact rows, identity, cursor, payload, UI | measured result or `not run` |

Use one row per materially distinct matrix cell. A shared implementation permits shared unit coverage only at the shared boundary; each provider adapter still needs representative raw input before claiming compatibility.

End with:

- `Performance verdict: pass` only when every applicable invariant is evidenced.
- `Performance verdict: blocked` when required real measurement, provider transition, or compilation cannot run; name the blocker and the uncovered matrix cells.
- `Performance verdict: fail` when an unbounded, duplicate, hidden-active, stale-write, or cross-identity path remains.

Never promise that a skill can make regressions impossible. Enforce the gates, expose unknowns, and refuse an unsupported green verdict.
