# TypeScript Large-File Residual Inventory

**Date:** 2026-07-20
**Scope:** production `.ts` / `.tsx` under `src/` and `packages/`

## Method

This inventory excludes declarations, tests, generated/vendor code, snapshots, fixtures, presets, and pure data catalogs. LOC is a discovery signal only; each verdict also considers responsibility count, side effects, runtime risk, existing module boundaries, tests, and current working-tree conflicts.

Verdicts:

- **split** — multiple independently changing responsibilities have a defensible boundary.
- **keep cohesive** — large but single-purpose, algorithmic, registry-like, or already decomposed.
- **defer dirty/high-risk** — valuable candidate, but current uncommitted work or lifecycle sensitivity makes this batch unsafe.
- **completed** — selected coordinator has been reduced and its extracted modules are independently testable.

## Residual inventory

| Rank | File                                                                                                                               |  LOC | Classification                   | Verdict               | Reason / next boundary                                                                                                                                                                                                                            |
| ---: | ---------------------------------------------------------------------------------------------------------------------------------- | ---: | -------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|    1 | `src/modules/MainApp/WorkManagement/GitHubWorkItemsSurface.tsx`                                                                    |  464 | page orchestration               | completed             | Reduced from 2356 LOC across nine phases. Residual coordinator composes stable controllers with pagination/virtualizer DOM coordination and shell JSX; further splitting would primarily create prop relay without independent behavior.          |
|    2 | `src/features/SessionCreator/variants/ChatPanel/index.tsx`                                                                         | 1115 | session-creation orchestrator    | split                 | Extract launch controller/derived state first, then modal and body sections. Preserve login, region, worktree, and session-launch invariants.                                                                                                     |
|    3 | `src/features/SessionCreator/components/WorktreeSourceModal.tsx`                                                                   |  565 | multi-source modal               | completed             | Reduced from 967 LOC across four phases. All source-specific tabs and shared rows have explicit owners; residual coordinator owns data derivation, cross-tab fallback/selection, PR resolution, confirm sequencing, and modal shell.              |
|    4 | `src/modules/ProjectManager/ProjectManagerLayout/components/ProjectWorkItemsTabContent.tsx`                                        |  765 | project work-items container     | split                 | Separate routing/selection state from toolbar, list, and detail composition.                                                                                                                                                                      |
|    5 | `src/modules/WorkStation/CodeEditor/SessionReplay/index.tsx`                                                                       |  506 | replay orchestrator              | defer dirty/high-risk | Currently modified. Future work must preserve automatic-vs-user selection, replay tab identity, and event dispatch ordering.                                                                                                                      |
|    6 | `src/modules/WorkStation/CodeEditor/SessionReplay/FileSidebar.tsx`                                                                 |  498 | replay sidebar                   | defer dirty/high-risk | Currently modified and coupled to the same SessionReplay change set.                                                                                                                                                                              |
|    7 | `src/modules/WorkStation/Chat/Communication/index.tsx`                                                                             |  306 | communication replay coordinator | completed             | Reduced from 457 LOC; pure message selection, plan-scoped intent, Canvas loading, and typography/viewer framing now have explicit one-way boundaries.                                                                                             |
|    8 | `.archive/src/modules/WorkStation/Browser/Panels/BrowserMainPane/content/TokenManagerContent/index.tsx`                            |  451 | archived token-management view   | excluded              | Moved to `.archive` on the latest `develop` baseline; the earlier active-code split is intentionally excluded from this PR.                                                                                                                       |
|    9 | `src/modules/MainApp/AgentOrgs/index.tsx`                                                                                          |  336 | workflow dashboard coordinator   | completed             | Reduced from 447 LOC; route derivation, installed-CLI and org-directory lifecycles, table routing, and wizard routing now have explicit owners. RPC mutations and user feedback remain centralized in the coordinator.                            |
|   10 | `src/modules/MainApp/Integrations/KeyVault/Accounts/Table/AccountInlineExpandedCard.tsx`                                           |  447 | expanded account editor          | defer dirty/high-risk | Adjacent `AccountInlineActionsBar.tsx` is currently modified; defer the whole strongly-coupled account card cluster.                                                                                                                              |
|   11 | `src/modules/ProjectManager/WorkItems/components/WorkItemsPageHeader/index.tsx`                                                    |   80 | page-header coordinator          | completed             | Reduced from 444 LOC; add-menu behavior, header composition, pure visibility rules, and public types now have explicit owners. Removed three ignored props and moved status-count types out of the UI layer.                                      |
|   12 | `src/modules/WorkStation/shared/DiffFileSection/index.tsx`                                                                         |  439 | diff presentation                | keep cohesive         | Third-party/diff rendering constraints dominate. Revisit only with behavior-focused tests and measured UI need, not LOC alone.                                                                                                                    |
|   13 | `src/modules/WorkStation/CodeEditor/SessionReplay/CodePanel/index.tsx`                                                             |  436 | replay content router            | defer high-risk       | File/terminal/tool/explore switching belongs to the replay lifecycle; split only in a dedicated SessionReplay phase.                                                                                                                              |
|   14 | `src/modules/MainApp/Integrations/KeyVault/CliClients/Table/CliClientInlineExpandedCard.tsx`                                       |  167 | expanded CLI-client coordinator  | completed             | Reduced from 340 LOC; pure tab/action availability, status content, subscription content, and public types now have explicit owners while the original module preserves its exports.                                                              |
|   15 | `src/modules/MainApp/Integrations/BuiltInTools/Table/BuiltInToolsTable.tsx`                                                        |  330 | table surface                    | keep cohesive         | Table-specific model/rendering remains one discoverable owner; no evidence that physical splitting lowers complexity.                                                                                                                             |
|   16 | `src/modules/WorkStation/TabContent/registry.ts`                                                                                   |  330 | exhaustive lazy registry         | keep cohesive         | Single responsibility, no I/O/subscriptions, implementations already live in `renderers/`, and `Record<WorkStationTabType, RendererEntry>` provides compile-time exhaustiveness. Compatibility aliases are live union members, not dead defaults. |
|   17 | `src/modules/ProjectManager/ProjectManagerLayout/index.tsx`                                                                        |  299 | layout orchestrator              | split                 | Separate shortcut/event bridges and derived routing from shell composition in a dedicated ProjectManager batch.                                                                                                                                   |
|   18 | `src/modules/MainApp/Settings/index.tsx`                                                                                           |   72 | settings route/page coordinator  | completed             | Reduced from 298 LOC; canonical route derivation, monitor toolbar effects, and main-content composition now have explicit owners. Removed the unreachable GUI/JSON view branch and its orphaned 209-LOC editor component.                         |
|   19 | `src/modules/ProjectManager/WorkItems/components/WorkItemDetailPage/index.tsx`                                                     |   15 | detail page dispatcher           | completed             | Reduced from 297 LOC; project-scoped and standalone data sources are separate pages with a shared pure update/navigation model. Removed two unread action refs and fixed project-scoped previous/next navigation to update the rendered item.     |
|   20 | `src/modules/MainApp/Integrations/Skills/Table/FindSkillsSection.tsx`                                                              |   69 | skills discovery coordinator     | completed             | Reduced from 262 LOC; Tauri/file-preview service, async search/preview state, and results-table rendering now have explicit owners.                                                                                                               |
|   21 | `src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/content/SourceControlContent/utils/virtualizedTreeUtils.ts`        |  262 | tree algorithm                   | keep cohesive         | Pure algorithmic owner; splitting would scatter traversal invariants.                                                                                                                                                                             |
|   22 | `src/modules/WorkStation/Browser/Panels/BrowserSecondaryPanel/components/WebDevTools/components/DOMTreeContent/index.tsx`          |   78 | DOM-tree state coordinator       | completed             | Reduced from 257 LOC; reveal polling, list rendering, and virtualization threshold now have explicit owners. Removed the unused `getParentXpaths` export and render-phase ref writes.                                                             |
|   23 | `src/modules/WorkStation/Browser/Panels/BrowserSecondaryPanel/components/WebDevTools/components/DesignPanel/LinkedInputPair.tsx`   |  222 | local form primitive             | keep cohesive         | One focused interaction primitive with coupled input behavior.                                                                                                                                                                                    |
|   24 | `src/modules/ProjectManager/WorkItems/components/WorkItemsListContent/index.tsx`                                                   |  213 | list content                     | keep cohesive         | Moderate-sized list owner; only split when row/empty/pagination logic demonstrably diverges.                                                                                                                                                      |
|   25 | `src/modules/WorkStation/Browser/Panels/BrowserSecondaryPanel/components/WebDevTools/components/DOMTreeContent/DOMTreeNodeRow.tsx` |  194 | tree row primitive               | keep cohesive         | Focused leaf component despite its size.                                                                                                                                                                                                          |
|   26 | `src/modules/WorkStation/Chat/Communication/AgentEventBubbles.tsx`                                                                 |  193 | event-bubble coordinator         | completed             | Reduced from 368 LOC; pure event/title/card derivation now lives in `AgentEventBubbles/model.ts`.                                                                                                                                                 |
|   27 | `src/modules/MainApp/ToolPreview/mockData/commandPreviewOverrides.ts`                                                              |  228 | command preview catalog          | keep cohesive         | Data catalog extracted from the facade; one semantic owner for command-specific args/results.                                                                                                                                                     |
|   28 | `src/modules/MainApp/ToolPreview/mockData/index.ts`                                                                                |  165 | mock-data facade/builders        | completed             | Reduced from 457 LOC; retains public facade, builders, and dev sync check while the catalog lives separately.                                                                                                                                     |
|   29 | `src/modules/WorkStation/AppShell/TabBarPlusMenu/TabBarPlusMenu.tsx`                                                               |  156 | menu coordinator                 | completed             | Reduced from 289 LOC; pure model and leaf rows are separate, with one action-dispatch owner.                                                                                                                                                      |
|   30 | `packages/orgtrack/src/index.ts`                                                                                                   |   93 | package domain model             | keep cohesive         | Small package-level model/API surface; no large-file issue remains.                                                                                                                                                                               |

