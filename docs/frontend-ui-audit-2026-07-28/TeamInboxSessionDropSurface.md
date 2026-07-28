# Frontend UI Audit — TeamInboxSessionDropSurface

**File:** `src/modules/MainApp/TeamInbox/components/TeamInboxSessionDropSurface.tsx` (233 LOC)
**Date:** 2026-07-28
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line          | Element                        | Verdict          | Reason                                                                                                                                           | Suggested change                                                          |
| ------------- | ------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| 118           | `<div>` surface owner          | keep with reason | Non-interactive layout/ref boundary; there is no design-system primitive for a custom-event drop receiver.                                       | —                                                                         |
| 122           | `<div>` drag overlay           | keep with reason | Semantic status surface with no direct pointer interaction; a Button/Card primitive would add incorrect interaction semantics.                   | —                                                                         |
| 151, 176      | `<div>` operation notices      | keep with reason | Inline status/alert regions need `role`, live-region behavior, and mixed actions; existing generic alerts do not model the retry/open lifecycle. | Consider a shared async-operation banner only after a third matching use. |
| 199, 209, 218 | Open / Retry / Dismiss actions | keep with reason | All interactive actions use the project design-system `Button`, including icon-only accessible dismissal.                                        | —                                                                         |

## D2 — Arbitrary Tailwind Value vs Token

| Line     | Value                    | Verdict          | Reason                                                                                                                                   | Suggested change |
| -------- | ------------------------ | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 124–145  | Drop overlay classes     | keep with reason | Uses configured spacing, radius, border, background, primary and text tokens; no arbitrary bracket value or raw CSS variable is present. | —                |
| 153, 178 | Operation banner classes | keep with reason | Both banners use project surface/border/text tokens and standard Tailwind scale values.                                                  | —                |

## D3 — Hardcoded Sizes / Colors

| Line                    | Value                | Verdict          | Reason                                                                                                                                    | Suggested change |
| ----------------------- | -------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 138, 158, 202, 212, 224 | Lucide `size` props  | keep with reason | Icon API dimensions are permitted micro-sizing and align with the existing Button/icon conventions.                                       | —                |
| 124–178                 | Colors and elevation | keep with reason | All color values are semantic tokens (`bg-bg-*`, `text-text-*`, `border-*`, `primary-*`); shadow and radii use configured utility scales. | —                |

## D4 — Accessibility

| Line    | Element                   | Verdict          | Reason                                                                                                                                                 | Suggested change |
| ------- | ------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| 122–129 | Drop Zone                 | keep with reason | Announced as a polite status, does not intercept pointer events, and mirrors the drag state visually without becoming a false keyboard control.        | —                |
| 151–180 | Processing / result state | keep with reason | Processing and success are polite status updates; failure is an alert. Long labels truncate visually while remaining intact in the accessibility tree. | —                |
| 218–226 | Dismiss action            | keep with reason | Icon-only DS Button has a localized `aria-label`; icon is decorative.                                                                                  | —                |

## D5 — Visual Patterns Observed

- Pattern: compact floating async-operation banner — two states in this component (processing and result), below the three-use abstraction threshold.
- Pattern: full-surface dashed drop affordance — one implementation.

## Summary

- 0 fixes recommended
- 11 kept with documented reason
- 0 abstract candidates (>= 3 occurrences)
