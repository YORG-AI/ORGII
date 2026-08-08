# Frontend UI Audit — Team Member Detail Header

**File:** `src/modules/shared/dataSource/TeamMemberDetail.tsx` (407 LOC)
**Date:** 2026-08-06
**Auditor:** Codex PR audit

## D1 — Raw HTML vs Design System

| Line    | Element                 | Verdict          | Reason                                                                                                                                                                  | Suggested change |
| ------- | ----------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 179–199 | Back and refresh header | keep with reason | Back uses the project `Button`; the optional action slot receives the same shared refresh control used by the parent surface. Remaining `div` elements only own layout. | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line    | Value          | Verdict          | Reason                                                                                         | Suggested change |
| ------- | -------------- | ---------------- | ---------------------------------------------------------------------------------------------- | ---------------- |
| 179–199 | Header styling | keep with reason | The row uses standard spacing and sizing utilities with no raw colors or CSS-variable classes. | —                |

## D3 — Hardcoded Sizes / Colors

| Line    | Value           | Verdict          | Reason                                                                                                      | Suggested change |
| ------- | --------------- | ---------------- | ----------------------------------------------------------------------------------------------------------- | ---------------- |
| 179–199 | Header geometry | keep with reason | `min-h-9`, gaps, and shrink behavior are project scale utilities; no new pixel literal or color is present. | —                |

## D4 — Accessibility

| Line    | Element        | Verdict          | Reason                                                                                                                           | Suggested change |
| ------- | -------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 179–199 | Header actions | keep with reason | Both actions retain visible labels or accessible titles, native disabled/loading behavior, and predictable left/right placement. | —                |

## D5 — Visual Patterns Observed

- Pattern: list and detail views now share the same refresh control instance and compact action-row treatment.

## Summary

- 0 fixes recommended
- 4 kept with documented reason
- 0 abstract candidates (>= 3 occurrences)
