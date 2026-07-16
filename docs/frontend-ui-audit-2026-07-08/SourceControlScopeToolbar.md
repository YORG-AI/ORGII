# Frontend UI Audit — SourceControlScopeToolbar

**File:** `src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/tabs/SourceControlScopeToolbar.tsx` (371 LOC)
**Date:** 2026-07-08
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line | Element                                          | Verdict          | Reason                                                                                                                | Suggested change |
| ---- | ------------------------------------------------ | ---------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 143  | `DropdownItem` scope row                         | keep with reason | Uses existing DS dropdown row and adds DS icon/suffix props rather than raw button markup.                            | —                |
| 158  | `IconButton` remove action                       | keep with reason | Uses DS icon button with `aria-label`; custom absolute positioning is limited to overlay placement.                   | —                |
| 268  | `<input type="search">` existing dropdown search | keep with reason | Existing local Dropdown search pattern uses `DROPDOWN_CLASSES.searchInput`; this PR does not introduce the raw input. | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value | Verdict          | Reason                                                     | Suggested change |
| ---- | ----- | ---------------- | ---------------------------------------------------------- | ---------------- |
| —    | —     | keep with reason | No new arbitrary color/token values introduced by this PR. | —                |

## D3 — Hardcoded Sizes / Colors

| Line | Value                                       | Verdict          | Reason                                                                         | Suggested change |
| ---- | ------------------------------------------- | ---------------- | ------------------------------------------------------------------------------ | ---------------- |
| 258  | `max-w-[320px]` existing dropdown width cap | keep with reason | Existing constrained dropdown width; the PR only reuses the surrounding panel. | —                |

## D4 — Accessibility

| Line | Element                    | Verdict          | Reason                                                          | Suggested change |
| ---- | -------------------------- | ---------------- | --------------------------------------------------------------- | ---------------- |
| 147  | row icon                   | keep with reason | Decorative icon is inside the already named `DropdownItem` row. | —                |
| 164  | remove button `aria-label` | keep with reason | Icon-only destructive action has explicit accessible name.      | —                |
| 297  | separator                  | keep with reason | Decorative separator is marked `aria-hidden`.                   | —                |

## D5 — Visual Patterns Observed

- Pattern: selected dropdown suffix with optional stats and trailing checkmark — implemented once here using existing `DropdownSelectedCheck`.
- Pattern: section separator and section label — uses `DROPDOWN_CLASSES.menuSeparatorInset` and `DROPDOWN_CLASSES.sectionLabel`.

## Summary

- 0 fixes recommended
- 6 kept with documented reason
- 0 abstract candidates
