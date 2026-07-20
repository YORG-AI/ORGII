# Frontend UI Audit — DataSourcePanel

**File:** `src/features/TaskKanban/components/DataSourcePanel/index.tsx` (632 LOC)  
**Date:** 2026-07-15  
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line    | Element            | Verdict          | Reason                                                                                                                                                  | Suggested change |
| ------- | ------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 437–536 | Qoder row controls | keep with reason | The descriptor-driven Qoder row reuses design-system `Switch`, `Select`, `Button`, `Dropdown`, `Menu`, and `Tag`; no raw interactive control was added. | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value           | Verdict          | Reason                                                                                                                                           | Suggested change |
| ---- | --------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| 543  | `max-w-[932px]` | keep with reason | Existing panel content bound aligns the inventory table with the surrounding Kanban settings layout; Qoder adds no new arbitrary Tailwind value. | —                |

## D3 — Hardcoded Sizes / Colors

| Line | Value                          | Verdict          | Reason                                                                                                                                                      | Suggested change |
| ---- | ------------------------------ | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 459  | frequency selector width `120` | keep with reason | Existing fixed width stabilizes the compact actions column for every provider; Qoder consumes the same control and introduces no provider-specific styling. | —                |

## D4 — Accessibility

| Line    | Element                                | Verdict          | Reason                                                                                                                                 | Suggested change |
| ------- | -------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 438–536 | enable, frequency, and rescan controls | keep with reason | Shared controls retain keyboard behavior; the switch/select have accessible labels and icon-only rescan buttons have localized titles. | —                |

## D5 — Visual Patterns Observed

- Qoder is rendered by the same descriptor-driven source-row pattern as every imported-history provider; no third visual implementation or provider-specific branch was introduced.

## Summary

- 0 fixes recommended
- 4 kept with documented reason
- 0 abstract candidates
