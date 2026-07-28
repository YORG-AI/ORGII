# Frontend UI Audit — Runtime Page Spacing

**Scope:** the Runtime Usage, Quota, Scanning, and Hooks tab shell, section
titles, and page-level spacing. Properties / Assets content is intentionally
out of scope.

The repository-referenced `frontend-ui-audit` skill was unavailable at both
documented paths, so this report follows the fallback table convention in
`AGENTS.md`.

| Line                                                                        | Element                    | Verdict          | Reason                                                                                                                                                | Suggested change                                                                                |
| --------------------------------------------------------------------------- | -------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `src/modules/shared/dataSource/index.tsx:628`                               | Runtime tab header         | fix              | The page duplicated Settings header padding, width, and tab placement with local classes.                                                             | Use `InternalHeader` and `DETAIL_PANEL_TOKENS.headerWidth`.                                     |
| `src/modules/shared/dataSource/index.tsx:679`                               | Runtime scroll region      | fix              | The four requested pages used raw max-width, horizontal padding, and bottom padding instead of the Settings content tokens.                           | Use `DETAIL_PANEL_TOKENS.scrollContentNoTop` and `contentWidthWithPaddingNoTop`.                |
| `src/modules/shared/dataSource/index.tsx:696`                               | Scanning title             | fix              | Scanning had no Settings-style content title above its configuration and inventory parts.                                                             | Render the translated Data Sources title with `SECTION_SUBHEADING_CLASSES`.                     |
| `src/modules/shared/dataSource/SessionUsagePanel.tsx:200`                   | Usage page stack           | fix              | The page used `gap-4`, which drifted from the Settings section rhythm.                                                                                | Use `SECTION_GAP_CLASSES`.                                                                      |
| `src/modules/shared/dataSource/SessionUsagePanel.tsx:274`                   | Usage summary title        | fix              | The Usage summary had no shared subheading treatment.                                                                                                 | Pair the translated Usage & cost label with `SECTION_SUBHEADING_CLASSES`.                       |
| `src/modules/shared/dataSource/UsageTrendChart.tsx:102`                     | Usage trends title         | fix              | The title was embedded inside the chart card with one-off typography and margin.                                                                      | Move it above the card and use the shared Settings subheading and gap tokens.                   |
| `src/modules/shared/dataSource/UsageRoundsTable.tsx:258`                    | Usage sessions title       | fix              | The collapsible wrapper added its own page margin and used its default detail-panel title typography.                                                 | Keep collapse behavior, remove the wrapper margin, and apply the Settings subheading token.     |
| `src/engines/ChatPanel/StartPageQuotaGrid.tsx:169`                          | Quota page stack and title | fix              | Quota used `gap-4` and had no Settings-style content title.                                                                                           | Use the shared gap and subheading tokens while retaining the compact account-card grid.         |
| `src/modules/shared/dataSource/SessionProvenanceHooksPanel.tsx:17`          | Hooks page stack and title | fix              | Hooks used a local page gap and began directly with controls.                                                                                         | Add the translated Session Provenance subheading and use `SECTION_GAP_CLASSES`.                 |
| `src/modules/shared/dataSource/SessionProvenanceHookPlatformsTable.tsx:407` | Hook platform stack        | fix              | The platform configuration/table stack spelled out the same Settings gap locally.                                                                     | Consume `SECTION_GAP_CLASSES` directly.                                                         |
| `src/modules/shared/dataSource/SessionProvenanceRecentSignalsTable.tsx:395` | Recent signals title       | fix              | The subsection used custom 13px typography and an 8px gap instead of the shared Settings title rhythm.                                                | Use `SECTION_SUBHEADING_CLASSES` and `SECTION_GAP_CLASSES`.                                     |
| Usage and Quota sticky control rows                                         | Pinned controls            | keep with reason | Their negative inset and `bg-chat-pane` are required to cover the scroll gutter while pinned; `pb-1` is the requested compact separation.             | Keep the local sticky geometry.                                                                 |
| Quota account-card internal gaps                                            | Dense metric content       | keep with reason | The local `gap-1.5`, `gap-2`, and metric spacing describe compact card internals, not page or section spacing.                                        | Keep these density-specific values.                                                             |
| Properties / Assets branch                                                  | Separate dashboard layout  | keep with reason | The request explicitly excludes this content, and it owns an overflow-hidden dashboard layout rather than the Settings-style scrolling section stack. | Leave the branch unchanged apart from sharing the unavoidable top-level Runtime tab navigation. |

## Verdict summary

- Fix: 11
- Keep with reason: 3
- Abstract: 0
- Multi-file sweep candidates: 0

Accessibility check: the navigation remains the existing keyboard-focusable
`TabPill`; switching to `InternalHeader` changes layout only. Heading elements
remain semantic `h3` nodes, translated labels are preserved, and the pinned
refresh controls keep their labels and disabled/loading behavior.
