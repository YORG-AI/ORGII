# Frontend UI Audit — SidebarGuideButton

**File:** `src/scaffold/NavigationSidebar/connectors/SidebarGuideButton.tsx` (292 LOC)
**Date:** 2026-08-01
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line | Element                                 | Verdict          | Reason                                                                                                                                            | Suggested change |
| ---- | --------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 170  | Trigger ref wrapper `<div>`             | keep with reason | `useDropdownEngine` measures a stable wrapper around the shared `IconButton`; the same composition is used by existing sidebar dropdown triggers. | —                |
| 201  | Header layout `<div>` and text `<span>` | keep with reason | These are non-interactive layout/text nodes around shared `IconButton` and `ProgressBar` components; no covering design-system primitive exists.  | —                |
| 243  | Task-stack wrapper `<div>`              | keep with reason | The wrapper uses shared `DROPDOWN_CLASSES.itemsColumnPadded`; all interactive rows use `DropdownItem`.                                            | —                |
| 269  | Identity footer `<div>`                 | keep with reason | Non-interactive footer composed from shared `Avatar` and typography/color tokens.                                                                 | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value | Verdict          | Reason                                                                                                                                                 | Suggested change |
| ---- | ----- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| —    | —     | keep with reason | No arbitrary Tailwind values are used; panel width, spacing, surfaces, and icon sizing use existing dropdown/workstation tokens or the Tailwind scale. | —                |

## D3 — Hardcoded Sizes / Colors

| Line | Value                             | Verdict          | Reason                                                                                                                        | Suggested change |
| ---- | --------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 191  | `maxHeight="none"`                | keep with reason | This short task panel must not inherit the scrollable-list cap; its visual dimensions still come from shared dropdown tokens. | —                |
| 195  | Engine-provided fixed coordinates | keep with reason | `top`, `bottom`, and `left` are runtime placement output from `useDropdownEngine`, not authored visual constants.             | —                |
| 270  | Avatar size expression            | keep with reason | The size is derived entirely from `DROPDOWN_ITEM` and `DROPDOWN_PANEL` tokens to align with shared menu rows.                 | —                |

## D4 — Accessibility

| Line | Element        | Verdict          | Reason                                                                                                                                                                   | Suggested change |
| ---- | -------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| 171  | Guide trigger  | keep with reason | Shared `IconButton` has a localized accessible name plus `aria-haspopup` and `aria-expanded`.                                                                            | —                |
| 188  | Guide menu     | keep with reason | Shared `DropdownPanel` declares `role="menu"` and a localized label.                                                                                                     | —                |
| 210  | Header actions | keep with reason | Shared icon buttons have localized accessible names; the ellipsis runs quick setup and the chevron closes the panel.                                                     | —                |
| 229  | Progress bar   | keep with reason | Shared `ProgressBar` exposes min/max/current values and a localized completion label.                                                                                    | —                |
| 245  | Guide tasks    | keep with reason | Shared `DropdownItem` rows use `role="menuitem"`, direct keyboard focus, and Enter/Space activation; Escape and outside-click behavior are owned by `useDropdownEngine`. | —                |

## D5 — Visual Patterns Observed

- Pattern: shared `IconButton` + `WorkstationToolbarTooltip` in sidebar top chrome — also used by session filter and sidebar controls.
- Pattern: compact floating task panel composed from shared `DropdownPanel`, `DropdownItem`, `ProgressBar`, and `Avatar`; no duplicate hand-built control primitives were introduced.
- Pattern: task suffixes reuse the repository-backed `SetupStepIcons`; Lucide is limited to generic state and control affordances.
- Pattern: first incomplete milestone uses the existing dropdown highlight surface, matching the reference's current-task emphasis.

## Summary

- 0 fixes recommended
- 12 kept with documented reason
- 0 abstract candidates (>= 3 occurrences)
