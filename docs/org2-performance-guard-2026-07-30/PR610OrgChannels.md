# PR #610 Org Channels — Performance Guard

**Date:** 2026-07-30

**Verdict:** pass after bounds and lifecycle fixes

| Surface                    | Active                                                                                                   | Idle                                | Hidden/background                                                                                                                          | Repeated open/close                                                                                                                  | Multi-instance                                                                              | Verdict |
| -------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- | ------- |
| Cloud channel listing      | One capability check per consumer; identical in-flight list RPCs coalesce by identity/org/archive scope. | No polling or timer.                | Existing realtime foreground lease owns disconnect/recovery; focus regain and hidden-to-visible each trigger one coalesced catch-up fetch. | Focus/visibility listeners unsubscribe on effect cleanup; single-flight entries are removed in `finally`; no retained request cache. | Each process has its own bounded in-flight map; backend reads remain one per process/scope. | pass    |
| Channel-tab reconciliation | O(number of open tabs) after an authoritative list changes.                                              | No work.                            | No work while the listing is not refreshed.                                                                                                | Stable memoized active/archived arrays prevent render-only effect churn.                                                             | Each instance closes only its own inaccessible tabs.                                        | pass    |
| Boot orphan sweep          | One O(messages + channels) pass after local storage hydration.                                           | No timer or subscription.           | No recurring work.                                                                                                                         | Effect has a stable write-atom dependency; hard deletes purge directly.                                                              | Device-local by design.                                                                     | pass    |
| Local message persistence  | Post/edit enforce 500 live rows/channel, 2,000 total rows, and 4 MiB serialized UTF-8.                   | Bounded retained state.             | No background writer.                                                                                                                      | Selector-family entries are evicted on delete/orphan sweep.                                                                          | Per-device localStorage; no shared amplification.                                           | pass    |
| Local channel registry     | 200 active and 1,000 total active+archived rows.                                                         | Bounded retained state.             | No background work.                                                                                                                        | Archive/unarchive idempotence avoids redundant writes.                                                                               | Per-device localStorage.                                                                    | pass    |
| Realtime diagnostics       | Raw client logs error/time-out statuses once at the owning transport.                                    | Normal `CLOSED` teardown is silent. | Hidden teardown is not treated as a failure.                                                                                               | No warning storm across normal reconnect cycles.                                                                                     | Per-instance diagnostics remain attributable.                                               | pass    |

## Resource-bound evidence

- Unit tests exercise the per-channel cap, global row cap, 4 MiB byte guard,
  tombstone compaction, 1,000-row channel registry cap, one-shot orphan purge,
  selector-family eviction, and same-scope list-request coalescing.
- Byte accounting performs one full serialization when a hydrated array is
  first seen, then caches the exact JSON byte count in a `WeakMap`. A normal
  append or edit updates that count from the serialized changed row instead of
  reserializing the whole store.
- No interval, retry loop, worker, or unbounded cache was added.
- The focus-recovery listener is event-driven, performs no idle work, and
  removes both the window-focus and document-visibility handlers on unmount.

## Dual-instance whole-process baseline

The first live run sampled the full process tree for both development builds,
not only the channel feature:

| State                        | Main instance                                                                          | Instance 2                                                                             |
| ---------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Initial                      | 9 processes; 788.2 MiB working set; 464.6 MiB private; 4,191 handles; 194 threads      | 8 processes; 714.4 MiB working set; 403.1 MiB private; 4,032 handles; 191 threads      |
| 15 s active sample           | 823.4 MiB working set; 487.2 MiB private; 4,228 handles; 190 threads; 4.8 CPU seconds  | 738.9 MiB working set; 415.0 MiB private; 3,932 handles; 188 threads; 0.14 CPU seconds |
| 15 s hidden/minimized sample | 798.9 MiB working set; 461.2 MiB private; 4,232 handles; 194 threads; 0.89 CPU seconds | 730.8 MiB working set; 407.5 MiB private; 3,957 handles; 195 threads; 0.91 CPU seconds |

These are diagnostic baselines from an animated development UI with other
background features active. They do not isolate discussion-channel cost and do
not support a causal memory/CPU improvement claim.

## Claim boundary

The static and unit evidence establishes bounded work and lifecycle cleanup.
The live samples establish that both isolated instances remained responsive
through repeated create/rename/archive/membership/delete transitions; they do
not by themselves claim lower WebView frame time, memory, or CPU.
