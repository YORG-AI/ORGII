# Frontend UI Audit — WorkItemContent secondary views

**File:** `src/modules/ProjectManager/WorkItems/components/WorkItemContent/index.tsx` (604 LOC)
**Date:** 2026-07-28
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line    | Element              | Verdict          | Reason                                                                                                                                                        | Suggested change |
| ------- | -------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 579–603 | Drill-in composition | keep with reason | Navigation is delegated to `WorkItemThreadViewAction`; this file contains only local view state and conditional composition, with no raw interactive element. | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value                          | Verdict          | Reason                                                                                      | Suggested change |
| ---- | ------------------------------ | ---------------- | ------------------------------------------------------------------------------------------- | ---------------- |
| —    | No new arbitrary color utility | keep with reason | The secondary-view change introduces no visual utility outside the audited shared switcher. | —                |

## D3 — Hardcoded Sizes / Colors

| Line | Value                        | Verdict          | Reason                                                                                              | Suggested change |
| ---- | ---------------------------- | ---------------- | --------------------------------------------------------------------------------------------------- | ---------------- |
| —    | No new literal size or color | keep with reason | Existing description/editor dimensions are unchanged; the new branch is component composition only. | —                |

## D4 — Accessibility

| Line    | Element                               | Verdict          | Reason                                                                                                                                                                                | Suggested change |
| ------- | ------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 579–617 | Work Item / Discussion content branch | keep with reason | Exactly one view is mounted at a time; Discussion sits after primary content and Back sits in its own toolbar, both outside metadata. No duplicate focus targets are hidden with CSS. | —                |

## D5 — Visual Patterns Observed

- Team Inbox and the formal Work Item both consume this same branch through `WorkItemThreadSurface`; no entry-point-specific secondary navigation was introduced.
- Existing default-presentation Session / Output / History tabs remain independent and unchanged.
- The prior persistent Overview / Activity tab strip and ambiguous total-history badge were removed; the Work Item is now the implicit primary surface.
- Property metadata and Discussion navigation are separate regions with separate hierarchy and borders.

## Summary

- 0 fixes recommended
- 4 kept with documented reason
- 0 abstract candidates
