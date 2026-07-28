# Frontend UI Audit — WorktreeSourceModal Phase 2

**Files:**

- `src/features/SessionCreator/components/WorktreeSourceModal.tsx` (758 LOC after Phase 2)
- `src/features/SessionCreator/components/WorktreeBranchTab.tsx` (177 LOC)
- `src/features/SessionCreator/components/WorktreeSourceModalRows.tsx` (99 LOC)

**Date:** 2026-07-20
**Auditor:** ORGII agent session

## D1 — Raw HTML vs Design System

| Line        | Element                  | Verdict          | Reason                                                                                | Suggested change |
| ----------- | ------------------------ | ---------------- | ------------------------------------------------------------------------------------- | ---------------- |
| Branch leaf | search input             | keep with reason | Uses shared `Input` with the existing search prefix and shared refresh-suffix leaf.   | —                |
| Branch leaf | list and selectable rows | keep with reason | Reuses the audited token-backed list and semantic full-width row leaves from Phase 1. | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line        | Value | Verdict          | Reason                                                                                                                               | Suggested change |
| ----------- | ----- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| Branch leaf | none  | keep with reason | No arbitrary color or CSS-variable utility was introduced; section labels and rows use existing dropdown tokens and semantic colors. | —                |

## D3 — Hardcoded Sizes / Colors

| Line        | Value                         | Verdict          | Reason                                                                                                                                                 | Suggested change                                                        |
| ----------- | ----------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Branch leaf | `min-h-[250px]`, `h-[180px]`  | keep with reason | Preserves the established modal tab and status-canvas geometry exactly; changing it would alter modal layout rather than improve the structural split. | Consider only in a modal-wide sizing pass across all four tabs.         |
| Branch leaf | `text-[12px]` / `text-[13px]` | keep with reason | Preserves the existing compact selector hierarchy and was moved unchanged.                                                                             | Consider only in a repository-wide compact-menu typography token sweep. |

## D4 — Accessibility

| Line        | Element                 | Verdict          | Reason                                                                                   | Suggested change |
| ----------- | ----------------------- | ---------------- | ---------------------------------------------------------------------------------------- | ---------------- |
| Branch leaf | search label/input      | keep with reason | Stable `htmlFor`/`id` association and contextual `aria-label` remain intact.             | —                |
| Branch leaf | error state             | keep with reason | Retains `role="alert"` and `aria-live="assertive"`.                                      | —                |
| Branch leaf | refresh and source rows | keep with reason | Reuses the Phase 1 leaves with contextual accessible labels and native button semantics. | —                |

## D5 — Visual Patterns Observed

- The Branch tab is now a cohesive presentation leaf while derivation, data loading, and selection remain in the modal coordinator.
- Status canvases remain repeated in Smart/GitHub tabs; watch for a shared modal-state primitive only after another tab extraction confirms a stable union.

## Summary

- 0 fixes recommended
- 8 kept with documented reason
- 0 abstract candidates
