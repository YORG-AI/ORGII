# Frontend UI Audit — AppMark

**File:** `src/components/AppMark/index.tsx` (80 LOC)
**Date:** 2026-07-12
**Auditor:** ORGII assistant session

## D1 — Raw HTML vs Design System

| Line | Element          | Verdict          | Reason                                                                                                                                                  | Suggested change |
| ---- | ---------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 52   | `<span>` wrapper | keep with reason | Pure display primitive; no interactive/structural DS component applies. Switched from `<div>` to inline `<span>` to better match inline icon semantics. | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value | Verdict | Reason                                                                                                      | Suggested change |
| ---- | ----- | ------- | ----------------------------------------------------------------------------------------------------------- | ---------------- |
| —    | —     | keep    | No arbitrary Tailwind CSS-var or raw color class found. Uses existing `bg-fill-2` and `text-text-1` tokens. | —                |

## D3 — Hardcoded Sizes / Colors

| Line | Value                                   | Verdict          | Reason                                                                                                                                                     | Suggested change |
| ---- | --------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 16   | `DEFAULT_SIZE = 20`                     | keep with reason | Component exposes pixel-based `size` prop for an SVG/icon primitive; fixed numeric default is the component API rather than a Tailwind spacing class site. | —                |
| 17   | `GLYPH_SCALE = 0.55`                    | keep with reason | Optical brand-mark ratio; not a spacing token candidate.                                                                                                   | —                |
| 48   | `style={{ width: size, height: size }}` | keep with reason | Dynamic prop-driven sizing cannot be represented by static Tailwind classes.                                                                               | —                |

## D4 — Accessibility

| Line  | Element            | Verdict          | Reason                                                                                                                                                                       | Suggested change |
| ----- | ------------------ | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 55-57 | wrapper aria attrs | fix applied      | Previous component was always decorative via `aria-hidden`. Added optional `title` prop so consumers can opt into `role="img"` + `aria-label` when the mark carries meaning. | —                |
| 66    | `<svg>`            | keep with reason | SVG paths are implementation detail; wrapper owns the accessible name when `title` is provided, otherwise the whole mark is decorative.                                      | —                |

## D5 — Visual Patterns Observed

- Pattern: inline brand/icon primitive with dynamic `size` and optional className — also present in nearby icon components such as `IntegrationIcon`, but not enough evidence for a new abstraction in this single-file change.

## Summary

- 1 fix applied
- 5 kept with documented reason
- 0 abstract candidates