## Selected-batch dependency boundaries

### Agent event bubbles

`SessionEvent/types → AgentEventBubbles/model → AgentEventBubbles coordinator → MessageBubbleRenderer`

- Public API remains at the original `AgentEventBubbles.tsx` path.
- Unknown task actions preserve the previous subject-only fallback.
- Missing list/get payloads are covered by pure-model tests.

### Tab bar plus menu

`menuModel → TabBarPlusMenuItems → TabBarPlusMenu coordinator → useWorkstationTrailingSlot`

- Model has no React/Jotai imports.
- Runtime-unknown menu values are filtered without reordering or mutating input.
- Only the coordinator owns navigation, store writes, focus, and close timing.

### Communication replay

`messageViewModel + planPreviewView → usePlanReplayIntent → Communication coordinator → Canvas/message-content leaves`

- `messageViewModel.ts` performs exhaustive `MessageViewMode` bucket selection and stable timestamp/order sorting without React state.
- `usePlanReplayIntent.ts` is the single owner of per-plan user overrides; it reuses the existing pure plan derivation rather than duplicating defaults.
- The coordinator remains the sole owner of Jotai state, plan actions, message-click navigation, text-selection side effects, and org-run polling.
- Leaf components do not import the coordinator or own action dispatch.

### Settings page

