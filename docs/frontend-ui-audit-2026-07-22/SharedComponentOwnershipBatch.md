# Frontend UI Audit — Shared Component Ownership Batch

**Files:** `src/components/Placeholder.tsx`, `src/components/SearchSortBar.tsx`, `src/components/FolderHeaderRow.tsx`, `src/components/ListPanel/ListPanelScrollArea.tsx`, `src/components/ListPanel/ListPanelTabPillRow.tsx`, `src/components/ListPanel/MenuPanel.tsx`
**Date:** 2026-07-22
**Auditor:** ORGII agent session

## D1 — Raw HTML vs Design System

| Line                          | Element                                   | Verdict          | Reason                                                                                                                                                                                 | Suggested change |
| ----------------------------- | ----------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `FolderHeaderRow.tsx:32`      | Collapsible full-row `<button>`           | keep with reason | The row is a compound chevron/name/branch/badge layout and uses the workstation row token contract; wrapping it in the generic Button would add incompatible button chrome and sizing. | —                |
| `ListPanel/MenuPanel.tsx:93`  | Full-width navigation `<button>`          | keep with reason | This is a list-navigation row driven by `getListItemClasses`; generic Button does not model selected navigation-row layout.                                                            | —                |
| `Placeholder.tsx:145,174`     | Design-system `Button`                    | keep with reason | Action rendering already uses the shared Button component.                                                                                                                             | —                |
| `SearchSortBar.tsx:68,96,114` | Design-system `Button`, `Input`, `Select` | keep with reason | Existing design-system controls cover all interactive behavior.                                                                                                                        | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value                                                                                      | Verdict          | Reason                                          | Suggested change |
| ---- | ------------------------------------------------------------------------------------------ | ---------------- | ----------------------------------------------- | ---------------- |
| —    | No raw CSS-variable, hex, RGB, HSL, or arbitrary color classes in the relocated primitives | keep with reason | Color usage is through project Tailwind tokens. | —                |

## D3 — Hardcoded Sizes / Colors

| Line                           | Value                   | Verdict          | Reason                                                                                                        | Suggested change             |
| ------------------------------ | ----------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `FolderHeaderRow.tsx:46`       | `h-[16px] min-w-[16px]` | fix              | Exact spacing-scale equivalents exist.                                                                        | Replaced with `h-4 min-w-4`. |
| `FolderHeaderRow.tsx:34,36,41` | 14px/11px icon sizes    | keep with reason | These are icon optical sizes aligned with existing workstation tokens and fall under micro-adjustment sizing. | —                            |
| `SearchSortBar.tsx:47`         | Default `w-[180px]`     | keep with reason | This is an overridable API default for a select column and has no exact Tailwind spacing-scale equivalent.    | —                            |
| `SearchSortBar.tsx:131`        | `text-[13px]`           | keep with reason | Matches the established workstation compact typography scale used by the shared token set.                    | —                            |

## D4 — Accessibility

| Line                         | Element                 | Verdict          | Reason                                                                               | Suggested change |
| ---------------------------- | ----------------------- | ---------------- | ------------------------------------------------------------------------------------ | ---------------- |
| `FolderHeaderRow.tsx:32`     | Toggle button           | keep with reason | Semantic button has visible `name` text as its accessible name.                      | —                |
| `ListPanel/MenuPanel.tsx:93` | Navigation button       | keep with reason | Semantic button has visible item label and keyboard behavior.                        | —                |
| `SearchSortBar.tsx:68`       | Icon-only filter Button | keep with reason | `title` supplies the translated accessible label through the shared Button contract. | —                |

## D5 — Visual Patterns Observed

- Collapsible folder/worktree header is centralized in `FolderHeaderRow`; no new duplicate implementation was introduced.
- List-panel tab header and scroll area are now canonical `src/components/ListPanel` primitives; old module paths only re-export them.
- Empty/loading/error presentation is centralized in `Placeholder`; old module paths only re-export it.

## Summary

- 1 fix applied
- 9 findings kept with documented reason
- 0 new abstraction candidates
