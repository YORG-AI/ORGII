# PR8 architecture audit — Direct UserDirectedWork and Return to Work

Audited base: `722f6bce39c5a52efc14fcc59707f14eaa93a39a`.
Audited branch: `codex/issue-763-direct-user-directed-work` (uncommitted working
tree; no push or PR publication is authorized yet).

Normative scope: design §6, §8.3, §10–12, §14–20, §24 and §25.11. The design
document is authoritative over Issue #763 and the implementation plan.

## Verdict summary

| Severity | Finding                                                                                                                 | Status                                                                                                                                                                                                                              |
| -------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1       | Direct user input previously became steering and did not own a durable source/receipt/Turn                              | Fixed: the existing send dispatcher admits an exact EventStore source and durable UDW Turn in one transaction                                                                                                                       |
| P1       | Old Return used time expiry, polling and blanket Inbox drain                                                            | Fixed: exact receipt/request transition with explicit outcomes and at-most-one continuation                                                                                                                                         |
| P1       | UDW and interrupted formal Turns could run formal/background finalizers                                                 | Fixed: UDW-specific terminal path; formal Task/Inbox/recovery and background provider work are suppressed                                                                                                                           |
| P1       | Crash and exact-retry windows could replay side effects or lose queued work                                             | Fixed: only never-started Turns recover; started work becomes abandoned; exact scheduler identity is preserved                                                                                                                      |
| P1       | Released runtime lease could cause a replacement runtime instead of one warm runtime                                    | Fixed: the exact same `Arc<SessionRuntime>` is rebound under a fresh lease; a different runtime fails closed                                                                                                                        |
| P2       | Quiescence counted direct work/intervention and did a per-Member lookup                                                 | Fixed: only formal work blocks Working→Idle; intervention projection uses one bounded set read                                                                                                                                      |
| P2       | Ordinary SDE paths performed Agent Org context lookups                                                                  | Fixed: processor, Stop and finalizer gate every new lookup on canonical Agent Org runtime/session identity                                                                                                                          |
| P2       | Writer badge styling was duplicated on three rendered surfaces                                                          | Fixed: one shared `AgentOrgWriterBadge` component                                                                                                                                                                                   |
| P1       | Team Delete removed event bodies but left EventStore Session/Turn metadata behind                                       | Fixed: the same hierarchy-delete transaction now owns `session_turns`, `session_turn_index_state`, `session_turn_intents` and `sessions`; success and rollback tests seed every table                                               |
| P1       | Team Delete removed the Session mirror but left OrgTrack file/edit/resource history keyed to deleted Member Sessions    | Fixed: the Team IMMEDIATE transaction now deletes every Session-owned OrgTrack history table before Session deletion and fails closed on any residual; shared resource identities without Session history are deliberately retained |
| P1       | A completed direct Turn could leave Idle/Paused UI showing stale Stop state when the optional IDE websocket was offline | Fixed: the durable direct terminal is committed before the existing native Session terminal event, which triggers one debounced Run View reconciliation for mounted Agent Org Members                                               |
| P1       | Every Run View refresh projected the latest cleared receipt as current `returned` activity                              | Fixed: current activity is derived only from active receipts; cleared revision/outcome remain durable audit facts and never re-enter Member or Overview state                                                                       |
| P1       | Return discarded the applied outcome on replay and delayed its one-shot Toast behind a potentially busy refresh         | Fixed: the wire returns the exact applied outcome/revision/time for first apply and replay, and UI consumes it before launching one non-blocking reconciliation refresh                                                             |

No unresolved product or architecture decision was found. The packaged-App,
real-provider, Computer Use and measured performance gates were exercised on
the uncommitted branch. Authorized permanent-Delete runs exposed both the
residual EventStore metadata bug and eleven Session-owned OrgTrack history
rows. Both producing paths are fixed and regression-tested. A fresh isolated
Team was then archived and permanently deleted through the rebuilt packaged
App; database readback found zero Team, Session or Session-history residuals.

## Ten-layer walk

