# Frontend UI Audit — Team Member Card

**File:** `src/modules/shared/dataSource/TeamMemberCard.tsx` (224 LOC)
**Date:** 2026-08-06
**Auditor:** Codex PR audit

## D1 — Raw HTML vs Design System

| Line    | Element                    | Verdict          | Reason                                                                                                                                                                                | Suggested change |
| ------- | -------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 117–223 | Raw member-card `<button>` | keep with reason | The entire multi-row card is one navigation hit area with avatars, badges, statistics, and responsive layout; the design-system `Button` does not cover this card-shaped composition. | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line    | Value                   | Verdict          | Reason                                                                                                                      | Suggested change |
| ------- | ----------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 122–223 | Card colors and borders | keep with reason | The card uses semantic project tokens and removes the misleading whole-card opacity treatment; no raw color was introduced. | —                |

## D3 — Hardcoded Sizes / Colors

| Line     | Value                          | Verdict          | Reason                                                                                                                              | Suggested change |
| -------- | ------------------------------ | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 134, 150 | `text-[10px]` compact metadata | keep with reason | The values are pre-existing badge/type metadata sized to fit the dense card header and are outside this focused opacity correction. | —                |

## D4 — Accessibility

| Line    | Element            | Verdict          | Reason                                                                                                                                                  | Suggested change |
| ------- | ------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 117–223 | Member-card button | keep with reason | The card is a native keyboard-focusable button with a visible member name; retained `data-stale` metadata no longer visually implies a disabled action. | —                |

## D5 — Visual Patterns Observed

- Pattern: stale telemetry remains machine-readable while all member cards retain the same enabled visual treatment and navigation affordance.

## Summary

- 0 fixes recommended
- 4 kept with documented reason
- 0 abstract candidates (>= 3 occurrences)
