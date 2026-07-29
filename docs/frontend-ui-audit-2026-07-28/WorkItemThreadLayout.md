# Frontend UI Audit — WorkItemThreadLayout

**File:** `src/modules/ProjectManager/WorkItems/components/WorkItemThread/index.tsx`
**Date:** 2026-07-28
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line  | Element           | Verdict          | Reason                                                                                                                                             | Suggested change |
| ----- | ----------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 29–49 | Metadata wrappers | keep with reason | These non-interactive wrappers own the Work Item's responsive property overflow only; secondary navigation is deliberately outside this component. | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value                                    | Verdict          | Reason                                                                                    | Suggested change |
| ---- | ---------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------- | ---------------- |
| —    | No new arbitrary colors or CSS variables | keep with reason | The layout uses semantic border, fill, and text tokens through `WORK_ITEM_THREAD_TOKENS`. | —                |

## D3 — Hardcoded Sizes / Colors

| Line   | Value                                  | Verdict          | Reason                                                                                                                               | Suggested change |
| ------ | -------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| tokens | Existing `max-w-[920px]` reading width | keep with reason | This is the established Work Item reading measure, has no equivalent spacing-scale token, and is unchanged by the drill-in refactor. | —                |

## D4 — Accessibility

| Line  | Element         | Verdict          | Reason                                                                                                                             | Suggested change |
| ----- | --------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 29–49 | Metadata region | keep with reason | The layout does not add interaction or alter the keyboard order of property controls supplied by the canonical metadata component. | —                |

## D5 — Visual Patterns Observed

- Metadata owns only path and property content, preserving one clear information level.
- Discussion navigation is owned by `WorkItemContent` and `HistoryTab`, not the metadata layout.

## Summary

- 0 fixes recommended
- 4 kept with documented reason
- 0 abstract candidates
