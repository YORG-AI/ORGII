# Frontend UI Audit — Keyboard Operability

**Files:** seven visible control sites listed below
**Date:** 2026-08-08
**Auditor:** Codex follow-up on `junyu/fix-a11y-keyboard-controls`

The D4 sweep found seven mouse-only controls. All reuse native button semantics or the existing `createKeyboardActivationHandler`; no new shared UI abstraction was needed.

## D1 — Raw HTML vs Design System

| Line                             | Element                         | Verdict          | Reason                                                                                                                                                | Suggested change |
| -------------------------------- | ------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `DateRangeSelector/index.tsx:95` | native date trigger `<button>`  | keep with reason | This DS-internal compound trigger owns a third-party range picker and has no covering DS button shape.                                                | —                |
| `SearchInput/index.tsx:213`      | native chevron `<button>`       | keep with reason | Icon-only disclosure lives inside the DS component and reuses its compact header-control sizing.                                                      | —                |
| `DebugJsonViewer/index.tsx:110`  | interactive tree-row `<div>`    | keep with reason | A JSON tree row has key/value layout and is interactive only for expandable values; a generic DS button does not cover the tree-row shape.            | —                |
| `GitHubDiff/DiffRow.tsx:238`     | collapsed diff-row `<div>`      | keep with reason | The diff engine uses a specialized full-width row/gutter layout; DS Button cannot host it.                                                            | —                |
| `ListPanelSidebar/index.tsx:153` | selectable list-row `<div>`     | keep with reason | The row may contain a separately interactive Checkbox, so a native outer button would create invalid nested controls.                                 | —                |
| `CollapseRow.tsx:33`             | split-diff collapse-row `<div>` | keep with reason | The control spans left pane, center gutter, and right pane; DS Button cannot represent this grid.                                                     | —                |
| `BrowseCard.tsx:88`              | stretched sibling `<button>`    | keep with reason | The absolute overlay is the primary card hit area while the action button remains a non-nested sibling; DS Button does not cover a stretched overlay. | —                |

## D2 — Arbitrary Tailwind Value vs Token

No new arbitrary CSS-variable or raw-color classes were added. All new focus treatment uses existing `ring-primary-6/30`, `outline-none`, and layout tokens.

## D3 — Hardcoded Sizes / Colors

No new hardcoded pixel sizes or raw colors were added. Existing `text-[14px]`, `rounded-[8px]`, and similar values in the touched components predate this accessibility change and were not expanded.

## D4 — Accessibility

| Line                             | Element                                   | Verdict | Reason                                                                                              | Suggested change                                                                                                             |
| -------------------------------- | ----------------------------------------- | ------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `CollapseRow.tsx:33`             | collapsed split-diff row                  | fix     | Mouse-only expansion had no focus stop, keyboard path, name, or expanded state.                     | Added `role="button"`, `tabIndex`, Enter/Space, `aria-expanded`, an explicit label, and focus-visible outline.               |
| `GitHubDiff/DiffRow.tsx:238`     | collapsed unchanged-lines row             | fix     | Mouse-only show/hide control.                                                                       | Added button role, `tabIndex`, Enter/Space, `aria-expanded`, and focus-visible outline; visible text supplies the name.      |
| `DebugJsonViewer/index.tsx:110`  | expandable JSON node row                  | fix     | Expandable nodes had only click activation; primitive rows carried a no-op handler.                 | Interactive props and click/keyboard handlers are now conditional on expandability; primitive rows stay fully inert.         |
| `SearchInput/index.tsx:213`      | replace-row chevron                       | fix     | Non-semantic icon click target had no accessible name or state.                                     | Promoted to native button with localized label/title, `aria-expanded`, and focus ring.                                       |
| `DateRangeSelector/index.tsx:95` | date-range trigger                        | fix     | Non-semantic trigger had no keyboard activation or expanded state.                                  | Promoted to native button with `aria-expanded`; visible date text supplies the name.                                         |
| `ListPanelSidebar/index.tsx:153` | default list item                         | fix     | Row selection was mouse-only.                                                                       | Added button role, `tabIndex`, Enter/Space, and inset focus ring while preserving the child Checkbox path.                   |
| `BrowseCard.tsx:88`              | card primary action with secondary action | fix     | The action-button branch made the primary card action mouse-only; nesting buttons would be invalid. | Added a named stretched sibling button and lifted the secondary action above it; both branches have focus-visible treatment. |

## D5 — Visual Patterns Observed

- Collapsed unchanged-lines row: `CollapseRow.tsx` and `DiffRow.tsx` — two occurrences, below the three-site abstraction threshold.
- Focus-visible treatment consistently uses the existing primary ring token; no new visual primitive is needed.

## Next-refactor candidates

- Per-line diff selection needs a container-level roving-tabindex/grid design; adding hundreds of individual tab stops would be worse.
- The custom-render branch of `ListPanelSidebar` needs a caller-aware keyboard contract and remains outside this focused batch.

## Summary

- 7 accessibility fixes
- 7 raw-element decisions kept with documented design-system reasons
- 0 arbitrary-token or new hardcoded-size findings
- 0 abstraction candidates
