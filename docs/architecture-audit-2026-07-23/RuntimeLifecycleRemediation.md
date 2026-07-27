# Architecture Audit — Runtime lifecycle and retained-state remediation

**Scope:** Work-item scheduling, provenance ingestion, terminal persistence, Git watcher state, browser/config diagnostics, repository indexes, streaming accumulators, and multi-session cleanup

**Date:** 2026-07-23

**Auditor:** Codex

## Acceptance criteria

- [x] Idle and hidden application states do not continuously poll the audited surfaces.
- [x] Recurring work has one owner, no overlap, and explicit teardown.
- [x] App-lifetime caches use count plus byte bounds where payload size varies.
- [x] Multi-session scheduling does not create one timer/thread per stream.
- [x] Identity, Session, repository, pane, and component disposal paths release retained state.
- [x] Existing RPC names and persisted schemas remain compatible.

## 10-layer audit

### Layer 1 — Compilation correctness

- `tsc --noEmit` passes.
- `cargo check` passes for `org2`, `agent_core`, and `git`; focused `search`, `git`, and `session_persistence` Rust tests pass.
- Focused Vitest suites cover cache byte budgets, stream bounds, visibility lifecycle, browser diagnostics, external-history scheduling, and Work-item invalidation.

### Layer 2 — Dead code and structural deduplication

- Work-item message/file/diff consumers share one Session event channel rather than owning independent intervals.
- Application-memory snapshots have one process-wide store and one non-overlapping visible scheduler.
- Turn-index rebuilds share one exact-deadline Condvar worker instead of one sleeping OS thread per streaming Session.
- Git watcher recurring paths use lightweight projections rather than cloning complete cached `GitStatus` objects.

### Layer 3 — Naming consistency

| Term                         | Meaning                                                                               | Verdict       |
| ---------------------------- | ------------------------------------------------------------------------------------- | ------------- |
| `schedule` / `nextDelayMs`   | The next authoritative deadline, not an elapsed-time scan                             | Keep          |
| `MAX_*_BYTES`                | A hard retained-memory boundary measured with the representation documented beside it | Keep          |
| `startVisibilityAwarePoller` | One visible-only, non-overlapping recursive poll loop                                 | Keep          |
| `detached` / `hidden`        | No renderer consumer or no visible document; both suppress delivery/background work   | Keep distinct |

### Layer 4 — Semantic overloading

- Entry-count limits are not treated as memory limits; CSV/XLSX, terminal, repository-index, activity, approval, syntax, storage, channel, and stream paths now add byte limits.
- “Polling” is retained only for feature-scoped observation without a push contract; scheduling, retry, and due-work semantics use exact deadlines or invalidation.
- External CLI inherited history and live reply deltas remain separate: history is paged, while live typewriter state is capped and replaced by the authoritative final event.

### Layer 5 — Default branch analysis

- Hidden document: no external-history, Git auto-fetch, browser inspector/DOM, gateway/config/LSP, or memory-snapshot timer remains armed.
- No active Work item: no message/file/diff poller exists; backend owns only an exact deadline and a bounded 30-minute durability rescan.
- No pending provenance records: the consumer is parked until the producer wake endpoint fires.
- No pending turn-index rebuild: the single worker blocks on a Condvar.
- Oversize cache entry: reject caching or retain only a capped tail; do not silently exceed the global budget.

### Layer 6 — Cross-domain concept leakage

- Scheduling helpers expose lifecycle primitives rather than Work-item, Git, browser, or provider concepts.
- Repository health projections stay in the Git state store and do not leak cached file lists to the monitor.
- Terminal persistence owns serialization limits; the renderer cache owns interactive LRU/byte limits.
- External CLI stream bounds live in shared adapter helpers and apply symmetrically to Codex/Claude and Rust-agent transports.

### Layer 7 — New-developer confusion test

- Every remaining safety rescan states why it exists and its upper cadence.
- Cache constants distinguish per-entry, global-byte, and entry-count limits.
- The turn-index worker documents the exact-deadline/Condvar invariant.
- The performance report records keep-with-reason cases instead of inviting another site-by-site polling rewrite.

### Layer 8 — Wire protocol and serialization

- No public RPC name, cloud payload, Session-share wire shape, or persisted database schema changed.
- Tauri events remain the authoritative Work-item/session invalidation path.
- Terminal disk format remains version 1; only in-memory retention and flush ownership changed.
- LSP, browser, Git, and gateway responses retain their existing wire shapes.

### Layer 9 — Init and entry-point parity

| Entry path                    | Ownership and cleanup                                                                        |
| ----------------------------- | -------------------------------------------------------------------------------------------- |
| Cold app start                | One-time hydration/reconciliation, then parked/event-driven workers                          |
| Session or repository switch  | Old identity/repository state is evicted; new state performs one catch-up                    |
| Hidden/minimized window       | Timers are cleared and in-flight completion cannot re-arm them                               |
| External Codex/Claude Session | Bounded initial history, on-demand older turns, capped live stream state                     |
| Terminal pane close/unmount   | Listener detaches, queue/cache limits apply, pending persistence flushes on lifecycle events |
| Repeated feature open/close   | Listeners, observers, timeouts, and per-key maps remove their owner state                    |

### Layer 10 — Resolver symmetry

- Visible/hidden transitions use the same stop → optional catch-up → reschedule sequence across shared pollers.
- Session/repository identity changes always clear the departing key before loading the new key.
- Success and error both settle in-flight ownership before retry scheduling.
- Final, cancelled, interrupted, and superseded streams all clear transient buffers; the durable final event remains authoritative.

## Systematic sweep

- Swept production `setInterval`, recursive `setTimeout`, retry, watcher, heartbeat, streaming, and due-work paths under `src/` and `src-tauri/`.
- Swept module/static `Map`, `Set`, array, queue, spool, snapshot, and index retention for count, byte, TTL, and disposal bounds.
- Verified semantic peers after each fix: all Work-item consumers, all external/Rust streaming adapters, all Git watcher recurring readers, browser diagnostic surfaces, and terminal memory layers.
- Kept active pinned EventStore/snapshot paging as a documented load-scale monitor; safely discarding an executing Session’s authoritative in-memory graph requires a separate persistence-backed paging contract.
