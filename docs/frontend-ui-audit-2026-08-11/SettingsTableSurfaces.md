# Settings table surfaces

## Scope

Audited the shared SettingsTable surface used by GitHub pull requests/issues,
workspace work items, and settings lists. The pass covers toolbar, title rows,
scrollable rows, pagination/footer chrome, horizontally frozen columns, and
their covering gradients.

## Findings

| Line                                                        | Element                          | Verdict          | Reason                                                                                                                                                                                                              | Suggested change                                                                                                                                                                                             |
| ----------------------------------------------------------- | -------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/components/Table/index.scss:167`                       | SettingsTable surface tokens     | abstract         | The shared table previously used one raised-container color for every layer, so PRs, issues, work items, and settings lists could not merge their middle region with the host pane without page-specific overrides. | Keep separate chrome and pane tokens at the shared table boundary.                                                                                                                                           |
| `src/components/Table/index.scss:218`                       | Title row and scrollable body    | fix              | The column-title row and full middle region painted `primary-container`, creating a nested card fill that differed from the surrounding chat pane.                                                                  | Paint the title row, scroller, rows, cells, empty state, and expanded rows with `--color-chat-pane`.                                                                                                         |
| `src/components/Table/index.scss:371`                       | Frozen columns and cover shades  | fix              | Horizontally pinned columns and their short gradients retained the raised fill, then the body scroller's nested stacking context trapped pinned cells below the widened cover despite their higher local z-index.   | Paint frozen cells with the chat-pane token, use the chat-event 56px `pane → pane/90 → transparent` fade, and keep the scroller in the container's stacking context so pinned cells sit above the z-2 scrim. |
| `src/components/Table/index.scss:565`                       | Pagination and add/empty footers | keep with reason | Footer controls are table chrome and should continue to bookend the raised toolbar while the title row and rows blend into the pane.                                                                                | Keep footer surfaces on `--settings-table-surface`.                                                                                                                                                          |
| `src/modules/shared/components/WorkManagementTable.tsx:386` | PR, issue, and work-item tables  | abstract         | These views already share one SettingsTable composition, so the surface correction propagates consistently without consumer-specific Tailwind selectors.                                                            | Keep work-management surfaces on the shared component; do not add page-local background overrides.                                                                                                           |

## Summary

- Fix: 2
- Keep with reason: 1
- Abstract: 2
- Remaining cross-file sweep candidates: 0

The configured `frontend-ui-audit` skill file was unavailable in both the
referenced user-global and workspace locations. This report follows the
repository's documented audit table convention and covers the shared surface
change directly.
