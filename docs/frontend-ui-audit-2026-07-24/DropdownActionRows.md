# Frontend UI Audit — Dropdown Action Rows

**Files:** `src/components/Dropdown/DropdownItem.tsx`, `src/engines/ChatPanel/components/SessionHeaderActionsMenu.tsx`, `src/modules/MainApp/WorkManagement/GitHubWorkItemControls.tsx`, `src/modules/MainApp/WorkManagement/GitHubWorkItemList.tsx`, `src/modules/WorkStation/shared/StatusBar/GitSyncStatusMenu.tsx`, `src/modules/WorkStation/shared/TerminalNewSessionSplitButton.tsx`
**Date:** 2026-07-24

## D1 — Raw HTML vs Design System

| Line | Element | Verdict | Reason | Suggested change |
| --- | --- | --- | --- | --- |
| Four action-menu callers | raw `<button>` rows duplicating `DROPDOWN_CLASSES.item` / `menuActionItem` | fixed | The rows repeated the same height, padding, hover, disabled, icon, label, and suffix contract in four product surfaces. | Replaced with shared `DropdownItem` action rows. |
| `DropdownItem.tsx:213` | role-aware `<div>` row | keep with reason | One root must support parent-managed listbox options and directly-focusable action menus. The shared row owns role, tab order, disabled state, and keyboard activation consistently; switching element type per role would split ref and layout behavior. | — |
| `GitHubWorkItemList.tsx:9` | React runtime import | keep with reason | This line changes no rendered element; it makes the existing server-rendered Work Item control tests use the same JSX runtime successfully. | — |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value | Verdict | Reason | Suggested change |
| --- | --- | --- | --- | --- |
| Changed action rows | row height, spacing, hover, selected, and disabled classes | fixed | Callers no longer rebuild token-backed dropdown styling with local class strings. | `DropdownItem` composes `DROPDOWN_CLASSES.item` and `DROPDOWN_ITEM` tokens. |
| `GitHubWorkItemControls.tsx` | existing `min-w-[180px]` panel width | keep with reason | The width belongs to the existing issue action panel and was not introduced or changed by this migration. | — |

## D3 — Hardcoded Sizes / Colors

| Line | Value | Verdict | Reason | Suggested change |
| --- | --- | --- | --- | --- |
| Action-menu icons | icon size and colors | fixed | Migrated rows source icon sizing from `DROPDOWN_ITEM.iconSize` and text colors from `DropdownItem` state instead of repeating caller-owned styling. | — |

## D4 — Accessibility

| Line | Element | Verdict | Reason | Suggested change |
| --- | --- | --- | --- | --- |
| `DropdownItem.tsx:183-227` | action row semantics | fixed | The shared component now supports `menuitem`, direct tab focus, Enter/Space activation, accessible names/submenu state, and removal of disabled rows from the tab order. `aria-selected` remains limited to listbox options. | — |
| Migrated menu callers | disabled/action rows | fixed | All four callers now use the same keyboard and disabled contract instead of relying on site-specific raw-button behavior and classes. | — |

## D5 — Visual Patterns Observed

- The four changed callers are a valid shared-pattern migration: they all render full-width action rows and do not need custom geometry.
- A repository sweep found 23 remaining `DROPDOWN_CLASSES.menuActionItem` call sites. Several are submenu triggers or label/control rows with `justify-between`, so they should be reviewed as one follow-up sweep rather than converted site-by-site without extending the shared suffix/submenu contract.
- No new global component is required; the follow-up candidate is broader adoption of the extended `DropdownItem`.

## Summary

- 6 fixes applied
- 3 patterns kept with documented reason
- 1 systematic sweep candidate (23 remaining `menuActionItem` sites)
- 0 new abstraction candidates
