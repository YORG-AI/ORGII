# Frontend UI Audit — InlineAlert

**File:** `src/components/InlineAlert/index.tsx` (220 LOC)
**Date:** 2026-07-09
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line | Element                     | Verdict          | Reason                                                                                                                                                                                                                                                          | Suggested change                                                                                         |
| ---- | --------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 185  | `<button>` pill expander    | keep with reason | This is the semantic wrapper for the whole alert title row, needs `aria-expanded`, text-left full-width layout, and wraps arbitrary title/icon content; DS `Button` would add button chrome that does not match the pill alert surface.                         | —                                                                                                        |
| 199  | `<button>` close affordance | keep with reason | It is icon-only and has an accessible label; the local styling intentionally inherits the alert color with a tiny transparent hit area. Existing `IconButton` is toolbar-oriented and would introduce workstation button sizing/variant styling into the alert. | Consider an `InlineAlert`-specific close subcomponent only if this pattern grows outside this component. |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value | Verdict          | Reason                                                                                         | Suggested change |
| ---- | ----- | ---------------- | ---------------------------------------------------------------------------------------------- | ---------------- |
| —    | —     | keep with reason | No CSS-var arbitrary values, raw hex colors, or raw RGB/HSL color literals found in this file. | —                |

## D3 — Hardcoded Sizes / Colors

| Line | Value                           | Verdict          | Reason                                                                                                                                                                             | Suggested change |
| ---- | ------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 51   | `text-[13px]`, `leading-[14px]` | keep with reason | Alert title typography is below the standard text scale and is now centralized in `INLINE_ALERT_TOKENS`; changing to a spacing/text scale token would alter compact alert density. | —                |
| 52   | `text-[12px]`                   | keep with reason | Alert body typography is compact by design and reused through `INLINE_ALERT_TOKENS.bodyText`.                                                                                      | —                |
| 53   | `text-[11px]`                   | keep with reason | Subtitle typography is a compact secondary treatment and reused through `INLINE_ALERT_TOKENS.subtitleText`.                                                                        | —                |
| 160  | `h-[14px]`                      | keep with reason | This is a sub-scale optical alignment wrapper matching the 14px lucide icons used by the component.                                                                                | —                |

## D4 — Accessibility

| Line | Element              | Verdict          | Reason                                                                                                                   | Suggested change |
| ---- | -------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| 185  | Pill expander button | keep with reason | It exposes `aria-expanded` and contains visible title/body text through `titleNode`, so it has a usable accessible name. | —                |
| 199  | Close button         | keep with reason | It has `aria-label={closeAriaLabel}` with a default label, so the icon-only control is named.                            | —                |

## D5 — Visual Patterns Observed

- Pattern: compact inline alert surface with icon, optional title/body, action, close, and pill expansion — implemented as the shared `InlineAlert` component itself, not duplicated across audited files.
- Pattern: compact alert typography — centralized in `INLINE_ALERT_TOKENS`, so no sweep candidate from this change.

## Summary

- 0 fixes recommended
- 8 kept with documented reason
- 0 abstract candidates (>= 3 occurrences)
