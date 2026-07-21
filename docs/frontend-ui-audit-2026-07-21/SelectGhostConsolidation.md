# Frontend UI Audit — Select Ghost Consolidation

**Scope:** the shared Select ghost visual contract, its custom trigger, every
explicit ghost consumer, and the aligned Runtime Usage / Quota pinned controls.

The repository-referenced `frontend-ui-audit` skill was unavailable at both
documented paths, so this report follows the fallback table convention in
`AGENTS.md`.

| Line                                                                                               | Element                     | Verdict          | Reason                                                                                                                                                                                                | Suggested change                                                                        |
| -------------------------------------------------------------------------------------------------- | --------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `src/components/Select/types.ts:73`                                                                | Select variant API          | fix              | `ghostTextOnly` made one visual variant carry two competing interaction contracts. A single `ghost` prop is easier to discover and prevents callsite drift.                                           | Keep `variant="ghost"` as the only public ghost control and remove the boolean subtype. |
| `src/components/Select/index.tsx:288`                                                              | Ghost class routing         | fix              | Conditional application of a second modifier class duplicated styling state in component logic.                                                                                                       | Route every explicit ghost Select through `select-ghost` only.                          |
| `src/components/Select/index.scss:82`                                                              | Ghost visual states         | fix              | Ghost should be transparent and borderless, with muted text at rest and primary text on hover/open. Background hover/open fills conflicted with that contract.                                        | Consolidate rest, hover, open, arrow, and suffix states in the base ghost block.        |
| `src/components/Select/SelectGhostTrigger.tsx:68`                                                  | Custom Select trigger       | keep with reason | Custom droplists still need Select-compatible dimensions without adopting Select's option panel. Reusing the shared Button plus canonical Select classes avoids a parallel raw-button implementation. | Keep the adapter and its updated text-state documentation.                              |
| `src/engines/ChatPanel/ChatPanelStartPage.tsx:316`                                                 | Create-target selector      | fix              | The former one-off `ghostTextOnly` flag is redundant after consolidation.                                                                                                                             | Use only `variant="ghost"`; retain the established large pill sizing.                   |
| `src/engines/ChatPanel/panels/CloudOrgPanelView/CloudOrgPanelHeader.tsx:175`                       | Cloud organization selector | fix              | A local font-weight override conflicted with the canonical normal-weight ghost contract.                                                                                                              | Retain only the layout-specific no-wrap override.                                       |
| `src/scaffold/NavigationSidebar/connectors/SidebarOrgSelector.tsx:98`                              | Organization selector       | fix              | Feature-level custom properties restored the old filled hover/open state and would bypass the consolidated contract.                                                                                  | Remove the custom background variables and inherit shared ghost styling.                |
| `src/modules/WorkStation/CodeEditor/Panels/EditorBottomPanel/components/BottomPanelHeader.tsx:167` | Output-channel selector     | fix              | Local Tailwind overrides duplicated the ghost background and text-state contract.                                                                                                                     | Remove the state overrides while retaining toolbar-specific dimensions.                 |
| `src/modules/shared/dataSource/SessionUsagePanel.tsx:201`                                          | Usage pinned controls       | keep with reason | TabPill's ghost color scheme, Select's ghost variant, and tertiary/ghost refresh action now share transparent supporting-control semantics while the common `min-h-9` aligns them with Quota.         | None.                                                                                   |
| `src/engines/ChatPanel/StartPageQuotaGrid.tsx:167`                                                 | Quota pinned refresh        | keep with reason | The tertiary/ghost Button matches Usage's supporting action and keeps its translated accessible label, disabled state, and loading spin behavior.                                                     | None.                                                                                   |
| All 17 explicit ghost Select callsites                                                             | Systematic consumer sweep   | keep with reason | Consumers use the shared design-system component; changing the canonical style once is preferable to adding or retaining per-feature modifiers.                                                       | Keep dimension and width overrides only where they express local layout.                |

## Verdict summary

- Fix: 7
- Keep with reason: 4
- Abstract: 0
- Multi-file sweep candidates: 0

Accessibility check: Select retains keyboard navigation, focus handling,
disabled behavior, and open-state chevron feedback. Removing background fills
does not remove the text-color state change. Both refresh controls remain native
design-system buttons; Quota retains its translated `aria-label` and title.
