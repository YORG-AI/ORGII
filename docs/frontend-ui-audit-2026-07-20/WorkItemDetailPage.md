# Frontend UI Audit — WorkItemDetailPage

**Files:**

- `src/modules/ProjectManager/WorkItems/components/WorkItemDetailPage/index.tsx` (15 LOC)
- `src/modules/ProjectManager/WorkItems/components/WorkItemDetailPage/ProjectScopedWorkItemDetailPage.tsx` (121 LOC)
- `src/modules/ProjectManager/WorkItems/components/WorkItemDetailPage/StandaloneWorkItemDetailPage.tsx` (101 LOC)

**Date:** 2026-07-20
**Auditor:** ORGII agent session

## D1 — Raw HTML vs Design System

| Line            | Element                                      | Verdict          | Reason                                                                                                                                                                                           | Suggested change |
| --------------- | -------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| all changed TSX | `WorkItemDetail` / `Placeholder` composition | keep with reason | The split pages delegate visible controls and detail layout to the existing domain component and use the shared Placeholder for loading/empty states; no raw interactive element was introduced. | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line            | Value | Verdict          | Reason                                                                     | Suggested change |
| --------------- | ----- | ---------------- | -------------------------------------------------------------------------- | ---------------- |
| all changed TSX | none  | keep with reason | The data-source pages contain no Tailwind color or CSS-variable utilities. | —                |

## D3 — Hardcoded Sizes / Colors

| Line            | Value | Verdict          | Reason                                                        | Suggested change |
| --------------- | ----- | ---------------- | ------------------------------------------------------------- | ---------------- |
| all changed TSX | none  | keep with reason | The refactor introduces no pixel-literal sizes or raw colors. | —                |

## D4 — Accessibility

| Line                                         | Element                       | Verdict          | Reason                                                                                                                                | Suggested change |
| -------------------------------------------- | ----------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `ProjectScopedWorkItemDetailPage.tsx:95–120` | detail actions and navigation | keep with reason | Interactive semantics remain owned by `WorkItemDetail` and its accessible header Buttons; the page only supplies state and callbacks. | —                |
| both data-source pages                       | loading/empty states          | keep with reason | Both use the established detail-panel `Placeholder` with translated empty-state titles.                                               | —                |

## D5 — Visual Patterns Observed

- Project-scoped and standalone pages intentionally share the existing `WorkItemDetail` surface instead of duplicating its header/body controls.
- The split is data-source based, not visual; no new shared visual primitive is needed.

## Summary

- 0 fixes recommended
- 5 kept with documented reason
- 0 abstract candidates