`settingsRouteModel → useSettingsRouteState + useSettingsMonitorToolbar → Settings coordinator → SettingsMainContent`

- `settingsRouteModel.ts` is the single pure owner of section/tab/subpage resolution and legacy URL canonicalization.
- The route hook owns React Router navigation; the monitor hook exclusively owns refresh cooldown and toolbar publication.
- The coordinator now composes translated tab metadata and the lazy editor-appearance subpage without carrying route parsing or toolbar state.
- The unreachable JSON view branch was deleted together with `SettingsJsonEditor.tsx`; it had no production caller because the local view mode was permanently `"gui"` and its setter was unused.

### Find Skills

`service → useFindSkills → FindSkillsResults → FindSkillsSection coordinator → SkillsTable`

- `service.ts` is the only owner of Tauri search/detail calls, preview cache writes, and safe path derivation.
- `useFindSkills.ts` owns search and preview episode state, including the single-preview gate and error reset semantics.
- `FindSkillsResults.tsx` owns table columns and semantic form submission; preview-button propagation is stopped on the button itself rather than a non-semantic clickable wrapper.
- The coordinator now owns only expansion state, error presentation, and composition.

### Work Item detail page

`model → project-scoped/standalone data-source pages → WorkItemDetailPage dispatcher → ProjectManagerContentRouter`

