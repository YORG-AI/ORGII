# Frontend UI Audit — CreateCollabOrgView

**File:** `src/features/TeamCollaboration/components/CreateCollabOrgView/index.tsx` (395 LOC)
**Date:** 2026-08-03
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line | Element                             | Verdict          | Reason                                                                                                                                                                                                   | Suggested change |
| ---- | ----------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 337  | Guide-target `<div>` around `Input` | keep with reason | The wrapper is non-interactive instrumentation whose geometry intentionally matches the complete design-system `Input`; placing the target on the native inner input produced a visibly inset spotlight. | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value         | Verdict | Reason                                                                           | Suggested change         |
| ---- | ------------- | ------- | -------------------------------------------------------------------------------- | ------------------------ |
| 320  | `text-[12px]` | fix     | The project spacing/type scale already exposes the equivalent `text-xs` utility. | Replaced with `text-xs`. |

## D3 — Hardcoded Sizes / Colors

| Line | Value           | Verdict          | Reason                                                                                                  | Suggested change |
| ---- | --------------- | ---------------- | ------------------------------------------------------------------------------------------------------- | ---------------- |
| —    | None introduced | keep with reason | The guide integration reuses the existing input dimensions, color tokens, and shared spotlight styling. | —                |

## D4 — Accessibility

| Line | Element                           | Verdict | Reason                                                                                                                      | Suggested change                                                   |
| ---- | --------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 341  | Focused organization-name `Input` | fix     | The guide moves keyboard focus to this field, so the control must expose the visible localized field name programmatically. | Added a localized `aria-label`; focus remains on the native input. |

## D5 — Visual Patterns Observed

- Pattern: non-interactive guide instrumentation wraps a design-system control without replacing its keyboard or accessible semantics; the invite guide uses the same ownership rule.

## Summary

- 2 fixes applied
- 2 kept with documented reason
- 0 abstract candidates (>= 3 occurrences)
