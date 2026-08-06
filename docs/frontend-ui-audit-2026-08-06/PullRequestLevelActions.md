# Frontend UI Audit — Pull Request Level Actions

**File:** `src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/content/PullRequestContent/detail/PrLevelActions.tsx` (349 LOC)
**Date:** 2026-08-06
**Auditor:** Codex PR audit

## D1 — Raw HTML vs Design System

| Line    | Element                            | Verdict          | Reason                                                                                                                                                                        | Suggested change |
| ------- | ---------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 178–346 | Merge, reviewer, and state actions | keep with reason | Interactive controls use the project `Button`, `Dropdown`, `DropdownPanel`, and `DropdownItem` primitives; the remaining `div` elements are layout or controlled-popup hosts. | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line    | Value                       | Verdict          | Reason                                                                                                                                                        | Suggested change |
| ------- | --------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 178–346 | Dropdown and action styling | keep with reason | Layout and popup styling come from `DROPDOWN_CLASSES`, `DROPDOWN_WIDTHS`, and standard Tailwind tokens; no arbitrary project color variables were introduced. | —                |

## D3 — Hardcoded Sizes / Colors

| Line          | Value                             | Verdict          | Reason                                                                                                                                | Suggested change |
| ------------- | --------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 226, 252, 313 | 14px icons and 28px split control | keep with reason | The numeric props define icon and split-button geometry required by the shared components and align with their compact control scale. | —                |

## D4 — Accessibility

| Line    | Element                   | Verdict          | Reason                                                                                                                                                                         | Suggested change |
| ------- | ------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| 216–325 | PR action group and menus | keep with reason | The section is named, buttons have visible localized labels, decorative icons are hidden, disabled states are native, and the controlled merge button exposes `aria-expanded`. | —                |

## D5 — Visual Patterns Observed

- Pattern: merge methods and auto-merge share one design-system dropdown panel; reviewer selection reuses the same dropdown tokens rather than introducing a parallel menu surface.
- Pattern: stable action translation keys now travel with presentation data, avoiding a second UI-only mapping keyed by English display text.

## Summary

- 0 fixes recommended
- 4 kept with documented reason
- 0 abstract candidates (>= 3 occurrences)
