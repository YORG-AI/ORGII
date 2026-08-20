# Frontend UI Audit — CanvasShareDialog

**File:** `src/features/CanvasShare/CanvasShareDialog.tsx`
**Date:** 2026-08-10
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line    | Element               | Verdict          | Reason                                                                           | Suggested change |
| ------- | --------------------- | ---------------- | -------------------------------------------------------------------------------- | ---------------- |
| 58–65   | Share modal           | keep with reason | Uses the established `ModalSystem` surface used by other ORGII dialogs.          | —                |
| 91–104  | Read-only link field  | keep with reason | Uses the shared `Input`; focus selection supports the manual-copy recovery path. | —                |
| 134–147 | Open and copy actions | keep with reason | Both actions use the shared `Button` component with explicit semantic variants.  | —                |
| 159     | Retry action          | keep with reason | Uses the shared secondary `Button` for the recoverable error transition.         | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value | Verdict          | Reason                                                    | Suggested change |
| ---- | ----- | ---------------- | --------------------------------------------------------- | ---------------- |
| —    | —     | keep with reason | No arbitrary CSS-variable or raw-color values were found. | —                |

## D3 — Hardcoded Sizes / Colors

| Line | Value             | Verdict          | Reason                                                                                                       | Suggested change |
| ---- | ----------------- | ---------------- | ------------------------------------------------------------------------------------------------------------ | ---------------- |
| 64   | Modal width `520` | keep with reason | The explicit dialog width matches the existing Cloud sharing surface and keeps long fallback links readable. | —                |

## D4 — Accessibility

| Line    | Element               | Verdict          | Reason                                                                                  | Suggested change |
| ------- | --------------------- | ---------------- | --------------------------------------------------------------------------------------- | ---------------- |
| 78–88   | Preparing state       | keep with reason | `aria-live="polite"` announces link preparation without moving focus.                   | —                |
| 91–104  | Share-link input      | keep with reason | The read-only field has a localized accessible label and visible copy-failure recovery. | —                |
| 150–162 | Error and retry state | keep with reason | Uses `role="alert"` plus a keyboard-accessible native shared button.                    | —                |

## D5 — Visual Patterns Observed

- Reuses the existing ORGII modal, read-only field, and action-row patterns; no new repeated visual primitive was introduced.

## Summary

- 0 fixes recommended
- 10 kept with documented reason
- 0 abstract candidates