- `model.ts` owns list navigation bounds and standalone frontmatter patching without React or API side effects.
- `ProjectScopedWorkItemDetailPage.tsx` owns `useWorkItems` integration and now keeps a local active ID, so previous/next actions change the rendered detail instead of only mutating an unused selection.
- `StandaloneWorkItemDetailPage.tsx` exclusively owns standalone read/write conversion and reload behavior.
- Two `WorkItemDetailActions` refs and registration callbacks were removed because neither page ever read the registered actions; embedded detail remains the live external-actions consumer.

### DOM tree content

`utils → useDOMTreeReveal → DOMTreeList → DOMTreeContent coordinator → WebDevTools`

- `utils.ts` owns visible-tree flattening, xpath lookup, and the virtualization threshold with pure tests.
- `useDOMTreeReveal.ts` owns the reveal episode, native/virtualized scroll adapters, and bounded polling; it no longer writes refs during render.
- `DOMTreeList.tsx` owns row projection and the Virtuoso/native rendering choice while the coordinator owns only status surfaces and flattened-data derivation.
- The unused `getParentXpaths` helper was removed after a repository-wide caller sweep found no production or test consumer.

### Work Items page header

`WorkItems/types + header model → AddActionsButton + WorkItemsHeaderContent → WorkItemsPageHeader coordinator → project/linear surfaces`

- `model.ts` owns status-filter and collapse-all visibility rules with exhaustive tab-boundary tests.
- `AddActionsButton.tsx` exclusively owns single-action fallback and dual-action dropdown behavior; `WorkItemsHeaderContent.tsx` owns toolbar grouping and status/property controls.
- The coordinator owns only translated breadcrumb fallback, refresh-spin integration, header publication, and inline shell rendering.
- `onOpenProjects`, `onTabChange`, and `visibleTabs` were removed from the header contract and callers after repository-wide inspection confirmed the component always ignored them; live tab switching remains in caller-supplied `leadingControls`.
- `StatusCounts` moved to the WorkItems domain types so `workItemsViewModel.ts` no longer imports a UI component for a data-model type.

### CLI client expanded card

`cliClientInlineTypes + cliClientInlineModel → status/subscription leaves → CliClientInlineExpandedCard coordinator → CliClientsTable`

- `cliClientInlineModel.ts` owns installed-state action availability and disabled/missing tab fallback with pure tests.
- Status and subscription leaves own their respective information projections; the coordinator owns tabs, client install/uninstall adaptation, refresh spin, and footer actions.
- `CLI_CLIENT_INLINE_TAB` and `CliClientInlineTab` remain exported from the original module path for `CliClientsTable` compatibility.
- Existing inline-card primitives, i18n keys, action loading semantics, external-link behavior, and DOM layout are preserved.

### Agent organizations dashboard

`model → directory hooks → table/wizard routers → AgentOrgs coordinator → MainApp route`

- `model.ts` owns table-tab fallback, legacy-route recognition, and installed CLI filtering/sorting with pure tests.
- `useInstalledCliAgents.ts` and `useAgentOrgsDirectory.ts` independently own cancellation-safe initial loading, refresh behavior, and the existing org-change event subscription.
- `AgentOrgsTableContent.tsx` and `AgentOrgsWizardContent.tsx` are composition-only routers with no RPC mutation or notification side effects.
- The coordinator remains the single owner of save/delete RPC operations, destructive confirmation, Message feedback, and wizard navigation.