| Layer                                    | Verdict | Evidence and plain-language meaning                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Types and naming                      | Pass    | `UserDirectedWork`, `DirectMember`, `MemberInterventionStatus` and exact source/receipt/continuation ids have one meaning. `AppliedReturnToWorkOutcome` names the four durable business results; protocol-only `already_applied` reports replay without replacing the original result. Old TTL, boolean intervention and current `returned` names are removed.                                                                 |
| 2. State machine                         | Pass    | Receipt states are `yield_requested → active → return_requested → cleared`, plus terminal `failed`; chain Turns independently move queued/running/terminal. Clearing immediately removes current activity. It does not erase the durable outcome or direct conversation history. No new Team or Task state was introduced. Invalid transitions fail closed.                                                                    |
| 3. Events and transport                  | Pass    | `useUserIntentSubmit → SessionService.sendMessage → agent_send_message` remains the only production send chain. The durable user EventStore id and stable Turn id cross the existing IPC command; assistant events point back with `reply_to_event_id`. The existing native Session terminal event now provides the local Run View invalidation when the optional IDE websocket is unavailable.                                |
| 4. Persistence authority                 | Pass    | Source validation, base intent, UDW context, Member FIFO sequence, receipt and chain append share one SQLite IMMEDIATE transaction. Canonical DDL replaces the gated local runtime schema; there is no `ALTER TABLE` compatibility probe. Team Delete also owns Session-scoped OrgTrack history in its writer transaction, so the later mirror cleanup is not a second persistence authority.                                  |
| 5. Lifecycle and recovery                | Pass    | Working/Idle/Paused admit direct work; Starting/Failed/Archived/noncanonical/CLI reject before Provider. Startup restores pending work only, marks started work abandoned, restores receipts without auto-Return, and recovers one exact Return continuation. Team Delete atomically removes event bodies, EventStore Session/Turn indexes and Session-owned OrgTrack history, then verifies that no Session history survived. |
| 6. Concurrency and idempotency           | Pass    | One existing per-Session FIFO remains authoritative. The formal Turn yields by exact session/lease/generation CAS; duplicate direct reuses its Turn and receipt; Return is keyed by receipt/request and creates at most one continuation. Targeted Stop fences are bounded and preserve unrelated FIFO order.                                                                                                                  |
| 7. Initialization symmetry               | Pass    | Cold startup runs pending-direct and continuation recovery through the same send dispatcher as warm execution. CLI and historical/noncanonical sessions cannot synthesize direct authority. Debug commands can seed/read evidence only and no longer own a second send/Return path.                                                                                                                                            |
| 8. Wire and projection                   | Pass    | Run View carries only active activity, receipt id, queue count, direct source and writer capability without rewriting `runStatus`/`runPhase`. A no-original direct chain is `side_quest`; a real formal handoff is `user_intervention`. Return carries protocol outcome plus exact applied outcome, original-work flag, cleared revision/time and optional unique continuation. Cleared history is not current UI state.       |
| 9. Tool authority                        | Pass    | Per-Turn policy is rebuilt from persisted context. UDW gets file/shell/test and existing approval-managed tools. Ordinary Members are denied graph writes by schema visibility, execute-time actor checks and Task Store; Writer reuses the existing graph-admin receipt path; Paused Writer is denied.                                                                                                                        |
| 10. Tests, observability and performance | Pass    | Source/replay/fault/concurrency/handoff/Return/restart/Stop/finalizer/tool/quiescence tests pass. Logs use ids, counts and durations without message bodies. The gated packaged App proved real-provider file/shell work, exact busy lease handoff, Stop/Return/Pause/Resume/Archive, restart persistence, one-runtime evidence and visible/hidden idle behavior.                                                              |

## Entry-point parity matrix

| Entry                                 | UDW authority                              | Result                                                                         |
| ------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------ |
| Canonical Rust Member page            | Exact EventStore direct source             | Accepted in Working/Idle/Paused through the existing dispatcher                |
| Coordinator/root page                 | No Member direct source                    | Existing Coordinator semantics; cannot mint Member UDW                         |
| CLI transport                         | Direct source explicitly rejected          | Zero CLI Provider call and no intervention backfill                            |
| Background wake / Resume / Force Send | Typed non-direct source                    | Existing formal lifecycle; cannot masquerade as DirectMember                   |
| Startup recovery                      | Existing persisted UDW context/source only | Re-enqueues exact pending Turn; never mints or replays started work            |
| Debug/E2E                             | Fixture creation and readback only         | Cannot replace production send, Stop, Return, Pause, Resume, Archive or Delete |

## Resolver and default-branch review

- Missing or mismatched EventStore source, Session, Member, content, images or
  Turn identity returns a typed error before yield or Provider execution.
- Missing Agent Org authority in an Agent Org finalizer fails closed and
  suppresses formal hooks; ordinary SDE never runs that resolver.
