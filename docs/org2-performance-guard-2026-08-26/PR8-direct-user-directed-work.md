# ORG2 Performance Guard — Direct UserDirectedWork

Design budgets: §20 and §30. This audit covers the new FIFO handoff, durable
receipt, activity projection, startup recovery and repeated Member-page
lifecycle. It does not treat typecheck or code shape as measured performance.

| Area                 | Verdict | Evidence                                                                                                                                                                                                                                                                                                | Change or reason kept                                                                                                                                                                                                                                                            | Verification                                                                                                                                                                                                                            |
| -------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider concurrency | keep    | Direct and formal work use the existing one-worker `DialogScheduler`; handoff releases an exact lease before direct work can run.                                                                                                                                                                       | No second runtime, dispatcher, worker or temporary lane. The same warm runtime pointer is rebound with a fresh lease and a different pointer fails closed.                                                                                                                       | Lease/generation CAS tests, exact FIFO/Stop tests and packaged real-provider evidence show one active Member Provider Turn; the successful busy handoff released the formal lease in 121ms before UDW started.                          |
| Waiting and timers   | fix     | The old 180-second TTL, expiry timer and Return polling are deleted. Yield uses two bounded five-second waits; late job completion is a one-shot event plus watch revision.                                                                                                                             | Keep the existing shared Run View visible-Working fallback poll. Intervention itself adds no interval, per-Member timer or page-lifetime expiry work.                                                                                                                            | Source scan finds no new interval/poll/sleep. The successful live handoff was 121ms; a deliberately stalled fixture projected `yield_timeout` at the 10-second hard boundary without opening a second runtime.                          |
| Memory bounds        | keep    | Direct queue defaults to 32 per Member; targeted cancellation tombstones are capped at 64; startup recovery and continuation reads are bounded. Run View creates one bounded latest-returned map per request.                                                                                           | Durable SQLite owns history; memory retains ids/counts/runtime references, not message-body copies or an unbounded second owner.                                                                                                                                                 | N+1 removal verified by source review; queue-cap and 50-way concurrency tests pass.                                                                                                                                                     |
| Database and I/O     | fix     | Acceptance is one IMMEDIATE transaction. Quiescence no longer queries intervention per Member; Run View projects active/latest-returned receipts in bounded set reads. Team Delete removes Session-owned OrgTrack history inside its existing writer transaction and verifies no residual after commit. | Direct source validation is paid only on Agent Org Member direct sends. Ordinary SDE processor/Stop/finalizer paths do zero new Agent Org lookup. Delete performs bounded work across a fixed table list and retains shared resource identities that contain no Session history. | Owning-boundary and 12/12 focused Delete persistence tests pass. Five-minute packaged request captures showed no PR8 resolver/Run View/Member Wake query while Idle or hidden. A real packaged Delete left zero Session-scoped history. |
| Terminal quietness   | keep    | UDW terminal path stops Provider/stream/shell owner work, skips memory/goal/TaskOutput/formal lifecycle and kicks only the existing FIFO. Warm runtime may remain allocated but is not an active Provider.                                                                                              | No automatic Return on time, close, Stop or restart. Pending work recovers once; started side effects are not replayed.                                                                                                                                                          | Finalizer isolation, targeted Stop and restart tests pass. Packaged UI showed terminal activity without Provider/shell requests; five-minute visible/hidden captures found no retained PR8 process, Turn timer or Provider work.        |
| Rendering            | fix     | Activity fields reuse the shared Run View store; old intervention expiry timer is removed. Writer badge is shared. A native Session terminal now schedules one existing 50ms run-scoped debounce when a mounted Agent Org Member changes state.                                                         | No new React subscription owner or periodic request. Paused/Idle use websocket push, reconnect reconciliation, or this exact local terminal boundary instead of intervention polling; ordinary SDE has no covering Run View entry and performs no IPC.                           | Full Vitest and focused UI suites pass. With the IDE websocket deliberately unavailable, the rebuilt packaged App replaced Stop with Return after the durable direct terminal and retained the correct state across restart.            |

## Lifecycle matrix