### Token manager content

The latest `develop` baseline moved Token Manager content under `.archive`. The earlier active-code split and its UI audit are intentionally excluded from this PR rather than modifying archived code.

### GitHub work-items surface — Phase 1

`githubWorkItemsSearchQuery + githubWorkItemsTypes → CreateIssueModal → GitHubWorkItemsSurface coordinator → WorkManagement`

- `githubWorkItemsSearchQuery.ts` is the pure owner of tokenization, qualifier parsing, canonical serialization, conflicting scope behavior, and issue request-state selection; it has focused regression tests for quoted labels, `@me`, merged PRs, `state:all`, and free text.
- `CreateIssueModal.tsx` owns repository/title/body draft state and reset behavior while preserving the original callback contract, Modal props, DOM, and overlay geometry.
- The request/cache/loading effect, scope transition order, pagination, issue detail mutations, workstation actions, and header publication were intentionally left untouched in Phase 1.
- The original default surface export and caller API remain unchanged. The next low-risk boundary is managed-item mapping and row presentation; request lifecycle extraction remains a separate higher-risk phase.

### GitHub work-items surface — Phase 2

`githubWorkItemsTypes/searchQuery/viewCache → githubManagedItemModel → GitHubWorkItemRows → GitHubWorkItemsSurface coordinator`

- `githubManagedItemModel.ts` is the pure owner of issue/PR projection, relative-time derivation, repository matching, scope/state filtering, `@me` resolution, labels, assignees, and free-text matching.
- Model tests cover issue/PR mapping, repository selection, viewer-relative filters, merged PR semantics, labels, free text, invalid timestamps, and deterministic time boundaries.
- `GitHubWorkItemRows.tsx` owns issue/PR row rendering and local dropdown visibility; it imports no store, navigation, API, cache, or request service.
- The coordinator remains the only owner of loading effects, cache mutation, pagination requests, issue detail mutations, workstation tab actions, and header publication.
- Phase 2 reduces the coordinator from 2066 to 1627 LOC (2356 to 1627 across both phases) while preserving the original default export and caller API.

### GitHub work-items surface — Phase 3

`derived list state + coordinator-owned virtualizer/actions → GitHubWorkItemsListView → existing list primitives and row leaves`

- `GitHubWorkItemsListView.tsx` owns loading/error/empty/no-results routing, issue/PR summary projection, personal-filter controls, virtual-row projection, and pagination composition.
- The coordinator continues to instantiate TanStack Virtual, own the scroll ref, compute loaded counts, and inject all action callbacks; the view imports no API, cache, store, navigation, or workstation service.
- Request/cache effects, load-more sequencing, detail mutations, tab opening, add-to-agent actions, header publication, and create mutation remain unchanged in the coordinator.
- Phase 3 reduces the coordinator from 1627 to 1448 LOC (2356 to 1448 across three phases) while preserving the public export and caller contract.

### GitHub work-items surface — Phase 4

`githubIssues service → useGitHubIssueDetail guarded controller → IssueDetailPanel → GitHubWorkItemsSurface coordinator`

- `useGitHubIssueDetail.ts` is the single owner of local detail state, comment loading, close/reopen mutations, comment submission state, host back-state publication, and unmount cleanup.
- Every async completion checks the captured issue `html_url` against the currently open detail before applying data, preserving the original stale-episode guard when users switch or close issues mid-request.
- Scope transitions still originate in the coordinator and explicitly call the stable `closeDetail` action; the hook's effects synchronize only external host state and do not synchronously mutate local state.
- My Station atom/tab setup and its independent comment-loading guard remain in the coordinator because they target a separate persistent workstation detail surface.
- Phase 4 reduces the coordinator from 1448 to 1325 LOC (2356 to 1325 across four phases) without changing request/cache loading, create mutation, pagination fetching, tab actions, or the public caller contract.

