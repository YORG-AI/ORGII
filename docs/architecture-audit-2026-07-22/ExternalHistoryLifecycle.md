# Architecture Audit — External-history refresh and lazy-turn lifecycle

**Scope:** Focus-adaptive refresh scheduling, hidden/unmount teardown, direct session switching, lazy historical-turn bookkeeping, and stale async completion rejection

**Date:** 2026-07-22

**Auditor:** Codex

## Acceptance criteria

- [x] The active external-history Session owns at most one refresh timer and one refresh request.
- [x] Focused cadence uses the configured 3-second to 1-minute interval.
- [x] An unfocused window arms a real 60-second timer instead of waking at the foreground cadence.
- [x] A hidden document owns no timer and aborts the active probe/load.
- [x] Focus or visibility return performs one immediate catch-up and resumes the correct cadence.
- [x] Unmount, Session switch, and feature disable remove timers/listeners and abort in-flight work.
- [x] Direct A→B loading and explicit clear both evict the departing Session's lazy-turn registry.
- [x] A late async turn load cannot resurrect registry state after clear or Session switch.

## 10-layer audit

### Layer 1 — Compilation correctness

- TypeScript `tsc --noEmit` passes.
- Three focused Vitest files pass 21 tests covering refresh, scheduling, Session actions, and registry lifecycle.
- The follow-up changes no Rust module or wire schema, so a Rust build is not required for this TypeScript-only lifecycle patch.

### Layer 2 — Dead code and structural deduplication

- Removed the `setInterval` plus `lastAttemptAt` design that created foreground-cadence wakeups merely to reject unfocused work.
- `startExternalHistoryRefreshScheduler` is the single owner of focus, blur, visibility, timer, and in-flight scheduling state.
- Existing `startVisibilityAwarePoller` remains intentionally separate: it models a fixed visible cadence and cannot reschedule immediately between focused and unfocused cadences.
- Lazy-turn bookkeeping still has one registry and one pending-load map; the patch adds a generation guard rather than a parallel cache.

### Layer 3 — Naming consistency

| Term                            | Meaning                                                        | Verdict                                     |
| ------------------------------- | -------------------------------------------------------------- | ------------------------------------------- |
| `foregroundIntervalMs`          | Configured active-view refresh cadence                         | Keep; its scope is explicit                 |
| `UNFOCUSED_REFRESH_INTERVAL_MS` | Actual timer delay while the window lacks focus                | Keep; no longer a request-only throttle     |
| `registryGenerationBySession`   | Episode identity for one Session's lazy-load registry          | Keep; distinguishes stale async completions |
| `clearLoadedTurnRegistry`       | Evict loaded and pending bookkeeping for one departing Session | Keep; used by both clear and direct switch  |

### Layer 4 — Semantic overloading

- Window focus and document visibility remain distinct inputs: blur changes cadence, while hidden visibility suspends work and aborts the current request.
- A transcript signature remains a freshness probe, not a loaded-body cache key.
- Registry generation identifies a load lifecycle episode; it is not reused as an EventStore version or transcript revision.

### Layer 5 — Default branch analysis

- Disabled external Sessions, null Session IDs, and native ORG2 Sessions own no scheduler.
- Hidden is the strongest state and owns no timer regardless of focus.
- Visible/unfocused schedules 60 seconds; visible/focused schedules the configured cadence.
- Focus/visibility events during an in-flight request do not overlap it. Visibility return records one catch-up after the aborted request settles.
- Disposal wins over all later completions and prevents re-arming.

### Layer 6 — Cross-domain concept leakage

- Scheduling stays inside SessionCore external-history sync and does not modify global cloud, Work-item, Git, or diagnostics pollers.
- The environment interface contains only lifecycle/time primitives and no Codex-, Claude-, or provider-specific fields.
- Lazy-turn generation state stays beside the loaded-turn registry and does not enter Jotai atoms or backend EventStore versions.

### Layer 7 — New-developer confusion test

- The scheduler comment states the key invariant: one timer, no hidden timer, and a real unfocused cadence.
- `captureLoadedTurnRegistryGeneration` is called at the async load boundary; `markTurnBodyLoaded` rejects a generation that was invalidated by clear.
- Direct `loadSessionAtom` switching now mirrors the cleanup already performed by `clearSessionAtom`, next to the existing departing-snapshot release.

### Layer 8 — Wire protocol and serialization

- No RPC name, payload, transcript format, Session ID format, or persisted schema changes.
- Existing `(mtimeMs, sizeBytes)` signatures and bounded turn-window RPC payloads are unchanged.
- Abort remains local lifecycle control; it does not introduce a new serialized field.

### Layer 9 — Init and entry-point parity

| Entry path                                        | Scheduler/cleanup behavior                                                       |
| ------------------------------------------------- | -------------------------------------------------------------------------------- |
| Normal sidebar/WorkStation Session jump           | `clearSessionAtom` evicts lazy-turn state before loading                         |
| Direct `loadSessionAtom` A→B transition           | Now performs the same registry eviction before snapshot release                  |
| Same-Session transcript refresh                   | Keeps the registry episode; replace semantics update the active bounded snapshot |
| External Sessions disabled or component unmounted | Stops scheduler, removes three listeners, aborts active work                     |
| Hidden → visible or unfocused → focused           | One immediate catch-up, then the cadence matching current focus                  |

### Layer 10 — Resolver symmetry

| State                    |                   Timer delay | Immediate action           | In-flight policy                             |
| ------------------------ | ----------------------------: | -------------------------- | -------------------------------------------- |
| Visible + focused        | Configured 3 seconds–1 minute | On focus/visibility return | Single-flight                                |
| Visible + unfocused      |                    60 seconds | Visibility return only     | Single-flight                                |
| Hidden                   |                          None | Abort current work         | No new work                                  |
| Disposed/session changed |                          None | Abort current work         | Late completion cannot re-arm or re-register |

Every scheduling transition resolves the same three decisions—visibility, focus cadence, and in-flight ownership—through the same scheduler.

## Systematic sweep

- Swept the external-history auto-refresh path for `setInterval`, request-only throttles, focus/blur handling, hidden work, overlap, and teardown.
- Swept lazy-turn registry reads/writes across normal clear, direct A→B load, pending completion, and repeated reopen.
- Compared the fixed-cadence shared visibility poller before keeping a dedicated focus-adaptive scheduler.
- Reconciled the original performance report against every post-audit commit and retained all unrelated open findings as open rather than inferring they were fixed by UI virtualization.
