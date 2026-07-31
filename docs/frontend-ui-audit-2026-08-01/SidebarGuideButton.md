# Frontend UI Audit — SidebarGuideButton

**File:** `src/scaffold/NavigationSidebar/connectors/SidebarGuideButton.tsx` (164 LOC)
**Date:** 2026-08-01
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line | Element                        | Verdict          | Reason                                                                                                                                            | Suggested change |
| ---- | ------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 75   | Trigger ref wrapper `<div>`    | keep with reason | `useDropdownEngine` measures a stable wrapper around the shared `IconButton`; the same composition is used by existing sidebar dropdown triggers. | —                |
| 106  | Dropdown items wrapper `<div>` | keep with reason | Layout uses the shared `DROPDOWN_CLASSES.itemsColumnPadded` token; there is no semantic design-system component for this internal menu stack.     | —                |
| 107  | Dropdown section label `<div>` | keep with reason | The label uses the shared `DROPDOWN_CLASSES.sectionLabel` token and remains internal to the shared `DropdownPanel`.                               | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value | Verdict          | Reason                                                                                                                     | Suggested change |
| ---- | ----- | ---------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| —    | —     | keep with reason | No arbitrary Tailwind values are used; panel width, spacing, and icon sizing come from shared dropdown/workstation tokens. | —                |

## D3 — Hardcoded Sizes / Colors

| Line | Value                             | Verdict          | Reason                                                                                                                                             | Suggested change |
| ---- | --------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 96   | `maxHeight="none"`                | keep with reason | This short action menu must not inherit the scrollable-list height cap; all visual size and color values still come from shared components/tokens. | —                |
| 100  | Engine-provided fixed coordinates | keep with reason | `top`, `bottom`, and `left` are runtime placement output from `useDropdownEngine`, not authored visual constants.                                  | —                |

## D4 — Accessibility

| Line | Element       | Verdict          | Reason                                                                                                                                                                   | Suggested change |
| ---- | ------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| 76   | Guide trigger | keep with reason | Shared `IconButton` has a localized accessible name plus `aria-haspopup` and `aria-expanded`.                                                                            | —                |
| 93   | Guide menu    | keep with reason | Shared `DropdownPanel` declares `role="menu"` and a localized label.                                                                                                     | —                |
| 110  | Guide actions | keep with reason | Shared `DropdownItem` rows use `role="menuitem"`, direct keyboard focus, and Enter/Space activation; Escape and outside-click behavior are owned by `useDropdownEngine`. | —                |

## D5 — Visual Patterns Observed

- Pattern: shared `IconButton` + `WorkstationToolbarTooltip` in the sidebar top chrome — also used by session filter and sidebar controls.
- Pattern: shared `DropdownPanel` + `DropdownItem` command menu with tokenized section label and separator — also used by the sidebar settings and session filter menus.

## Summary

- 0 fixes recommended
- 8 kept with documented reason
- 0 abstract candidates (>= 3 occurrences)