### GitHub work-items surface — Phase 5

`repo inventory + search-derived states → useGitHubWorkItemsLoadLifecycle → GitHub list cache/GitHub services → coordinator mutations and views`

- `useGitHubWorkItemsLoadLifecycle.ts` owns Git-repository source resolution, credential-derived viewer identity, cache-first issue/PR maps, initial revalidation, force-refresh nonce handling, loading/error state, and stale effect cancellation.
- Existing request semantics remain unchanged: issue and PR branches start in parallel, per-repo issue states share the same coalescing key, PR state requests retain their per-state keys, cache freshness checks remain authoritative, and issue errors still take precedence over PR errors.
- The two cancellation checks remain after source resolution and after issue/PR loading, so a scope/search-state/repository transition cannot publish stale sources or results.
- The hook exposes one semantic issue-map updater and list-error action for the existing load-more/create paths; it does not absorb pagination ordering, create mutation feedback, My Station state, tab navigation, or add-to-agent behavior.
- Phase 5 reduces the coordinator from 1325 to 959 LOC (2356 to 959 across five phases) while preserving public caller and wire/request payload shapes.

### GitHub work-items surface — Phase 6

`managed items + workstation/store services → useGitHubWorkItemActions → list rows/create success → GitHubWorkItemsSurface coordinator`

- `useGitHubWorkItemActions.ts` owns issue browser opening, My Station issue seeding/tab opening/guarded comment loading, PR detail tab opening, station-mode switching, and issue/PR context publication.
- My Station comment completion still compares the current atom issue `html_url` with the captured issue before publishing, preserving the original stale-tab guard.
- Issue-list, PR-list, and newly-created issue context payloads now share one issue projection while preserving the original per-path toast/store ordering and user-facing names.
- Create mutation and repo-map/cache insertion remain in the coordinator; only its successful context-publication step delegates to the action controller.
- Phase 6 reduces the coordinator from 959 to 847 LOC (2356 to 847 across six phases) without changing tab identities, request payloads, workstation state shape, i18n keys, or public caller API.

### GitHub work-items surface — Phase 7

`repo sources/maps + parsed query + repo/page selection → deriveGitHubWorkItemsState → memoized hook → list/pagination coordinator`

- `useGitHubWorkItemsDerivedState.ts` is the single owner of current-workstation and invalid-repo fallback, create-target selection, managed issue/PR projection, update-time sorting, repo/query filtering, request-state selection, remote-more detection, paging, counts, and loaded flags.
- The pure `deriveGitHubWorkItemsState` function is tested for workstation/invalid-repo fallback, sorted cross-kind projection, issue and merged-PR counts, remote pagination, and per-state loaded semantics.
- The React hook only memoizes the pure projection with explicit field dependencies; React Compiler lint, changed-path TypeScript, and LSP diagnostics all pass.
- Surface-level query/repo mutations, page clamping, load-more sequencing, create mutation, virtualization, and translated option construction remain outside the derived model.
- Phase 7 reduces the coordinator from 847 to 681 LOC (2356 to 681 across seven phases) without changing ordering, page size, repository fallback, filter semantics, request payloads, DOM, or public caller API.

### GitHub work-items surface — Phase 8

`derived repo/page state + GitHub issue service → useGitHubIssueMutations → shared issue map/cache → surface pagination/modal`

- `useGitHubIssueMutations.ts` owns load-more and create request state, parallel per-repo/per-state page requests, issue-map merges, open/closed cache publication, first-error selection, create failure feedback, and successful create context publication.
- Load-more still reads the captured repo map to build request tuples, executes them in parallel, merges each successful page into the latest map callback state, and updates `has_more`/`next_page` independently per issue state.
- Pagination advancement remains in the surface and occurs only after `loadMore` resolves, preserving the original current-page transition and scroll-to-top timing.
- Successful creation still prepends the issue, updates the open cache, closes the modal, then publishes the created issue context; failure leaves the modal open and uses the same translated fallback message.
- Phase 8 reduces the coordinator from 681 to 558 LOC (2356 to 558 across eight phases) without changing page size, request payloads, cache keys, toast text, modal contract, DOM, or public caller API.

