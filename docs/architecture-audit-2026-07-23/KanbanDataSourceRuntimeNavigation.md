# Architecture Audit — Kanban Data Sources to Runtime

**Scope:** Kanban Data Sources navigation, Runtime tab activation, Runtime data-source composition, and removal of the retired Kanban-hosted path.

## Acceptance criteria

- [x] Kanban exposes Data Sources as navigation, not as a local view mode.
- [x] The hover affordance uses `ArrowUpRight` to the right of the label without changing tab width.
- [x] Activation goes through the canonical singleton Runtime-tab atom.
- [x] Runtime is the only production host that composes the data-source panel.
- [x] No retired Kanban render branch, header branch, lazy import, view union member, or multi-host panel prop remains.
- [x] Focused lint and tests pass.
- [ ] Full TypeScript compilation is green; unchanged generic errors remain in `VirtualizedGroupedList/model.test.ts` and `WorkItemsListContent/index.tsx`.

## Ten-layer review

|                                     Layer | Coverage                                                                                                                                                                                                                                                        | Verdict        |
| ----------------------------------------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
|                1. Compilation correctness | ESLint passed for every changed TypeScript file. Seven focused tests passed. Full `tsc --noEmit` reaches only the three unrelated existing WorkItems generic errors listed above.                                                                               | scoped pass    |
| 2. Dead code and structural deduplication | Traced Kanban header → Runtime opener → tab registry → Runtime renderer → `RuntimeDataSourcePanel`. Removed the parallel Kanban content path plus controlled-view, hidden-header, optional-section, and scrollbar APIs that had no remaining production caller. | pass           |
|                     3. Naming consistency | The non-view key is `runtime-data-sources`; the canonical panel and section types are Runtime-named; the hover glyph is `ArrowUpRight`. `datasource` remains only in the stale-URL regression test.                                                             | pass           |
|                   4. Semantic overloading | `FactoryViewMode` contains only actual Kanban views. The Runtime navigation item is no longer representable as a local `datasource` view.                                                                                                                       | pass           |
|                       5. Default branches | Unknown or stale URL values intentionally resolve to Kanban. Runtime sections are an explicit closed union with no optional section branches.                                                                                                                   | pass           |
|                   6. Cross-domain leakage | Kanban imports only the Runtime tab opener. ChatPanel owns Runtime composition; the data-source module receives quota/assets content without importing ChatPanel panels.                                                                                        | pass           |
|                  7. New-developer clarity | The component comments, types, navigation key, and tests now describe one Runtime owner and one Kanban link. No former dual-host comments remain in production source.                                                                                          | pass           |
|                          8. Wire protocol | No command payload, persistence schema, serialization, or network boundary changed.                                                                                                                                                                             | not applicable |
|                  9. Initialization parity | Kanban and the ChatPanel new-tab menu both converge on `openRuntimeInChatPanelTabAtom`, which focuses the existing singleton or creates it once.                                                                                                                | pass           |
|                     10. Resolver symmetry | No multi-source resolver or fallback chain changed.                                                                                                                                                                                                             | not applicable |

## Live call chain

`FactoryViewPill` → `openRuntimeInChatPanelTabAtom` → `activateChatPanelTabAtom` or `appendAndActivateChatPanelTabAtom` → `RuntimeSurfaceRenderer` → `RuntimePanelView` → `RuntimeDataSourcePanel`.

The systematic sweep found one production `RuntimeDataSourcePanel` caller and zero production Task Kanban imports or branches for the panel.
