# Frontend UI Audit — Message

**File:** `src/components/Message/index.tsx` (428 LOC)

**Date:** 2026-07-16

**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line | Element                                | Verdict          | Reason                                                                                                                                                                                    | Suggested change |
| ---- | -------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 219  | `<button>` compact cancel/retry action | keep with reason | Toast actions intentionally render as zero-padding inline links; the design-system `Button` adds a 24px minimum height and horizontal padding that changes this established toast layout. | —                |
| 228  | `<button>` compact download action     | keep with reason | Same compact inline-action contract as cancel/retry, with visible text and native semantics.                                                                                              | —                |
| 242  | `<button>` close control               | keep with reason | The control uses a 24px toast-specific alignment box with negative optical margins; the design-system circle button would change spacing inside the constrained notice row.               | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line   | Value                                             | Verdict | Reason                                                                                          | Suggested change   |
| ------ | ------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------- | ------------------ |
| 87–103 | status border/icon arbitrary CSS-variable classes | fix     | Applied in this PR: replaced with `border-*-6/30`, `bg-*-6/15`, and `text-*-6` token utilities. | No further change. |

## D3 — Hardcoded Sizes / Colors

| Line    | Value                                      | Verdict          | Reason                                                                                                                                                                                 | Suggested change                                                                |
| ------- | ------------------------------------------ | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 193–210 | 13px toast typography and custom elevation | keep with reason | These pre-existing values define the compact toast density and two-layer floating elevation; changing them is outside the progress behavior and lacks a pixel-equivalent shared token. | Consider a dedicated toast typography/elevation token in a future system sweep. |

## D4 — Accessibility

| Line    | Element                 | Verdict          | Reason                                                                                                                            | Suggested change |
| ------- | ----------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 219–248 | toast actions and close | keep with reason | Actions have visible labels; the icon-only close button has an i18n-backed `aria-label`; all use native keyboard-capable buttons. | —                |

## D5 — Visual Patterns Observed

- Fixed-ID persistent notice slots are message infrastructure behavior, not a duplicated visual pattern.
- No new cross-file visual abstraction candidate reached the three-site threshold.

## Summary

- 1 fix applied
- 5 kept with documented reason
- 0 abstract candidates
