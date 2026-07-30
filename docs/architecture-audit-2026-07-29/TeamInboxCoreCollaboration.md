# Architecture Audit — Team Inbox Core Collaboration

**Date:** 2026-07-29
**Auditor:** Codex
**Scope:** standalone Cloud Org Work Item collaboration, Session handoff creation, Work Item comment mentions, assignment receipts, and cross-instance detail refresh.

## Completion checklist

- [x] Standalone mutations are org-scoped and atomic.
- [x] Project and standalone Work Items share one partial-update shape and UI surface.
- [x] Assignment receipt reset and Return reassignment commit in the owning transaction.
- [x] Handoff transitions are validated by one state machine per storage scope.
- [x] Comment mentions persist stable member ids and become viewer-scoped Team Inbox targets.
- [x] Initial Session handoff creation persists status, priority, and target date.
- [x] Remote selection refresh is revision-driven and adds no polling.
- [x] TypeScript and Rust compile gates pass.
- [x] Targeted backend and frontend regression suites pass.

## Production call-chain trace

| User action                                           | Frontend boundary                                           | Tauri/backend boundary                                        | Authoritative write / projection                                                                       |
| ----------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Edit standalone property, To-Do, comment, or assignee | `useTeamInboxWorkItem.updateWorkItem`                       | `work_item_update_standalone_partial`                         | Org-scoped SQLite `work_items` row + history/revisions/receipt reset, then one collab outbox write     |
| Accept or Return standalone handoff                   | `useTeamInboxWorkItem.transitionHandoff`                    | `work_item_transition_standalone_handoff`                     | Validated handoff state; Return also changes assignee and clears receipt in the same transaction       |
| Create Session-derived Work Item                      | `TeamInboxSessionDropSurface` → `createWorkItemFromSession` | Existing project create or standalone insert/atomic reconcile | One canonical Work Item with provenance, selected properties, assignment, and optional pending handoff |
| Comment with `@` recipients                           | `useWorkItemContentState`                                   | Canonical Work Item partial update                            | `comments[].mentioned_user_ids`; Team Inbox projects one row per addressed viewer                      |
| Receive a remote edit                                 | Cloud Org push signal → coordinator refresh                 | Collaboration apply updates local SQLite                      | Inbox row revision advances; only the selected detail demand-reloads                                   |

## Ten-layer audit

| Layer                                   | Verdict | Evidence / decision                                                                                                                                                                                                                             |
| --------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Compilation correctness              | pass    | TypeScript typecheck, Rust compilation, targeted Rust tests, and 141 focused Vitest tests pass.                                                                                                                                                 |
| 2. Dead code & structural deduplication | pass    | Both project and standalone commands call the shared scoped atomic transaction helper; Team Inbox reuses `WorkItemThreadSurface` rather than maintaining a second content implementation.                                                       |
| 3. Naming consistency                   | pass    | `standalone`, `partial`, `handoff`, and `mentioned_user_ids` describe storage scope and payload semantics explicitly; the prior project-only editability implication is removed.                                                                |
| 4. Semantic overloading                 | pass    | `member id` means the stable Cloud Org identity throughout roster, assignment, handoff, and mention routing; display names are presentation only.                                                                                               |
| 5. Default branch analysis              | pass    | Standalone/project scope selection is an explicit enum; self-assignment versus team handoff is explicit and recipient validation has no permissive catch-all.                                                                                   |
| 6. Cross-domain leakage                 | pass    | Cloud roster loading stays in the Team Inbox hook; the shared Work Item surface receives ordinary `Person[]` and mutation callbacks, not Cloud Org transport types.                                                                             |
| 7. New developer confusion              | pass    | Command and helper names expose the standalone scope and atomic intent; the call-chain table above documents ownership and persistence.                                                                                                         |
| 8. Wire protocol & serialization        | pass    | `mentioned_user_ids` is optional/empty-skipped on the wire, work-item mention targets are discriminated, and no display-name-derived identity crosses the boundary.                                                                             |
| 9. Init parity                          | pass    | Drag/drop and Session context-menu creation converge on the same request atom, composer, normalized form, idempotent creation function, and storage commands.                                                                                   |
| 10. Resolver symmetry                   | pass    | Project and standalone detail loaders both resolve the Work Item, roster/current user, update callback, and handoff transition before rendering the same thread surface; degraded optional context does not replace a successfully loaded item. |

## State and transaction invariants

| Concern              | Invariant                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Storage scope        | A standalone Work Item is addressed by `org_id + short_id + project_id IS NULL`; cross-org updates fail.                       |
| Partial mutation     | The transaction reads the current canonical row, applies only supplied fields, records history/revisions, and commits once.    |
| Collaboration output | The outbox write occurs once after the SQLite transaction succeeds; a failed transaction emits nothing.                        |
| Reassignment         | `assigned_human_id` and the assignment episode's read receipt change atomically.                                               |
| Handoff              | Only the addressed recipient may Accept/Return; Return requires a bounded reason and reassigns to the sender atomically.       |
| Mentions             | Only normalized active-roster ids are persisted; self, unknown, blank, and duplicate recipients are excluded.                  |
| Remote convergence   | The coordinator's observed `updatedAt` invalidates the selected Work Item; a late prior load cannot replace a newer selection. |
| Mutation ordering    | A bounded per-item promise queue preserves invocation order for rapid partial updates.                                         |

## Systematic sweeps

- Swept all Team Inbox property/todo/comment writes for project-only persistence assumptions.
- Swept assignment changes for read-receipt reset parity.
- Swept Work Item comment serialization in Rust, TypeScript domain types, HTTP/Tauri payloads, conversion helpers, tests, and collaboration bridge fixtures.
- Swept Session handoff entry points so drag/drop and context-menu creation share the expanded status/priority/date form.
- Swept Team Inbox item discrimination, cursors, read/unread operations, row rendering, detail selection, and navigation for the new Work Item comment mention target.

## Deliberately skipped or deferred

- No historical comments are retroactively inferred as mentions; old comments lack authoritative recipient ids, and guessing from display text would violate identity invariants.
- Mention activation opens the owning Work Item discussion rather than introducing a separate comment permalink/anchor protocol.
- No destructive cleanup was required: existing standalone Work Items become editable through the corrected write boundary, while historical comments remain valid non-mention comments.

## Verdict

The first-group collaboration closure is architecturally coherent: canonical writes are atomic, identity is stable-id based, the two directions share one state machine and composer, and the UI is a projection of authoritative Work Item data rather than a parallel Team Inbox document.
