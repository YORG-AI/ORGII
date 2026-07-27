# Frontend UI Audit — GitHubWorkItemsSurface Phase 3

**Files:**

- `src/modules/MainApp/WorkManagement/GitHubWorkItemsSurface.tsx` (1448 LOC after Phase 3)
- `src/modules/MainApp/WorkManagement/GitHubWorkItemsListView.tsx` (304 LOC)

**Date:** 2026-07-20
**Auditor:** ORGII agent session

## D1 — Raw HTML vs Design System

| Line      | Element                                 | Verdict          | Reason                                                                                                                                 | Suggested change |
| --------- | --------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| list view | filter action                           | keep with reason | Uses the shared `Button` and `Dropdown` components with the existing multiple-selection contract.                                      | —                |
| list view | state/empty/list/pagination composition | keep with reason | Uses established `Placeholder`, `GitHubWorkItemSummary`, `GitHubWorkItemListFrame`, `GitHubWorkItemPagination`, and domain row leaves. | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line         | Value                    | Verdict          | Reason                                                                                                                                | Suggested change |
| ------------ | ------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| virtual rows | inline `translateY(...)` | keep with reason | This is runtime geometry supplied by TanStack Virtual rather than a visual design value; a static Tailwind token cannot represent it. | —                |

## D3 — Hardcoded Sizes / Colors

| Line           | Value          | Verdict          | Reason                                                                                                    | Suggested change                                                |
| -------------- | -------------- | ---------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| PR empty frame | `height={180}` | keep with reason | Preserves the existing minimum empty-state canvas inside the bordered list frame; it was moved unchanged. | Consider only with a shared work-item empty-frame sizing token. |
| summary icons  | `size={13}`    | keep with reason | Preserves compact alignment with the existing summary typography and count badges.                        | —                                                               |

## D4 — Accessibility

| Line         | Element                     | Verdict          | Reason                                                                                                                               | Suggested change |
| ------------ | --------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| list view    | filter control              | keep with reason | The shared `Button` supplies visible text and the shared `Dropdown` owns menu keyboard behavior.                                     | —                |
| list view    | summary tabs and pagination | keep with reason | Accessible state and labels remain owned by the established summary/pagination components; Phase 3 does not recreate those controls. | —                |
| virtual rows | absolute wrappers           | keep with reason | Wrappers are non-interactive positioning containers; row leaves own semantic buttons and accessible names.                           | —                |

## D5 — Visual Patterns Observed

- All GitHub list states now share one composition owner instead of being embedded in the side-effect coordinator.
- Existing GitHub list primitives remain the reusable visual layer; no additional shared primitive is warranted.

## Summary

- 0 fixes recommended
- 8 kept with documented reason
- 0 abstract candidates