| Team / app state | Visible                                                                                  | Hidden / no consumer                                                          | Repeated open and switch                                                                         |
| ---------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Working          | Existing shared Run View owner may poll; direct activity is one extra bounded projection | Existing visibility handler clears the shared interval; no intervention timer | One cache/subscription owner per run; Member switches do not create another poller               |
| Idle             | Direct composer remains usable; direct work does not make formal quiescence false        | No periodic Run View/Member Wake/Provider request from PR8                    | Reuses cached Run View and one bounded refresh on visibility return                              |
| Paused           | Direct composer remains usable; Writer graph mutation is denied                          | No auto-Return, expiry or Provider wake                                       | Receipt survives page/session switches; no timer retained by the hook                            |
| Archived         | Read-only, queued/active UDW cancelled, no continuation                                  | No Provider, poll, wake or recovery replay                                    | Reopen remains read-only; Delete removes durable rows after explicit confirmation                |
| App restart      | Restores receipt and pending exact UDW/continuation                                      | No started-side-effect replay                                                 | Recovery scans are bounded one-shot startup work, not retained workers                           |
| Ordinary SDE     | Existing Queue/steering/Stop/runtime behavior                                            | No Agent Org context query/listener/timer from PR8                            | No Agent Org source field unless the canonical Member UI sets it; CLI rejects it before Provider |

## Resource ownership and bounds

- `AgentSession.scheduler`: existing single FIFO, cap 32.
- `turn_end_revision`: one watch scalar per live Session; no retained payload and
  no receiver after the bounded wait.
- direct receipt/chain/context: SQLite-owned, deleted with the Team; no TTL.
- late handoff task: spawned only from an exact owned-job completion event and
  exits after one receipt/Turn/lease check.
- Run View activity map: request-local and bounded by Member count; no module
  lifetime message retention.

## Measured packaged-App evidence

- Busy formal-to-direct handoff: receipt
  `intervention_2aaa1bce-2ada-4d4c-a3bc-cd0aad20254a` requested yield at
  `19:36:57.037752Z` and released the exact lease at `19:36:57.160342Z`:
  121ms. No timeout occurred and active Member Provider concurrency stayed at
  one. The unique Return continuation was created once.
- Repeated direct appended chain position 2 under the same receipt and did not
  request a second suspend. Queued and active Stop terminated only their UDW
  Turn; the original formal Task and FIFO order remained intact.
- Five minutes visible across multiple Idle Teams recorded ordinary baseline
  Session aggregation, Git remote, logging, auth and history work, but zero PR8
  Run View, Member Wake, UDW, intervention or Provider request.
- After clearing the panel, five minutes minimized recorded only the window
  minimize IPC. Restoring visibility produced one bounded batch (focus,
  shell-job status, Session aggregate and plugin/org refresh); the panel showed
  `0 likely polling` and no PR8 or Provider request.
- Completed UDW provider/shell work became terminal before its final assistant
  result was shown and remained quiet for both five-minute captures. This
  satisfies the design hard bound in observed runs; the owning-boundary tests
  cover the 1s/5s/10s finalizer thresholds deterministically.
- The final checkout SDK maintenance scenario ran one 73.2-second live
  Provider Turn (enqueue to terminal), changed two files, executed four shell
  runs and passed 5/5 tests. The Run stayed formally Idle with zero Tasks;
  after terminal there were zero queued/running direct chain rows, no
  continuation, and Return resolved `cleared_idle`.
- A rebuilt-package permanent Delete of an isolated archived Team removed both
  canonical Sessions, the run row and every deliberately seeded Session-owned
  OrgTrack history row. The exact all-table Session-reference scan returned no
  nonzero rows; one shared resource identity remained intentionally. This
  verifies that the extra cleanup is bounded destructive work, not a retained
  scan, worker or background process.

## Performance verdict

Pass for PR8. The code-level ownership/bounds checks and measured packaged-App
lifecycle matrix agree: one runtime/FIFO, bounded handoff and cancellation, no
intervention timer, no hidden/Idle PR8 polling, no Provider leak, and one
bounded visibility or native-terminal refresh. Ordinary App baseline polling
remains unchanged and is not attributed to PR8.
