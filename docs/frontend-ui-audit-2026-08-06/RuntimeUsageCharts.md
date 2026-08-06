# Frontend UI Audit — Runtime Usage Charts

**File:** `src/modules/shared/dataSource/TeamRuntimeToday.tsx` (378 LOC)
**Date:** 2026-08-06
**Auditor:** Codex PR audit

## D1 — Raw HTML vs Design System

| Line    | Element                         | Verdict          | Reason                                                                                                                                                          | Suggested change |
| ------- | ------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 284–328 | Per-member usage `<button>` row | keep with reason | The full-width row combines avatar, name, selected state, tokens, and cost; the design-system `Button` does not cover this multi-column toggle-row composition. | —                |
| 258–280 | Lazy chart fallback             | keep with reason | The raw `div` is a non-interactive, assistive-technology-hidden placeholder for the existing chart surface.                                                     | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line    | Value                     | Verdict          | Reason                                                                                                           | Suggested change |
| ------- | ------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------- |
| 255–328 | Chart and member surfaces | keep with reason | Backgrounds, borders, and text use project semantic tokens; no raw color or CSS-variable utility was introduced. | —                |

## D3 — Hardcoded Sizes / Colors

| Line | Value                 | Verdict          | Reason                                                                                                 | Suggested change |
| ---- | --------------------- | ---------------- | ------------------------------------------------------------------------------------------------------ | ---------------- |
| 267  | `h-72` chart fallback | keep with reason | The fallback uses the standard Tailwind spacing scale and reserves the existing chart's stable height. | —                |

## D4 — Accessibility

| Line    | Element            | Verdict          | Reason                                                                                                                                                    | Suggested change |
| ------- | ------------------ | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 284–328 | Member filter rows | keep with reason | Each row is a native keyboard-focusable button with a visible member name and `aria-pressed` state; the selected background is not the only state signal. | —                |

## D5 — Visual Patterns Observed

- Pattern: rolling usage reuses the lazy-loaded `UsageTrendChart`, existing section-heading classes, `SectionContainer`, and shared number formatting.
- Pattern: chart and per-member breakdown use the same localized rolling-24-hour range label and the same roster snapshot, avoiding parallel controls or data surfaces.

## Summary

- 0 fixes recommended
- 5 kept with documented reason
- 0 abstract candidates (>= 3 occurrences)
