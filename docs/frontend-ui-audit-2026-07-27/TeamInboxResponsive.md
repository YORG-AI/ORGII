# Frontend UI Audit — Team Inbox Responsive Detail

**Files:** `src/modules/MainApp/TeamInbox/TeamInboxView.tsx`, `src/modules/MainApp/TeamInbox/components/AssignedWorkItemDetail.tsx`, `src/modules/ProjectManager/WorkItems/components/WorkItemProperties/index.tsx`
**Date:** 2026-07-27
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line                                   | Element                | Verdict          | Reason                                                                                                                                           | Suggested change |
| -------------------------------------- | ---------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| WorkItemProperties: 301                | More-properties action | keep with reason | Uses the shared `Button` component with the established circular secondary treatment.                                                            | —                |
| TeamInboxView / AssignedWorkItemDetail | Interactive controls   | keep with reason | All controls are delegated to shared `SplitViewLayout`, `WorkItemProperties`, and detail components; no new raw interactive HTML was introduced. | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line                   | Value                                  | Verdict       | Reason                                                                                                                                                                    | Suggested change                                                                |
| ---------------------- | -------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| WorkItemProperties: 42 | `bg-[var(--cm-editor-background,...)]` | fix candidate | Pre-existing project-owned surface token; the repo sweep finds three direct uses. This is outside the responsive fix and should be handled once as a token-mapping sweep. | Add a semantic Tailwind surface mapping, then replace all three sites together. |

## D3 — Hardcoded Sizes / Colors

| Line                   | Value                                   | Verdict          | Reason                                                                                                                               | Suggested change |
| ---------------------- | --------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| TeamInboxView: 406–407 | `listWidth={200}`, `minListWidth={160}` | keep with reason | Existing resizable master-list bounds; detail responsiveness is owned by the remaining flex width and wrapping property layout.      | —                |
| WorkItemProperties: 44 | `text-[13px]`                           | keep with reason | Existing dense property typography, repeated consistently throughout Work Items; changing one header would reduce local consistency. | —                |

## D4 — Accessibility

| Line                          | Element                      | Verdict          | Reason                                                                                                                                     | Suggested change |
| ----------------------------- | ---------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| AssignedWorkItemDetail: 63–76 | Responsive property controls | keep with reason | Wrapping changes visual flow only; shared fields retain native button semantics, accessible names, keyboard handling, and portalled menus. | —                |
| TeamInboxView: 404–412        | Split-view header policy     | keep with reason | Removing the unrelated global breadcrumb also removes a misleading navigation announcement from the Team Inbox reading order.              | —                |

## D5 — Visual Patterns Observed

- Responsive pill layout is implemented once in shared `WorkItemProperties` through an explicit `pillLayout` policy.
- Team Inbox opts into wrapping; existing inline-create hosts preserve their compact single-row behavior.
- No new repeated visual pattern or abstraction candidate was introduced.

## Next-refactor candidates

- Sweep the three `bg-[var(--cm-editor-background,...)]` uses into one semantic Tailwind surface token rather than changing only this component.

## Summary

- 1 fix candidate, intentionally deferred to a repository-wide token sweep
- 4 kept with documented reason
- 0 new abstract candidates
