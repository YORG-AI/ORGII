# Frontend UI Audit — TabBarPlusMenu

**Files:**

- `src/modules/WorkStation/AppShell/TabBarPlusMenu/TabBarPlusMenu.tsx` (156 LOC)
- `src/modules/WorkStation/AppShell/TabBarPlusMenu/TabBarPlusMenuItems.tsx` (49 LOC)

**Date:** 2026-07-20
**Auditor:** ORGII agent session

## D1 — Raw HTML vs Design System

| Line                            | Element                                 | Verdict          | Reason                                                                                                                                                                                                                                                                                                                                                                   | Suggested change |
| ------------------------------- | --------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| `TabBarPlusMenuItems.tsx:32–45` | raw `<button>` menu action              | keep with reason | The button uses the canonical `DROPDOWN_CLASSES.menuActionItem` contract. A repository sweep found the same raw menu-item pattern in Session Creator, WorkStation status/source-control menus, Navigation Sidebar, and Work Management. Replacing only this site with a generic `Button` would break local consistency and may alter dropdown keyboard/layout semantics. | —                |
| `TabBarPlusMenu.tsx:128–151`    | `Dropdown` + `TabBarTrailingIconButton` | keep with reason | Trigger and popup behavior use existing design-system components rather than custom raw interactive wrappers.                                                                                                                                                                                                                                                            | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line                         | Value                                 | Verdict          | Reason                                                                                                                  | Suggested change |
| ---------------------------- | ------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `TabBarPlusMenu.tsx:114–124` | `DROPDOWN_CLASSES`, `DROPDOWN_WIDTHS` | keep with reason | Panel layout and width come from shared dropdown tokens; no arbitrary CSS-variable or literal color utility is present. | —                |
| `TabBarPlusMenuItems.tsx:36` | `DROPDOWN_CLASSES.menuActionItem`     | keep with reason | Menu action styling is centrally tokenized and shared across the repository.                                            | —                |

## D3 — Hardcoded Sizes / Colors

| Line                                                      | Value                    | Verdict          | Reason                                                                  | Suggested change |
| --------------------------------------------------------- | ------------------------ | ---------------- | ----------------------------------------------------------------------- | ---------------- |
| `TabBarPlusMenu.tsx:148`, `TabBarPlusMenuItems.tsx:17–21` | `HEADER_ICON_SIZE.md/sm` | keep with reason | Icon sizes use the workstation token source rather than pixel literals. | —                |
| `TabBarPlusMenuItems.tsx:38`                              | `gap-2`                  | keep with reason | Uses the standard Tailwind spacing scale.                               | —                |

## D4 — Accessibility

| Line                            | Element             | Verdict          | Reason                                                                                                                                                                         | Suggested change |
| ------------------------------- | ------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| `TabBarPlusMenuItems.tsx:32–45` | menu action buttons | keep with reason | Every item is a semantic `button` with visible translated label text, so it has keyboard activation and an accessible name. Icons are supplemental rather than the sole label. | —                |
| `TabBarPlusMenu.tsx:141–149`    | plus-menu trigger   | keep with reason | The existing `TabBarTrailingIconButton` receives the translated `title` and shortcut metadata; the refactor preserved this contract.                                           | —                |

## D5 — Visual Patterns Observed

- Raw buttons styled with `DROPDOWN_CLASSES.menuActionItem` are an established cross-repository dropdown-row pattern (more than three sites).
- This is already centralized at the token/class-contract level. Promoting it to another component would require a separate repository-wide migration and keyboard/menu-role API review; it is not appropriate as an inline fix in this structural refactor.

## Summary

- 0 fixes recommended
- 8 kept with documented reason
- 0 immediate abstract candidates
- 1 repository-wide watch item: consider a typed dropdown action-row primitive only as a dedicated global sweep, not a single-site replacement