### GitHub work-items surface — Phase 9

`scope + persisted view cache + repo atom → useGitHubWorkItemsViewState → load/derived/mutation controllers → surface pagination and shell`

- `useGitHubWorkItemsViewState.ts` owns the persisted repository filter, scope-keyed query/page state, canonical query mutations, personal presets, repo selection, refresh nonce, and issue/PR request-state derivation.
- Issue and PR view state now live in keyed buckets initialized from the existing cache, so scope switching reads the correct bucket without an effect synchronously resetting React state; the scope effect only closes the previous detail view.
- The pure personal-filter functions are tested for `@me` application/clearing and stable preset projection order; existing search DSL and view-cache tests continue to cover canonical serialization and persistence.
- Previous/next page sequencing, load-more completion, scroll-to-top, page clamping, and virtualization remain in the surface because they coordinate DOM and async mutation completion rather than persistent view state.
- Phase 9 reduces the coordinator from 558 to 464 LOC (2356 to 464 across nine phases) while preserving cache keys, per-scope defaults, scope transition outcome, pagination behavior, i18n keys, DOM, and public caller API.
- Residual verdict: **completed**. The remaining coordinator binds translated toolbar/modal models, header publication, page-clamp/previous/next sequencing, TanStack Virtual measurement, and the final detail-vs-list shell. These responsibilities change together at the page boundary; moving them would require a broad props relay without creating a separately testable behavior owner.

### Worktree source modal — Phase 1

`worktree source helpers/data hook → WorktreeSourceModal coordinator → WorktreeSourceModalRows leaves`

- `WorktreeSourceModalRows.tsx` is the single owner of the token-backed scroll list, input refresh suffix, and full-width selectable source row used by all four tabs.
- DOM structure, class names, dropdown token usage, selected indicator, refresh event propagation, disabled/loading state, and accessible labels were moved unchanged.
- Source derivation, tab state, GitHub/branch loading, smart suggestions, PR-base resolution, confirm sequencing, and modal shell remain in the coordinator.
- Existing branch/smart/resolve helper suites pass 61 tests; changed-path lint, TypeScript, LSP error diagnostics, and diff hygiene pass.
- Phase 1 reduces the coordinator from 967 to 884 LOC. The next low-risk boundary is Branch-tab presentation; PR resolution and data lifecycle remain higher-coupling coordinator responsibilities.

### Worktree source modal — Phase 2

`branch helper model + coordinator-derived state → WorktreeBranchTab → audited row/list leaves`

- `WorktreeBranchTab.tsx` owns the Branch tab's labeled search input, refresh suffix composition, loading/error/empty/no-match states, grouped sections, branch icon projection, timestamp metadata, and selectable rows.
- The coordinator continues to own branch query state, filtering/group derivation, custom-ref construction, fallback selection, data refresh invocation, and selected-source mutation; the leaf imports no data hook or PR-resolution service.
- `sourceKey` moved to the existing pure branch helper module because both the coordinator and Branch leaf compare launch-source identity; this avoids a UI-layer import cycle and keeps one identity rule.
- Existing DOM, i18n keys/defaults, branch icon mapping, `role="alert"`, refresh behavior, custom-ref placement, source ordering, and dropdown tokens are preserved.
- Phase 2 reduces the coordinator from 884 to 758 LOC; 61 helper tests, changed-path lint/TypeScript, LSP diagnostics, diff hygiene, and the existing dependency result pass.

### Worktree source modal — Phase 3

`coordinator-derived name source + source identity → WorktreeNameTab → audited row/list leaves`

