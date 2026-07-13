# Frontend UI Audit — WorktreeDropdown

**File:** `src/features/SessionCreator/components/SessionInfoLine/WorktreeDropdown.tsx` (231 LOC)
**Date:** 2026-07-13
**Auditor:** ORGII implementation session

## D1 — Raw HTML vs Design System

| Line | Element                 | Verdict          | Reason                                                                                                                                                                                                                                                  | Suggested change |
| ---- | ----------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 44   | Worktree row `<button>` | keep with reason | The dropdown navigation engine supplies row-level hover, click, selected index, and keyboard props directly. This matches the neighboring WorkspaceDropdown and BranchDropdown raw-row pattern; the DS Button does not expose this listbox integration. | —                |
| 196  | Search `<input>`        | keep with reason | It is embedded in the shared `DROPDOWN_CLASSES.searchContainer` pattern and uses `searchInput` tokens plus Tauri-specific Select All behavior, matching sibling dropdowns.                                                                              | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value                         | Verdict          | Reason                                                                                                                                                                          | Suggested change |
| ---- | ----------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 63   | `text-[11px]` branch metadata | keep with reason | This exact compact metadata size is established across WorkspaceDropdown, CursorModelDropdown, and selector section labels. It is not a raw color or isolated visual invention. | —                |

## D3 — Hardcoded Sizes / Colors

| Line  | Value                                                     | Verdict          | Reason                                                                                                                       | Suggested change |
| ----- | --------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 27–29 | 360px list cap, 12px viewport margin, 320px minimum width | keep with reason | These constants intentionally mirror WorkspaceDropdown's positioning contract, keeping sibling selector geometry consistent. | —                |

## D4 — Accessibility

| Line | Element               | Verdict          | Reason                                                                                                              | Suggested change                                     |
| ---- | --------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 44   | Worktree row button   | keep with reason | Visible worktree and branch text provide an accessible name; keyboard selection is supplied by `useDropdownEngine`. | —                                                    |
| 196  | Worktree search input | fix (applied)    | Placeholder text alone is not a durable accessible name.                                                            | Added `aria-label` using the localized search label. |

## D5 — Visual Patterns Observed

- The component intentionally reuses the existing anchored selector pattern (`DROPDOWN_CLASSES`, `DROPDOWN_ITEM`, `DROPDOWN_PANEL`, `useDropdownEngine`) rather than introducing a new dropdown implementation.
- No new repeated visual pattern reaches the >=3 independent implementation threshold; the relevant pattern is already abstracted by shared dropdown tokens and hooks.

## Summary

- 1 fix recommended and applied
- 5 findings kept with documented reason
- 0 abstract candidates
