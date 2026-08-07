# Frontend UI Audit — GeneralSection

**File:** `src/modules/MainApp/Settings/sections/GeneralSection.tsx` (411 LOC)
**Date:** 2026-07-13
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line    | Element                       | Verdict          | Reason                                                                                                  | Suggested change |
| ------- | ----------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------- | ---------------- |
| 371–376 | Automatic-update settings row | keep with reason | Uses the established `SectionRow` and design-system `Switch`; no raw interactive element was introduced | —                |

## D2 — Arbitrary Tailwind Value vs Token

No hits in the changed UI.

## D3 — Hardcoded Sizes / Colors

No hits in the changed UI.

## D4 — Accessibility

| Line    | Element                 | Verdict          | Reason                                                                                                                                  | Suggested change |
| ------- | ----------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 371–376 | Automatic-update switch | keep with reason | `SectionRow` supplies the visible setting label and the existing `Switch` component supplies keyboard interaction and control semantics | —                |

## D5 — Visual Patterns Observed

- The new row follows the existing settings-row pattern; no new independent visual pattern was introduced.

## Summary

- 0 fixes recommended
- 2 kept with documented reason
- 0 abstract candidates