- `WorktreeNameTab.tsx` owns the labeled worktree-name input and the optional one-row source preview; it reuses the existing shared `Input` and audited source list/row leaves.
- `nameInput`, name-source construction, fallback selection, source identity comparison, and selected-source mutation remain in the coordinator.
- Existing `htmlFor`/`id`, placeholder/default i18n text, `Base: ...` detail, selected semantics, canvas height, icon sizes, DOM, and class names are preserved.
- Phase 3 reduces the coordinator from 758 to 725 LOC; 61 helper tests, changed-path lint/TypeScript, LSP error diagnostics, diff hygiene, and the existing dependency result pass.

### Worktree source modal — Phase 4

`data hook + pure source builders → modal selection/confirm coordinator → Smart/GitHub/Branch/Name leaves → shared row/list leaves`

- `WorktreeSmartTab.tsx` owns smart input/status/suggestion presentation; `WorktreeGitHubTab.tsx` owns GitHub search/refresh/status/list presentation. Both receive already-derived data and callbacks and import neither the data hook nor PR-resolution service.
- `worktreeSourceModalTypes.ts` provides the narrow GitHub row projection shared by the coordinator and GitHub leaf without making either UI module the other's type owner.
- GitHub loading retains the original unfiltered loaded-item count, so a background load with an active no-match search does not regress to a spinner. Smart branch-error fallback, selection reset, resolve-error clearing, ordering, and default selection remain unchanged.
- The duplicate smart-input `sourceKey` implementation was removed after a domain-wide sweep; all modal identity comparison and smart deduplication now use the canonical pure helper, covered by a focused test.
- Phase 4 reduces the coordinator from 725 to 565 LOC (967 to 565 across four phases). Changed-path lint/TypeScript, 62 helper tests, LSP diagnostics, diff hygiene, and dependency checks pass apart from the repository's pre-existing tabs/RPC cycle.
- Residual verdict: **completed**. The remaining module is the intentional modal coordinator for source/data projection, cross-tab fallback and selection, PR metadata resolution, confirm sequencing, and tab/modal shell. Further extraction would split one selection invariant across a broad relay without adding an independently changing owner.

### Tool preview mock data

`events/shared/playgroundMocks + commandPreviewOverrides → mockData facade/builders → DevTools playground consumers`

- The existing public import path remains unchanged.
- Command overrides are a data catalog with one resolver API; they do not import the facade.
- The facade retains the development-only renderer/mock drift check.

## Architecture-audit coverage

| Layer                        | Result                                                                                                                                                   |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Compilation correctness   | Changed modules have zero LSP diagnostics and changed-path TypeScript errors; full-repo result is reported separately.                                   |
| 2. Dead code / deduplication | Removed unused `getMockEventData`; avoided exporting internal model/catalog types; retained live TabContent aliases required by `WorkStationTabType`.    |
| 3. Naming consistency        | Extracted modules are named by purpose (`model`, `commandPreviewOverrides`, `TabBarPlusMenuItems`); public names/import paths remain stable.             |
| 4. Semantic overloading      | `registry` remains scoped to tab renderers; `model` is local to each component domain; no new overloaded cross-domain term introduced.                   |
| 5. Default branches          | Unknown org task action returns the sender, unknown menu items are filtered, and unknown playground tools retain the explicit minimal skeleton fallback. |
| 6. Cross-domain leakage      | Leaf/model modules import only their owned domain dependencies; no queue/FSM/transport concern entered these modules.                                    |
| 7. New-developer clarity     | Coordinators own side effects; pure models/catalogs own derivation/data; dependency directions are one-way.                                              |
| 8. Wire protocol             | Not applicable: no network serialization shape changed. Playground objects are local UI fixtures and are covered by shape tests.                         |
| 9. Init parity               | Not applicable: no application/session entry point or initialization sequence changed.                                                                   |
| 10. Resolver symmetry        | Applicable only to playground direct→canonical→skeleton resolution; the chain remains identical for all callers through one facade function.             |

## Deferred high-risk classes

This batch intentionally does not alter queue/FSM/send/cancel, xterm, CodeMirror, or SessionReplay lifecycle semantics. Those areas require dedicated invariants and runtime verification rather than physical file splitting.