- A different runtime in the Session slot is a conflict, never a replacement.
- Return re-reads Team/Task/owner/generation inside the writer transaction;
  terminal, cancelled or reassigned work resolves `no_longer_needed`.
- Scheduler enqueue failure terminalizes a new direct Turn, while startup
  recovery requeues the already-admitted exact Turn for the next recovery.
- Assistant persistence failure retracts streamed success and leaves durable
  Agent Org intent evidence in flight instead of reporting success.

## Verification recorded during the audit

- `cargo check -p agent_core`, `cargo fmt --check` and
  `cargo clippy -p agent_core --lib -- -D warnings` — passed.
- `cargo test -p agent_core --lib -- --test-threads=1` — 3,264 passed, 0
  failed, 2 ignored; the
  intervention subset and the focused
  hierarchy/OrgTrack Delete persistence subset is 12/12.
- Full Vitest run — 8,800 tests passed across 1,119 files. Focused Return UI,
  Run View lifecycle and non-blocking refresh tests also pass after the live
  scenario exposed the final ordering defect.
- `pnpm typecheck` passed. `pnpm lint` exited 0 with five unchanged baseline
  warnings in WorkItems files outside PR8. All 13 `sessions.json` locales parse.
- `env ORGII_AGENT_ORG_REDESIGN=1 pnpm tauri:build:fast` passed again after
  the final Return projection and Toast ordering fixes in 325.8s.
  This build-time environment value enabled the internal acceptance package;
  the checked-in rollout default remains off.
- Computer Use on that packaged App proved exact EventStore source/reply ids,
  no duplicate backend user event, real Provider file/shell work, a 121ms busy
  lease release, no second suspend for repeated direct, targeted queued/active
  Stop, restart persistence, `restored_task`, `cleared_paused` and
  `cleared_idle`, real Pause/Resume/Archive, and Archived read-only behavior.
- Five-minute visible and hidden-window request captures contained zero PR8
  Run View/Member Wake/UDW/Provider polling. Hidden restore caused one bounded
  visibility refresh and the request panel reported zero likely pollers.
- A final real-user checkout SDK scenario used the packaged Member composer
  and a live Provider to diagnose a request-signing bug, change
  `src/joinApiUrl.js`, add four regression cases, run the full `npm test`
  suite (5/5), and leave the fixture uncommitted. Durable evidence ties source
  `user-input-1787704589267-7ljkz1d` to UDW Turn
  `9b57f6e0-87a1-4a53-b1c6-92ccbaf19d27` and the final assistant
  `reply_to_event_id`; Team status stayed Idle with zero Tasks. After a real
  App restart the Member page exposed Return, and the real button produced
  `cleared_idle`, revision 1, with no continuation.
- The rebuilt packaged App created and archived the isolated
  `PR8 Delete Revalidation` Team, opened the native permanent-Delete dialog,
  required its acknowledgement checkbox, and completed the final destructive
  click only after fresh user authorization. Exact SQLite readback found zero
  references to either canonical Session, zero run row, and zero seeded edit,
  diff, final-diff, resource-interaction and commit-link history. The one
  shared resource identity remained by design because it contains no Session
  history and may be shared by unrelated Sessions.
- The final Planner case used the real packaged Member composer and a live
  Provider to inspect a failing Texas Hold'em pot-odds test, run the project
  tests and produce a concrete repair plan. With no formal Task suspended,
  the rendered button ended direct work and showed exactly one four-second
  `Direct work ended; the Team remains idle` Toast. Session switching and a
  full App restart did not replay it, and no returned activity remained.
- The final busy Implementer case used a live Provider to update a Texas
  Hold'em README and run its full tests while a real formal Task was bound.
  The active receipt projected `user_intervention` even after its UDW queue
  reached zero. The rendered Return button immediately showed exactly one
  `The original Task resumed` Toast; SQLite readback recorded
  `restored_task`, cleared revision 1, and exactly one continuation Turn.
- The focused live WDIO spec remains blocked on macOS because the Tauri
  packaged artifact was not built with the WebDriver plugin/port enabled, so
  the driver timed out before a rendered Session loaded. It uses only real
  click/key paths and no DOM JavaScript, but is not reported as passed;
  Computer Use supplied the required production-path evidence.
- `git diff --check` and retired-symbol/TTL/`ALTER TABLE` scans are clean.
