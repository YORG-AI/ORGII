# Frontend UI Audit — KanbanHeaderFilters

**File:** `src/features/TaskKanban/components/KanbanHeaderFilters/index.tsx` (255 LOC)
**Date:** 2026-07-14
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line | Element             | Verdict          | Reason                                                                                                                             | Suggested change |
| ---- | ------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 240  | Agent-source filter | keep with reason | Uses the existing design-system `Select`; the Warp change only consumes the shared source map and adds no raw interactive element. | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value | Verdict          | Reason                                                                                                         | Suggested change |
| ---- | ----- | ---------------- | -------------------------------------------------------------------------------------------------------------- | ---------------- |
| —    | None  | keep with reason | The Warp mapping adds no style value; the component contains no arbitrary color/token addition in this change. | —                |

## D3 — Hardcoded Sizes / Colors

| Line | Value | Verdict          | Reason                                 | Suggested change |
| ---- | ----- | ---------------- | -------------------------------------- | ---------------- |
| —    | None  | keep with reason | No size or color was added or changed. | —                |

## D4 — Accessibility

| Line | Element  | Verdict          | Reason                                                                                                                                 | Suggested change |
| ---- | -------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 240  | `Select` | keep with reason | Existing shared control retains its keyboard and accessible-name behavior; Warp supplies the visible label from the source descriptor. | —                |

## D5 — Visual Patterns Observed

- The existing imported-source filter generation is reused; no new visual pattern or third implementation was introduced.

## Summary

- 0 fixes recommended
- 4 kept with documented reason
- 0 abstract candidates
