# Frontend UI Audit — Team Runtime Members

**File:** `src/modules/shared/dataSource/TeamRuntimePanel.tsx` (440 LOC)
**Date:** 2026-08-06
**Auditor:** Codex PR audit

## D1 — Raw HTML vs Design System

| Line    | Element                           | Verdict          | Reason                                                                                                                                             | Suggested change |
| ------- | --------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 357–407 | Member grouping and header layout | keep with reason | The native `section`, `h3`, and `h4` elements provide the correct document hierarchy; refresh remains the existing design-system `Button` wrapper. | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line    | Value           | Verdict          | Reason                                                                                                                         | Suggested change |
| ------- | --------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| 357–423 | Member surfaces | keep with reason | Spacing, background, border, and text colors use project Tailwind tokens; no raw CSS-variable or color utility was introduced. | —                |

## D3 — Hardcoded Sizes / Colors

| Line | Value                  | Verdict          | Reason                                                                                                                                             | Suggested change |
| ---- | ---------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 394  | `@[640px]:grid-cols-2` | keep with reason | This is the existing container breakpoint for the member-card minimum width and keeps the layout responsive to the panel rather than the viewport. | —                |

## D4 — Accessibility

| Line    | Element         | Verdict          | Reason                                                                                                                                                | Suggested change |
| ------- | --------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 357–407 | Activity groups | keep with reason | The breakdown preserves ordered heading levels and semantic sections; refresh keeps its accessible label, loading state, and duplicate-request guard. | —                |

## D5 — Visual Patterns Observed

- Pattern: the Members view now matches the adjacent Today view's compact title/action row and shared section-heading token.
- Pattern: active-today and inactive-today groups reuse the same card grid rather than duplicating member-card markup.

## Summary

- 0 fixes recommended
- 4 kept with documented reason
- 0 abstract candidates (>= 3 occurrences)
