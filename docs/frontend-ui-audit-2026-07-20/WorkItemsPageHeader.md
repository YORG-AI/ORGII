# Frontend UI Audit — WorkItemsPageHeader

**Files:**

- `src/modules/ProjectManager/WorkItems/components/WorkItemsPageHeader/index.tsx` (80 LOC)
- `src/modules/ProjectManager/WorkItems/components/WorkItemsPageHeader/WorkItemsHeaderContent.tsx` (179 LOC)
- `src/modules/ProjectManager/WorkItems/components/WorkItemsPageHeader/AddActionsButton.tsx` (135 LOC)

**Date:** 2026-07-20
**Auditor:** ORGII agent session

## D1 — Raw HTML vs Design System

| Line                                | Element             | Verdict          | Reason                                                                                                                                                             | Suggested change                                               |
| ----------------------------------- | ------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| `WorkItemsHeaderContent.tsx:89–173` | toolbar actions     | keep with reason | Search, collapse, refresh, properties, and single add actions use shared `Button` and `WorkstationToolbarTooltip` primitives.                                      | —                                                              |
| `AddActionsButton.tsx:102–129`      | dropdown menu items | keep with reason | Semantic raw buttons with `role="menuitem"` and shared `DROPDOWN_CLASSES` are the established repository dropdown action-row pattern recorded in the audit README. | Evaluate only in the deferred global dropdown primitive sweep. |

## D2 — Arbitrary Tailwind Value vs Token

| Line            | Value                        | Verdict          | Reason                                                                                                                                    | Suggested change |
| --------------- | ---------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| all changed TSX | workstation/dropdown classes | keep with reason | Header geometry, icon sizes, selected state, and dropdown dimensions use shared workstation/dropdown tokens or standard layout utilities. | —                |

## D3 — Hardcoded Sizes / Colors

| Line                           | Value                    | Verdict          | Reason                                                                                                                             | Suggested change |
| ------------------------------ | ------------------------ | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `AddActionsButton.tsx:108–126` | icon size / stroke width | keep with reason | Icon size comes from `DROPDOWN_ITEM.iconSize`; the existing stroke weight is an icon rendering parameter, not a raw CSS dimension. | —                |

## D4 — Accessibility

| Line                                | Element           | Verdict          | Reason                                                                                                                                                                         | Suggested change |
| ----------------------------------- | ----------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| `WorkItemsHeaderContent.tsx:89–173` | icon-only Buttons | keep with reason | Every icon-only action has a translated `aria-label` and an associated tooltip.                                                                                                | —                |
| `AddActionsButton.tsx:70–132`       | add menu          | keep with reason | The trigger is a semantic Button, the panel has `role="menu"`, and its action rows have `role="menuitem"`; Escape/outside-click behavior remains owned by `useDropdownEngine`. | —                |

## D5 — Visual Patterns Observed

- The extracted leaf components preserve the established workstation toolbar grouping and separators.
- The add-action trigger continues to collapse to one Button when only one callback is supplied and to a dropdown when both callbacks exist.
- No new visual primitive or duplicate token set was introduced.

## Summary

- 0 fixes recommended
- 6 kept with documented reason
- 0 immediate abstract candidates
