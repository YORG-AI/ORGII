# Architecture Audit — Team Inbox Session Handoff

**Scope:** Session-to-Work-Item creation, human handoff persistence, Team Inbox projection, recipient response, collaboration payloads, and shared Work Item presentation.
**Date:** 2026-07-28
**Auditor:** Codex

## Acceptance criteria

- [x] Dropping a Session opens a review step instead of immediately mutating data.
- [x] The Session context-menu action opens the same review path for keyboard/pointer users who do not drag.
- [x] A standalone Session requires an explicit eligible project when its destination is ambiguous.
- [x] Project membership and recipient eligibility are re-read at submit time.
- [x] Self is selected by default; selecting another alias of the current user remains a self-assignment.
- [x] A teammate handoff is persisted with the Work Item in the initial write.
- [x] Reusing an existing project Work Item applies the selected assignee and handoff instead of silently returning stale state.
- [x] A later handoff after an accepted/returned episode receives a new durable handoff id.
- [x] Only the intended recipient can accept or return a pending handoff.
- [x] Return requires a reason and atomically reassigns the Work Item to the sender.
- [x] Repeating the same response is idempotent; conflicting resolved transitions are rejected.
- [x] Team Inbox and formal Work Item entry points render the same canonical handoff state.
- [x] Team Inbox projection and collaboration payloads retain the handoff field.
- [x] Collaboration apply updates handoff state on an already-existing remote project Work Item.
- [x] Every production, agent, routine, test, and E2E Work Item constructor initializes the new optional field.

## Domain terms

| Term                  | Meaning                                                                  | Owner                     | Verdict                        |
| --------------------- | ------------------------------------------------------------------------ | ------------------------- | ------------------------------ |
| Session handoff draft | Ephemeral, editable preview produced before any Work Item write          | Team Inbox frontend       | Keep presentation-only         |
| Work Item handoff     | Durable sender/recipient decision record attached to one Work Item       | Project Management domain | Canonical source of truth      |
| Assignment            | Current Work Item owner used by ordinary assignment and Inbox projection | Work Item frontmatter     | Separate from handoff decision |
| Read receipt          | Per-viewer Team Inbox visibility state                                   | Team Inbox store          | Independent from accept/return |

## Ten-layer audit

| Layer                                     | Coverage                                                                                                                                                                                                                                            | Verdict |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 1. Compilation correctness                | TypeScript typecheck, changed-surface ESLint, 146 focused frontend tests, 41 focused Rust tests, project-management formatting, and full `org2` cargo check pass. The workspace-wide formatter still reports pre-existing drift outside this scope. | Pass    |
| 2. Dead code and structural deduplication | Response behavior is owned by `WorkItemContent`; the former Team-Inbox-only response surface and data-source response method were removed.                                                                                                          | Pass    |
| 3. Naming consistency                     | `pending`, `accepted`, `returned`, sender, recipient, response note, and transition have one meaning across Rust and TypeScript.                                                                                                                    | Pass    |
| 4. Semantic overloading                   | Assignment, handoff decision, Inbox read state, and Session provenance remain distinct fields and transitions.                                                                                                                                      | Pass    |
| 5. Default branches                       | The Rust transition function exhaustively handles Accept/Return; unknown or conflicting states cannot fall through to a permissive default.                                                                                                         | Pass    |
| 6. Cross-domain leakage                   | Session parsing stays in Team Inbox; durable transition rules stay in Project Management; shared Work Item UI consumes the public model only.                                                                                                       | Pass    |
| 7. New-developer clarity                  | Pure form helpers, creation mapper, caller-local shared-operation observer, domain FSM, atomic command, and shared notice each have a single named responsibility.                                                                                  | Pass    |
| 8. Wire protocol and serialization        | `handoff` is included in extras mapping, enrichment, Team Inbox payloads, atomic fingerprints/history, collaboration outbox payloads, new-item apply, and existing-item partial apply.                                                              | Pass    |
| 9. Entry-point parity                     | Drag and both Session tab context menus converge on one request/review state machine; frontend, agent tool, routine, production tests, and E2E constructors initialize `handoff`; both Work Item render entry points use the shared notice.         | Pass    |
| 10. Resolver symmetry                     | Sender and recipient identity use a freshly read project-local roster and the full current-user alias set; standalone Sessions select the project before recipient resolution; submit revalidates both before mutation.                             | Pass    |

## State machine

| Current state              | Actor/action                            | Result                                                               | Assignment effect                                   |
| -------------------------- | --------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------- |
| No handoff                 | Create for self or a current-user alias | No handoff record                                                    | Assign to selected self identity                    |
| No handoff                 | Create for teammate                     | `pending`                                                            | Assign to recipient                                 |
| Existing project Work Item | Recreate for teammate                   | Apply a new `pending` episode or retain the equivalent pending retry | Assign to recipient                                 |
| Existing resolved handoff  | Hand off again                          | New handoff id and `pending` episode                                 | Assign to new recipient                             |
| `pending`                  | Recipient accepts                       | `accepted`                                                           | Keep recipient                                      |
| `pending`                  | Recipient returns with reason           | `returned`                                                           | Reassign sender and clear prior assignment receipts |
| `accepted` / `returned`    | Repeat same action                      | No-op, same persisted result                                         | No change                                           |
| `accepted` / `returned`    | Opposite action                         | Reject as already resolved                                           | No change                                           |
| Any handoff                | Non-recipient responds                  | Reject                                                               | No change                                           |

## Entry-point parity

| Entry point                      | Initializes optional handoff            | Reads canonical handoff  | Can transition  |
| -------------------------------- | --------------------------------------- | ------------------------ | --------------- |
| Session drop → Work Item         | `pending` for teammate, `None` for self | Yes                      | Recipient only  |
| Session context menu → Work Item | Same canonical creation path as drop    | Yes                      | Recipient only  |
| Ordinary frontend creation       | `None` unless explicitly supplied       | Yes                      | Recipient only  |
| Agent tool creation              | `None`                                  | Yes                      | Recipient only  |
| Routine creation                 | `None`                                  | Yes                      | Recipient only  |
| Team Inbox detail                | N/A                                     | Shared `WorkItemContent` | Recipient only  |
| Formal Work Item detail          | N/A                                     | Shared `WorkItemContent` | Recipient only  |
| Test/E2E seed paths              | `None`                                  | Yes                      | Test-controlled |

## Systematic sweep

The sweep covered every `WorkItemFrontmatter` initializer, extras serialization, enrichment mapping, sync/collaboration payload, Team Inbox row projection, both Work Item detail entry points, and the Tauri command registry. Full-application compilation found and fixed the remaining two initialization sites outside the primary project-management crate.

The audit also found and fixed four cross-layer failure modes:

1. Single-flight keys now include the complete creation intent, so different project, recipient, title, or note choices cannot share the wrong result.
2. Each caller observes a shared operation with its own `AbortSignal`; closing one UI no longer cancels another consumer.
3. Standalone Session membership is read again at preparation and submit, closing the stale-roster authorization window.
4. Existing Work Items are reconciled atomically with the requested assignee/handoff and can start a new handoff episode after a prior resolution.

## Completion verdict

The lifecycle is closed in code: preview → create/reconcile → project → inspect → accept/return → reconcile. The remaining risk is rendered two-account, multi-device operational QA (presence, eventual sync timing, and human-readable error copy), not a missing implementation branch.
