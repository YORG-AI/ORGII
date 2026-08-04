# Session switch performance trace audit

## Scope

Session-switch User Timing instrumentation across WorkStation tab focus, the
session pipeline, persisted-history hydration, Jotai state commit, and the first
paint after loaded state reaches `ChatView`.

## Lifecycle matrix

| Lifecycle | Expected behavior | Verification | Verdict |
| --- | --- | --- | --- |
| Mount / active switch | Start or join one process-local trace for the target session. | Unit coverage exercises start, join, stages, and completion. | keep |
| Repeated switch | Supersede the previous active trace and retain only the latest 20 completed traces. | Unit coverage asserts stale User Timing entries are cleared after trace 20. | keep |
| Paint | Schedule two animation frames only after the target session reports loaded. | Hook cleanup cancels both scheduled frame IDs. | keep |
| Abort / unmount | Abort cleanup finishes the matching active trace; stale session callbacks are ignored. | Session ID matching is enforced by every mark/finish operation. | keep |
| Idle / hidden | No timer, observer, listener, poller, worker, or subscription is created by the trace module. | Static inspection of the module and hook. | keep |
| Multi-instance | Trace state and browser User Timing entries are local to each WebView process. | No persisted or cross-window state is introduced. | keep |

## Resource findings

| Area | Finding | Verdict | Reason / mitigation |
| --- | --- | --- | --- |
| CPU | Each lifecycle stage adds a bounded number of User Timing marks/measures. | keep | Work only occurs during an explicit session switch; no idle loop exists. |
| Memory | One active trace plus 20 completed traces are retained. | keep | Expired entries are removed from both module state and the browser performance timeline. |
| Rendering | `ChatView` observes session ID and load status to finish the trace after paint. | keep with measurement required | The subscriptions are narrow, but their actual render cost still requires a desktop/WebView profile. |
| Cancellation | The paint hook cancels scheduled animation frames on dependency change or unmount. | keep | Prevents a stale component from completing a newer session trace. |
| Persistence / I/O | Trace data is not persisted and creates no network, filesystem, or database I/O. | keep | Data remains in browser developer tooling only. |

## Verdict

**Pass for bounded instrumentation; runtime measurement pending.** The trace is
lifecycle-safe by inspection and unit coverage and can ship independently because
the PR makes no speedup claim. A packaged desktop/WebView profile is still required
before using the resulting data to claim a runtime performance improvement.
