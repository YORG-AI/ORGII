# Agent Org #272 Final Architecture Audit

- Date: 2026-07-14, updated with final verification on 2026-07-18
- Baseline: `develop`
- Branch: `fix/issue-272-agent-org-recovery-invariants`
- Scope: Every branch difference affecting Agent Org Run, Task, Inbox, Wake, Watchdog, member lifecycle, Planner approval, Task authority, desktop projection, and E2E.

## Final conclusion

No known P0/P1 correctness issue remains in the approved #373 scope. Unrelated formatting and historical lint cleanup were removed from scope, while the implementation preserves five independent state dimensions: Run, Session, Task, Approval, and Inbox/Delivery. The Coordinator assigns work explicitly, workers cannot claim ownerless Tasks, Watchdog recovers only real actionable events, and Plan approval advances from durable state rather than empty Wake or model guesses.

## Ten-layer audit

| Layer                        | Line / element                                    | Verdict          | Reason                                                                                                                                                                                        | Suggested change                                           |
| ---------------------------- | ------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 1. Compilation and warnings  | Rust desktop / E2E / frontend                     | keep with reason | `org2`, `e2e-test`, TypeScript, and ESLint pass. No remaining strict-Clippy finding is on a line introduced by this review; workspace baseline remains.                                       | Clean baseline in a separate PR.                           |
| 2. Dead code and duplication | Auto-claim, `find_available`, old blocker helpers | fixed            | Worker auto-claim paths and orphaned helpers are removed; no second ownerless auto-claim path remains.                                                                                        | None.                                                      |
| 3. Naming and responsibility | RecoveryPlan / Analyzer / Executor / Wake outcome | keep             | Analyzer reads, Executor performs side effects, and outcomes distinguish Enqueued, Coalesced, Paused, Terminal, NoWork, and failure.                                                          | None.                                                      |
| 4. State dimensions          | Run / Session / Task / Approval / Delivery        | keep             | Each persists and transitions independently. Idle is not Run completion, Pending is not claimable, and Wake is not consumption.                                                               | Preserve the separation in future features.                |
| 5. FSM and defaults          | Session status / approval policy / finality       | keep             | Critical states are explicit. Terminal, Paused, awaiting approval, malformed data, and historical compatibility have named behavior.                                                          | Require exhaustive enum handling.                          |
| 6. Cross-domain boundary     | Hierarchy communication vs Task authority         | fixed            | Hierarchy Mode controls communication. Coordinator owns global Task administration; a worker may advance only its own assigned work.                                                          | None.                                                      |
| 7. New-developer clarity     | Prompt, tool schema, typed guidance               | fixed            | Assignment, dynamic dependency, Planner mode, approval responsibility, and ownerless behavior are documented in contracts. Correctable misuse returns guidance instead of a red failure card. | Retain prompt/schema contract tests.                       |
| 8. Wire and data boundary    | Typed Inbox, mutation outcome, reserved metadata  | fixed            | New writes validate roster, eligibility, owner, dependencies, identifiers, and payload size. Historical bad data remains readable and repairable.                                             | A future schema PR may evaluate an eligibility join table. |
| 9. Initialization parity     | Production / test / debug / E2E database          | fixed            | Recovery, approval, Inbox resolution, and intent schema use canonical initialization. Unsupported CLI Agent Org is rejected during both definition validation and launch preflight.           | Do not reopen CLI until full parity exists.                |
| 10. Resolver symmetry        | Run/member/Session/Task identity                  | keep             | Resolution consistently uses member id, Session id, Root Session, and Run id. UI and Inbox prefer member identity over shared agent definition identity.                                      | None.                                                      |

## Critical invariant review

| Invariant                                                                   | Result                                                                                                  |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| A non-Running Run cannot create, update, delete, claim, or reassign a Task. | Pass: Task mutation and finality share writer serialization and an IMMEDIATE transaction.               |
| Finality and concurrent Task creation cannot both succeed.                  | Pass: concurrency tests allow only one serializable order.                                              |
| Concurrent Wake requests for one member cannot create multiple model turns. | Pass: stable idempotency key and durable Coalesced outcomes.                                            |
| Recovery budget is consumed only when the scheduler accepts a Wake.         | Pass: Coalesced, Rejected, Paused, and failed enqueue do not consume an attempt.                        |
| Session must not appear Running before the scheduler starts the turn.       | Pass: state transition occurs at the execution boundary.                                                |
| A queued Wake cannot revive a Paused or terminal Run.                       | Pass: execution re-reads Run state and fails closed.                                                    |
| A worker cannot auto-claim an ownerless Task.                               | Pass: ownerless produces Coordinator assignment guidance only.                                          |
| A worker cannot modify another member's Task state.                         | Pass: Coordinator authority and worker-owned authority are separate.                                    |
| A worker result without Task completion cannot stall forever.               | Pass: bounded correction is attempted, then Coordinator is notified without infinite Wake.              |
| Awaiting Plan approval cannot Wake every minute or flash.                   | Pass: pending approval is an explicit quiet state.                                                      |
| Failure requeue cannot lose metadata or commit half a history event.        | Pass: Task and history/outbox share a transaction.                                                      |
| Dependency release cannot duplicate `TaskAssigned`.                         | Pass: side effects use a transaction-local mutation outcome.                                            |
| Undeliverable Inbox cannot be falsely read or block finality forever.       | Pass: explicit Cancelled/Superseded resolution preserves evidence and removes only the pending blocker. |
| Group Chat refresh cannot lose complete durable history.                    | Pass: bounded preview plus paginated durable history, verified with 230+ rows.                          |

## Final verification

| Check                                           | Result                    | Notes                                                             |
| ----------------------------------------------- | ------------------------- | ----------------------------------------------------------------- |
| `pnpm typecheck`                                | Pass                      | Full TypeScript check                                             |
| `pnpm lint`                                     | Pass                      | Full ESLint check                                                 |
| Full frontend unit suite                        | 5,181 / 5,181             | 450 files                                                         |
| `cargo check -p org2 --lib`                     | Pass                      | Desktop library                                                   |
| `cargo check -p e2e-test`                       | Pass                      | Rust E2E target                                                   |
| Full `agent_core` suite                         | 3,155 / 3,155             | Isolated persistence and loopback-enabled environment             |
| Full Agent Org HTTP E2E                         | 47 / 47                   | Real isolated Debug App                                           |
| Rendered Debug App E2E                          | 19 / 19                   | Group Chat 6, Pause/Resume 8, Recovery 2, Settings 3              |
| Changed-scope formatting and `git diff --check` | Pass                      | No whitespace error in branch changes                             |
| Strict workspace Clippy                         | Existing develop baseline | No remaining finding is on a line introduced by this review.      |
| Full workspace rustfmt                          | Existing develop baseline | Six unchanged files remain outside formatting baseline.           |
| Circular dependency check                       | Existing develop baseline | Two cycles are confined to unchanged Org2Cloud/SessionCore files. |

## Scope discipline

The audit did not modify unrelated Git, Key Vault, Provider, Session Memory, OrgTrack, or other baseline modules merely to produce a green global number. Complete Revision Events, Event Projector, incremental subscriptions, and a full persistent Scheduler Outbox remain outside #373 and are documented separately.

## Commit verdict

**Implementation and verification are complete for the approved scope.** The local worktree still requires an intentional commit and push before GitHub PR #373 reflects the final fixes. No known P0/P1 blocker remains.
