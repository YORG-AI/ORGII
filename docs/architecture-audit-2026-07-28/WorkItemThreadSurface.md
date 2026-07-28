# Architecture Audit — Work Item Thread Surface

**Scope:** Team Inbox assigned detail, formal Chat Panel Work Item page, shared Work Item presentation and property composition

**Date:** 2026-07-28
**Auditor:** Codex

## Findings

| Priority | Area                   | Final verdict | Evidence                                                                                                     | Resolution                                                                                                                   |
| -------- | ---------------------- | ------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| P1       | Presentation ownership | fixed         | Both entry points import `WorkItemThreadSurface`                                                             | Presentation selection and metadata density are owned once; navigation shells cannot independently drift back to legacy UI.  |
| P1       | Agent action ownership | pass          | Inbox emits one pending action; formal page retains `usePendingWorkItemAction` and `useWorkItemOrchestrator` | Visual unification does not create a second orchestrator or duplicate Start Agent execution.                                 |
| P2       | Property configuration | fixed         | `WORK_ITEM_THREAD_PROPERTY_FIELDS` and `WorkItemThreadSurface`                                               | Field order, pill variant, wrapping and overflow menu are canonical shared policy.                                           |
| P2       | Update state path      | pass          | Both callers provide their existing canonical partial-update handlers                                        | The surface remains stateless with respect to persistence; updates still reconcile through the owning data source.           |
| P2       | Session navigation     | pass          | Formal page retains `handleOpenSession` and the floating Session view                                        | Removing the legacy linked-session table does not remove access to sessions exposed by the inline workflow/activity content. |

## Ten-layer coverage

| Layer                      | Verdict | Notes                                                                                                                                            |
| -------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Compilation             | pass    | TypeScript typecheck and scoped ESLint pass.                                                                                                     |
| 2. Dead code / duplication | pass    | Formal-page Properties rail state, resize plumbing and toggle were removed; both entry points use one composition.                               |
| 3. Naming                  | pass    | `WorkItemThreadSurface` names a presentation boundary, not a persistence or navigation owner.                                                    |
| 4. Semantic overload       | pass    | `propertyProps` configures existing controls; `WorkItemContentProps` continues to own workflow/content behavior.                                 |
| 5. Defaults                | pass    | The wrapper forces `thread`, pill fields, wrapping and overflow menu; omitting `propertyProps` produces a readable thread without fake controls. |
| 6. Layer boundaries        | pass    | Entry points own navigation and data mutation; the shared surface owns presentation composition only.                                            |
| 7. Control flow / FSM      | pass    | Existing update, refresh, orchestrator lock/loading and pending-action flows are forwarded unchanged.                                            |
| 8. Wire protocol           | skipped | No RPC, persistence schema or serialization shape changed.                                                                                       |
| 9. Init parity             | pass    | Inbox and formal entry points initialize the same surface from the same `WorkItem` domain shape.                                                 |
| 10. Resolver symmetry      | pass    | Both entry points pass resolved members/current user into the same content implementation.                                                       |

## Ownership map

| Value                                | Owner                                    | Lifetime                    | Write boundary                           | Readers                                 |
| ------------------------------------ | ---------------------------------------- | --------------------------- | ---------------------------------------- | --------------------------------------- |
| Thread hierarchy and metadata policy | `WorkItemThreadSurface`                  | component version           | source code                              | Inbox and formal Work Item entry points |
| Work Item value                      | entry-point data owner                   | selected item / mounted tab | canonical Work Item partial update API   | shared surface                          |
| Agent lifecycle                      | `useWorkItemOrchestrator` in formal page | mounted formal Work Item    | orchestrator actions                     | inline workflow section                 |
| Pending Inbox Start Agent intent     | Work Item navigation state               | one navigation handoff      | `usePendingWorkItemAction` consumes once | formal page                             |
| Linked Session overlay               | `WorkItemPanelView`                      | formal tab                  | local UI state + active Session atom     | formal page only                        |

## Verification

- `pnpm typecheck` — passed.
- Scoped ESLint for all changed TypeScript files — passed.
- Targeted Vitest suite — 4 files / 11 tests passed.
- Full Vitest suite — 752 files / 6,611 tests passed.
