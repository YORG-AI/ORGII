# Code Map Removal Frontend UI Audit

The documented `frontend-ui-audit` skill file was unavailable, so this report uses the output columns and verdict discipline required by `AGENTS.md`.

| Line    | Element                                                                          | Verdict          | Reason                                                                                                                                         | Suggested change                                                                               |
| ------- | -------------------------------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Deleted | Code Map status, search, explore, relationship, and node-detail component family | fix              | These components existed only for the removed feature and retaining them would leave dead design-system and accessibility surface.             | Deleted the complete component family and its hooks/API.                                       |
| Deleted | `ManageCodeMapBlock` chat renderer                                               | fix              | The agent tools and wire events no longer exist, so a special renderer would be unreachable and misleading.                                    | Deleted the block and its fallback-adapter branch.                                             |
| 39      | `WorkspaceOverviewBody`                                                          | keep with reason | `WorkspaceToolsReadiness` remains useful for both repositories and plain folders and already uses the established launchpad component pattern. | Keep as the sole overview readiness surface.                                                   |
| 94      | Workspace overview path resolution                                               | fix              | The previous comment and layout rationale were coupled to Code Map folder indexing.                                                            | Retained the generic repo/folder path fallback and rewrote the comment around tools readiness. |
| 32, 176 | Deferred service list and mount                                                  | fix              | The headless auto-index scheduler was a hidden frontend entry point into the removed backend.                                                  | Removed the lazy import, documentation entry, and mounted provider.                            |
| 99–170  | `FallbackAdapter` routing                                                        | fix              | A removed tool name must not keep a bespoke UI route. The generic fallback remains for historical/unknown tools.                               | Removed only the Code Map route; preserved all other adapter branches.                         |

## Verdict summary

- fix: 5
- keep with reason: 1
- abstract: 0

## Consistency and accessibility notes

- No new component, arbitrary Tailwind value, interaction pattern, icon, focus behavior, or ARIA contract was introduced.
- Deleting the feature-specific controls removes their buttons and live status announcements together; there is no orphaned keyboard or screen-reader action.
- The remaining overview uses the existing `WorkspaceToolsReadiness`, `TabPill`, `PanelFooter`, and layout-token components.

## Verification

- TypeScript compilation passes.
- ESLint passes for every surviving changed TypeScript/TSX file.
- Prettier passes for surviving changed frontend files and locale JSON.
- All 14 focused `FallbackAdapter` tests pass.
