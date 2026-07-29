# Frontend UI Audit — TeamInboxRow

**File:** `src/modules/MainApp/TeamInbox/components/TeamInboxRow.tsx` (131 LOC)

**Date:** 2026-07-28
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line | Element                   | Verdict          | Reason                                                                                                                                                                                                                      | Suggested change |
| ---- | ------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 74   | `<button>` listbox option | keep with reason | The row participates in a roving-tabindex `listbox`, exposes `role="option"` / `aria-selected`, and uses the shared `ListPanel` item classes. The generic Button API does not model this composite selectable-row contract. | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value | Verdict | Reason                                                         | Suggested change |
| ---- | ----- | ------- | -------------------------------------------------------------- | ---------------- |
| —    | —     | —       | No arbitrary CSS-variable or raw-color Tailwind values remain. | —                |

## D3 — Hardcoded Sizes / Colors

| Line | Value                 | Verdict          | Reason                                                                                                            | Suggested change |
| ---- | --------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------- |
| 93   | `size={14}` list icon | keep with reason | 14px is the established compact sidebar icon size and is optically aligned inside the shared 28px icon container. | —                |

## D4 — Accessibility

| Line  | Element        | Verdict          | Reason                                                                                                                                                     | Suggested change |
| ----- | -------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 74–87 | selectable row | keep with reason | The row has a computed accessible label, selected state, roving tab index, native keyboard activation, and the parent list owns Arrow/Home/End navigation. | —                |

## D5 — Visual Patterns Observed

- The row reuses `getListItemClasses` for the established selectable sidebar-row shell.
- No third independent card implementation or new abstraction candidate was found in this change.

## Summary

- 0 fixes recommended
- 2 kept with documented reason
- 0 abstract candidates
