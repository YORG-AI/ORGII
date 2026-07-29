# Frontend UI Audit — TeamInboxList

**File:** `src/modules/MainApp/TeamInbox/components/TeamInboxList.tsx` (312 LOC)

**Date:** 2026-07-28
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line | Element               | Verdict          | Reason                                                                                                           | Suggested change |
| ---- | --------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------- |
| 162  | semantic `<section>`  | keep with reason | This is structural content, not a DS button/card replacement candidate.                                          | —                |
| 50   | unread badge `<span>` | keep with reason | `TabPill` accepts arbitrary badge content and no shared badge primitive models the compact `99+` count contract. | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value | Verdict | Reason                                                     | Suggested change |
| ---- | ----- | ------- | ---------------------------------------------------------- | ---------------- |
| —    | —     | —       | No arbitrary color or CSS-variable Tailwind values appear. | —                |

## D3 — Hardcoded Sizes / Colors

| Line         | Value                    | Verdict          | Reason                                                                                  | Suggested change |
| ------------ | ------------------------ | ---------------- | --------------------------------------------------------------------------------------- | ---------------- |
| 97, 106, 115 | `size={14}` filter icons | keep with reason | This is the established mini-tab icon scale and matches the shared header action scale. | —                |

## D4 — Accessibility

| Line    | Element             | Verdict          | Reason                                                                                                                                                                    | Suggested change |
| ------- | ------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 267–272 | listbox focus model | keep with reason | The container owns Arrow/Home/End routing while actual focus remains on roving native option buttons; the conflicting `aria-activedescendant` attribute has been removed. | —                |
| 137–151 | Load more Button    | keep with reason | Shared Button supplies native keyboard activation, localized text, disabled and loading states; one shared action is rendered in both result and empty-result branches.   | —                |

## D5 — Visual Patterns Observed

- Panel header, refresh action, tabs, search, scroll area, placeholder and pagination action all reuse design-system components.
- The same memoized pagination action is reachable in populated, filter-empty and search-empty states.

## Summary

- 0 fixes recommended
- 4 kept with documented reason
- 0 abstract candidates
