# Frontend UI Audit — Settings Surfaces

Scope: shared `SectionContainer`, direct `SECTION_CONTAINER_CLASSES` consumers, `SectionRow`, and default `SettingsTable` surfaces.

The repository-referenced `frontend-ui-audit` skill is not installed in either documented location. This report follows the required table convention and manually checks shared-token usage, surface variants, radius consistency, sticky behavior, and sweep coverage.

| Line                             | Element                           | Verdict          | Reason                                                                                                                                                      | Suggested change                                                                                     |
| -------------------------------- | --------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `SectionLayout/tokens.ts:64`     | Container radius                  | fix              | Shared structured containers used an 8px radius while settings tables used 12px, creating inconsistent geometry.                                            | Use the canonical 12px radius for shared settings surfaces.                                          |
| `SectionLayout/tokens.ts:67`     | Default container fill            | keep with reason | The surface color separates grouped settings from the page and was preferred after testing the unfilled treatment.                                          | Keep the default `surface-container` fill.                                                           |
| `SectionLayout/tokens.ts:74`     | Direct token consumers            | fix              | `Section`, collapsible sections, and workflow cards bypass `SectionContainer`, so changing only the component would leave them borderless and inconsistent. | Include the canonical `border-border-1` treatment in `SECTION_CONTAINER_CLASSES`.                    |
| `SectionLayout/Container.tsx:52` | Explicit color variants           | keep with reason | `chatPanelInfo` is an intentional semantic surface outside the default settings-page treatment.                                                             | Preserve explicitly requested color variants.                                                        |
| `SectionLayout/Row.tsx:82`       | Settings row spacing              | fix              | Standard rows used `py-2`, which made labels and controls feel cramped.                                                                                     | Increase standard rows to `py-3`; preserve compact rows at `py-1.5`.                                 |
| `SectionLayout/tokens.ts:64`     | Row separators                    | fix              | One-off borders produced inconsistent grouping.                                                                                                             | Generate shared full-width separators between direct `SectionRow` siblings without extra line inset. |
| `SettingsTable/index.tsx:546`    | Default table surface             | keep with reason | Sticky headers and scrolling rows need an opaque shared surface, and the colored settings surface was preferred visually.                                   | Keep `surface-container` for the default table variant.                                              |
| `SettingsTable/index.tsx:565`    | Table radius                      | keep with reason | The existing 12px table radius is the balanced shared value and matches the settings container and side-border mask.                                        | Keep the canonical radius at 12px.                                                                   |
| `Table/index.scss:562`           | Sticky side-border mask           | keep with reason | The 12px mask matches the canonical radius and prevents the root border from protruding above the sticky curve.                                             | Keep the mask synchronized with the radius.                                                          |
| `SettingsTable` variants         | Transparent and chat-panel tables | keep with reason | Transparent and chat-panel variants carry deliberate semantics outside the default settings surface.                                                        | Keep variant-specific behavior unchanged.                                                            |

## Summary

- fix: 4
- keep with reason: 6
- abstract: 0
- sweep candidates: none; all canonical container, row, and table token paths were covered.
