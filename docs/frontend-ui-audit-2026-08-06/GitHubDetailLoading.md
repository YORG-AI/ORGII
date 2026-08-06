# Frontend UI Audit — GitHub Detail Loading

**File:** `src/modules/shared/components/GitHubDetailSkeleton/index.tsx` (116 LOC)
**Date:** 2026-08-06
**Auditor:** Codex PR audit

## D1 — Raw HTML vs Design System

| Line   | Element                        | Verdict          | Reason                                                                                                                                                 | Suggested change |
| ------ | ------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| 10–12  | `SkeletonBar` layout primitive | keep with reason | The raw `div` is decorative, non-interactive, and hidden from assistive technology; a design-system input or button would provide incorrect semantics. | —                |
| 65–103 | Skeleton `section` elements    | keep with reason | Native sections mirror the eventual detail hierarchy and contain no interaction; no design-system component covers a semantic loading region.          | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line   | Value                         | Verdict          | Reason                                                                                                                                                          | Suggested change |
| ------ | ----------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 24–107 | Skeleton surfaces and borders | keep with reason | The component uses project tokens (`chat-pane`, `primary-container`, `fill-2`, and `border-*`) and introduces no arbitrary CSS-variable or raw-color utilities. | —                |

## D3 — Hardcoded Sizes / Colors

| Line   | Value                   | Verdict          | Reason                                                                                                                                                             | Suggested change                                                                     |
| ------ | ----------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| 50     | `max-w-[920px]`         | abstract         | The same canonical detail-column width appears in the work-item thread token and another content surface; a one-file replacement would not remove the duplication. | Promote the 920px detail-column width to a shared layout token in a dedicated sweep. |
| 31–107 | Skeleton bar dimensions | keep with reason | The widths intentionally vary to mimic the issue/PR hierarchy and prevent a uniform artificial grid; all values use the Tailwind spacing and fraction scales.      | —                                                                                    |

## D4 — Accessibility

| Line          | Element                    | Verdict          | Reason                                                                                                                             | Suggested change |
| ------------- | -------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 23–29         | Loading root               | keep with reason | The frame exposes `role="status"`, `aria-busy`, and a localized accessible label before any detail content is available.           | —                |
| 10–12, 31–107 | Decorative bars and motion | keep with reason | Bars are hidden from assistive technology, the frame contains no fake controls, and pulse animation has a reduced-motion override. | —                |

## D5 — Visual Patterns Observed

- Pattern: one kind-aware skeleton now owns the first-paint hierarchy for issue and PR details in both ChatPanel and WorkStation.
- Pattern: lazy-module fallbacks and cold-data fallbacks reuse the same component, so loading no longer changes shape between the two phases.
- Pattern: the 920px canonical detail width has reached three repository occurrences and is a future shared-layout-token candidate.

## Summary

- 0 fixes recommended
- 6 kept with documented reason
- 1 abstract candidate (>= 3 occurrences)
