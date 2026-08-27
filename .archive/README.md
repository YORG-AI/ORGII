# .archive

Code parked out of the live build but kept in-tree (and in git history). Excluded from `tsconfig.json` (`exclude: [".archive"]`), so nothing here is type-checked or bundled. Paths mirror their original `src/` location, so restoring is a reverse `git mv`.

## Browser "design tokens" tab (`token-category`) — archived 2026-07-14

The My Station browser primary sidebar was reduced to a **Sessions-only** variant (History and Design pills removed, pill header hidden — see `BrowserPrimarySidebar`'s `sessionsOnly` prop). The **Design** pill was the _only_ entry point for the "color / design tokens" viewer (`onOpenColorTokens` → `createColorTokensTab` → a `token-category` tab rendered by `TokenManagerPanel`). With that entry point gone, the whole `token-category` tab type became unreachable, so it was archived.

**What moved here (self-contained to the feature):**

- `src/modules/WorkStation/Browser/Panels/BrowserMainPane/content/TokenManagerContent/` — the token viewer panel (`TokenManagerPanel`)
- `src/modules/WorkStation/Browser/Panels/BrowserMainPane/components/DesignFileBar/` — used only by `TokenManagerContent`
- `src/modules/WorkStation/TabContent/renderers/tokenCategory.tsx` — the unified `token-category` renderer wrapper

**What deliberately stayed live (shared with other features):**

- `src/modules/WorkStation/Browser/hooks/useGlobalTokens.ts` — still used by the Browser sidebar's Design tab (`DesignTabGlobalTokens`), which remains in the **full** sidebar variant used by SessionReplay's "My Tabs" sidebar
- `src/modules/WorkStation/Browser/Panels/BrowserPrimarySidebar/tabs/{HistoryTab.tsx,DesignTab/}` — still rendered by the full (non-`sessionsOnly`) sidebar variant
- `src/modules/WorkStation/Browser/Panels/BrowserMainPane/{content/WebViewportContent,components/WebUrlBar}` — the live browser viewport + URL bar

**Shared files edited in place** to sever the `token-category` branch:

- `src/store/workstation/tabs/types.ts` — dropped `"token-category"` from the `WorkStationTabType` union and the `TOOL_TAB_TYPES` list
- `src/store/workstation/tabHost.ts`, `src/store/workstation/tabs/tabFactory.ts` — removed its `→ "browser"` host mapping
- `src/modules/WorkStation/TabContent/registry.ts`, `.../renderers/index.ts` — removed the renderer entry + barrel re-export
- `src/store/workstation/browser/tabs/index.ts` — removed the `token-category` id-helpers, `createTokenCategoryTab` / `createColorTokensTab`, the `isShowingTokenCategoryAtom` / `tokenCategoryTabsAtom` atoms, `TokenCategoryData`, and its `BROWSER_TAB_TYPES` membership
- `src/modules/WorkStation/Browser/BrowserLayout/{index.tsx,useBrowserLayoutState.ts}` — removed the `TokenManagerPanel` mount, `handleOpenColorTokens` / `handleOpenHistoryUrl`, and the `useGlobalTokens` auto-scan wiring

**To restore:** reverse the `git mv`s above and revert the in-place edits (see the archival commit).

**Note:** any browser tab of type `token-category` persisted in a user's saved workstation layout will no longer resolve to a renderer. This feature was reachable only via the removed Design pill, so that is expected.

## WorkStation Database app — archived 2026-07-14

The WorkStation "Database" app (the **Data** dock app, its tab types, renderers, and the `DatabaseManager` module) was removed from the live WorkStation. See `docs/workstation-unification/phase-2-host-hoist-plan.md` for the broader unification effort this is part of.

**What moved here (self-contained to the app):**

- `src/modules/WorkStation/DatabaseManager/` — the whole host module
- `src/hooks/database/` — its hooks (`useSqliteDatabase`, `usePendingChanges`, `useQueryHistory`, `useDatabaseConnections`)
- `src/store/workstation/tabs/factories/database.ts` — db tab factories/creators
- `src/modules/WorkStation/TabContent/renderers/{table,query,schema,addConnection}.tsx` — the (placeholder) unified renderers
- `src/modules/WorkStation/shared/StatusBar/DatabaseStatusBar.tsx`

**What deliberately stayed live (shared with other features):**

- `src/engines/DatabaseCore/` and `src/store/workstation/database/` — used by MainApp → Integrations → Databases, the CodeMirror SQL editor, and the Code Editor's SQLite file preview
- `src/assets/databaseIcons/`, `src/hooks/workStation/database/` (Code Editor `.sqlite` preview)
- Rust: `src-tauri/crates/db-browser` and `crates/db-clients` (the `db_*` / `db_sql_*` Tauri commands) — still invoked by the above. `crates/database` is the app's own persistence and is unrelated.

**Shared files that were edited in place (not moved)** to sever the db branch: AppShell (`AppShellContent`, `index.tsx`, `useAppShellDerivedState`, `useMyStationDockSegments`), tab store (`tabHost`, `tabs/types`, `tabFactory`, `factories/index`, `tabs/index`), `dockFilter/atoms`, `TabContent/registry`, routes (`routeViewModeConfig`, `routeGroups`, router redirect, `componentMapping`), and `StatusBarRenderer` + `shared/StatusBar/index`.

**To restore:** reverse the `git mv`s above, revert the in-place edits (see the archival commit), and remove `.archive` from `tsconfig.json`'s `exclude`.

**Known harmless leftovers (intentional, to limit ripple):** the `db-table`/`db-query`/`db-schema` members of `WorkStationTabCategory` and the `"data"` slot in `StatusBarAppType` remain as unused union members; the `dockFilter.data` i18n key remains in `navigation.json` across locales.

## MainApp Home and global view-mode layer — archived 2026-07-23

The standalone Home/Start Page and the global `mainApp` ↔ `workStation` view-mode switch were retired. Workstation and Settings now share one router-owned Workbench shell; standalone Market/Ideas/Dev pages use a plain route outlet. This removes the duplicated route/view/tab state machine, sticky mounts, route caching, and Home-only customization state.

**What moved here:**

- `src/modules/MainApp/StartPage/` and its `appGridAtom`
- the Home-only repository-drop overlay layout helper at `src/components/GlobalDragDrop/useGlobalDragDrop/useLayoutHelpers.ts`
- the old month/day Changelog UI was retired; its generated git-summary
  documents and data-bound page were deleted instead of archived
- `HomeSidebar`, `EconomySidebar`, and their unused `PageLevelSidebar` base
- global view-mode configuration, atom, synchronization component, route-tab metadata, and retired MainApp tab helpers
- `ScrollRestorationWrapper` and the MainApp KeepAlive route-cache helper

**What deliberately stayed live:**

- `ChatPanelStartPage` / Launchpad — this is the active new-session and creator surface, not the retired Home page
- Workstation tab state and ChatPanel tab state — both remain active domain-owned tab systems
- Changelog as a product feature — it now lives at `src/engines/ChatPanel/panels/ChangelogPanelView.tsx`, reads version-scoped release notes from `src/config/changelog/releases.ts`, and opens as a singleton ChatPanel tab
- `/orgii/app/changelog` — retained as a route-level launcher for Spotlight, app actions, and old bookmarks; it opens the Changelog tab and redirects to Workstation

**Shared logic edited in place:** Global drag/drop now handles only visible ChatPanel composer targets. The retired Home folder-drop hint, repository confirmation overlay, and Spotlight handoff state were removed from the shared handler.

**To restore:** reverse the relevant `git mv`s and restore the removed
route/view branches and KeepAlive dependencies. The legacy generated
git-summary documents and their month/day page were deliberately deleted; the
live version-level Changelog is the supported release-note source.

## Detached window and standalone Settings shells — archived 2026-07-23

The unused `/windows/welcome` mode picker and `/windows/tab` detached-tab host were removed after their route, window-manager, and Tauri command call chains were confirmed to have no production entry point. The old full-page Settings shell was reachable only from that detached-tab host; the active Settings experience remains `SettingsSlot` inside the Workbench.

**What moved here:**

- `src/windows/` detached-window components and their unreferenced styles
- `src/modules/MainApp/Settings/index.tsx`, its full-page content component, and its route/monitor hooks
- the unreferenced `SettingsListPanel`
- the unused sidebar visibility hook and retired App Grid navigation-state type
- the unused `WindowStateProvider`/window registry, including its 30-second heartbeat
- the detached-window-only frontend base-URL helper

**What deliberately stayed live:**

- `src/modules/MainApp/Settings/SettingsSlot.tsx` and all renderers, sections, subpages, and toolbar logic it consumes
- the `app-window` Rust crate’s main-window zoom, vibrancy, background, and native-window lifecycle support
- `emitOpenWorkspace`, which is still used by session launch
- the storage-safe `getWindowId()` helper used by repo/workspace persistence

**To restore:** reverse the relevant moves and restore the `/windows/*` routes, detached-window manager helpers, and their four Tauri command registrations.

## Orphaned modules sweep — archived 2026-07-27

Unlike the sections above, this was not a feature removal but a mechanical sweep: 34 modules that **no file in the repo imports**, found by building the `src/` import graph and diffing it against the file list.

The graph resolved the `@src` / `@api` / `@common` / `@page` / `@assets` aliases, lazy `import(/* webpackChunkName */ …)`, `new Worker(new URL(…))`, and source paths referenced as plain strings from root configs (vitest `setupFiles`, webpack entry). Every file below additionally has a basename that appears in **no other file** in `src/`, `tests/`, or `scripts/` — so nothing reaches them by import, by test, or by name.

Note that the repo's own `npm run check:unused-exports` does **not** find these. `ts-unused-exports` reports exports nobody imports, which is a different question — a fully-live module that over-exports its internal types lands on that list (1047 modules do), while a module nobody imports at all does not necessarily.

**What moved here (34 files, ~5,120 LOC):**

- `src/components/` — `ComposerInput/ComposerInputSurface`, `FileTreeContent/FileTreeRows`, `Virtualized/VirtualizedSessionList`
- `src/config/` — `animationConfig`, `externalLinks`, `heavyComponents`
- `src/engines/ChatPanel/` — `InputArea/components/createPillCache`, `hooks/useInputArea/useRepoSuggestions`, `panels/RecentSessionsPanelView`, `panels/useBenchmarkSessionCreatorSlots` (658 LOC, the largest)
- `src/engines/Simulator/components/` — `AskUserEvent`, `AskUserPending`, `GridCell/subagentCellHeaderIconKind`
- `src/engines/BrowserCore/BrowserUrlInput`
- `src/features/SessionCreator/` — `components/SessionInfoLine/SwitchWorkspaceSelector`, `variants/ChatPanel/AttachmentPopover`
- `src/hooks/` — `auth/marketAuthHelpers`, `models/useModelCatalog`, `session/useOrgtrackSessionArtifacts`
- `src/modules/MainApp/Integrations/` — `AddOptionsGrid`, `KeyVault/LocalModels/LocalModelsTabSection`, `KeyVault/Models/Detail/ModelCatalogDisplay`, `RulesMemoryEvolution/hooks/useAutomationRules`
- `src/modules/WorkStation/` — `WorkStationShellFallback`, `shared/LayoutSettingsDropdown/{LayoutDropdownControls,LayoutThumbs}`, `CodeEditor/Panels/EditorMainPane/content/SearchEditorContent/SearchResultsCodeView`, `CodeEditor/Panels/EditorPrimarySidebar/hooks/useOpenAIImpactTab`
- `src/modules/ProjectManager/WorkItems/components/WorkItemProperties/AssigneeDropdown`
- `src/modules/shared/layouts/GenericBottomPanel/DownloadProgressCard`
- `src/scaffold/` — `GlobalSpotlight/palettes/EditorPalette/hooks/useHintMode`, `NavigationSidebar/utils/menuFromRoutes`, `WizardSystem/shared/externalImport/ExternalImportWizard`
- `src/store/chatPanel/recentCliAgentsAtom`

**No shared files were edited.** Because nothing imported these modules, severing them required no changes to live code — this archival is a pure `git mv`.

**What deliberately stayed live:** 151 barrel files (`index.ts` / `exports.ts`) that nothing currently imports. Some are deliberate public-API surface that internal callers happen to reach past, so bulk-archiving them would be wrong. They need a per-barrel judgement call and are left for a separate pass.

**Verification:** `tsc --noEmit` clean, full vitest suite green (701 files / 6390 tests), production webpack build clean.

**To restore:** reverse the `git mv` for the file in question. No other edits are needed.

---

## SWE-bench "Benchmark (Beta)" UI — archived 2026-08-16

The SWE-bench Pro benchmark runner UI (task browser, run builder, per-run
session group in the chat panel, `benchmark` WorkStation tab) is parked. On
`develop` it was already unreachable from normal UI: no menu offered the
`benchmark` create target, nothing created a `benchmark` tab except the E2E
seed helpers, and `BenchmarkTabSidebar` had no consumer. The only live entry
was clicking a legacy "Benchmark run coordinator" session in the sidebar,
which routed to the run-list surface. **Not** the Housekeeper _token_ benchmark
(`housekeeperTokenBenchmark`, `integrations:housekeeper.benchmark.*`) — that
is a different feature and stays live.

**What moved here (self-contained to the feature):**

- `src/features/BenchmarkPanel/` — panel, task selector, `useBenchmarkTasks`, `useBenchmarkAgentBatchRun`
- `src/modules/WorkStation/shared/SidebarModules/Benchmark/` — `BenchmarkTabSidebar`
- `src/modules/WorkStation/TabContent/renderers/benchmark.tsx` — the `benchmark` tab renderer
- `src/engines/ChatPanel/panels/BenchmarkRunBuilder.tsx` — the run-builder creator surface
- `src/store/benchmark/` — batch status / active batch atoms
- `src/api/tauri/benchmark/` — the `benchmarkApi` client over the `benchmark_*` Tauri commands
- `src/app/root/e2e/helpers/benchmark.ts` — E2E seed/inspect helpers
- `tests/e2e/specs/core/{benchmark-run-ui,benchmark-docker-execution}.spec.mjs` (mirrored under `.archive/tests/`)

**What deliberately stayed live:**

- `src-tauri/src/benchmark/` — the Rust runner/commands still compile and are registered; they are now unreferenced from the frontend and can be removed in a backend-only PR
- `src/config/agentIcons.tsx` `flask-conical` entry and `src/assets/fileTypeIcons/folder-benchmark*.svg` — generic icon registry / file-icon theme, not feature-specific
- Housekeeper token benchmark (`src/modules/MainApp/Integrations/Housekeeper/HousekeeperCategoryView.tsx`, `rpc.validation.housekeeperTokenBenchmark`)

**Shared files edited in place** to sever the branch:

- `src/store/workstation/tabs/{types.ts,tabFactory.ts,storage.ts,index.ts,factories/{index,codeEditor}.ts}` — dropped `"benchmark"` from `WorkStationTabType`, its host mapping and persisted-type allow-list, and `BenchmarkTabData` / `benchmarkTabFactory` / `createBenchmarkTab`
- `src/modules/WorkStation/TabContent/registry.ts`, `shared/SidebarModules/index.ts`, `shared/TabBar/components/SortableTab/index.tsx` (`BookLock` icon branch), `AppShell/CodeSidebarHeaderActions.tsx`
- `src/store/ui/chatPanelAtom.ts`, `src/types/ui/chatPanel.ts`, `src/engines/ChatPanel/navigation/chatPanelSurfaceReducer.ts` — removed `CHAT_PANEL_CREATE_TARGET.BENCHMARK`, `CHAT_PANEL_CONTENT_MODE.BENCHMARK_SESSION_GROUP`, `CHAT_PANEL_SURFACE_KIND.BENCHMARK_SESSION_GROUP` and their navigate/reducer cases
- `src/engines/ChatPanel/{index.tsx,ChatPanelContent.tsx,ChatPanelEmptyContent.tsx,hooks/useChatPanelContentState.tsx}` — removed the run-list mount, the run-builder creator branch, and `showBenchmarkSessionGroupContent`
- `src/scaffold/NavigationSidebar/connectors/{useWorkstationSidebarHandlers.ts,useSessionMenuItems/{index.tsx,menuItemBuilders.tsx},WorkstationSidebarConnector/sidebarConnector.pinnedAndRevealData.ts}` — removed coordinator-session routing, child-session hiding, and master-row highlighting
- `src/util/session/sessionDisplayMetadata.ts` — removed the `benchmark` flag / `flask-conical` icon override
- `src/app/root/{E2EBootstrap.tsx,e2e/types.ts}`, `tests/e2e/wdio.conf.mjs` — removed helper wiring and the docker fixture builder
- `src/i18n/locales/*/sessions.json` — removed `creator.benchmark.*` and `creator.createTarget.benchmark` (13 locales)

**Behavior change:** legacy "Benchmark run coordinator" sessions and their child sessions now appear in the sidebar as ordinary sessions (previously the children were hidden and the coordinator opened the run list). Any persisted `benchmark` WorkStation tab is dropped by the storage allow-list on load.

**To restore:** reverse the `git mv`s above and revert the in-place edits (see the archival commit).

## LSP / Lint / Output / Test panels — archived 2026-08-25

Language-server and lint tooling became an **agent-only** capability: the agent
reaches it through the `manage_lsp` / `query_lsp` tools in `agent-core`, which
call the Rust `lsp` crate directly as plain functions. Nothing about LSP or lint
is shown to users any more. The Output panel and the whole test-runner vertical
were archived in the same pass.

The Rust `lsp` crate itself **stays live** — only its user-facing entry points
(the 33 `lsp_*` / `lint_*` Tauri commands and the diagnostics WebSocket fan-out)
were removed.

### What moved here

**LSP / lint (frontend):**

- `src/modules/WorkStation/CodeEditor/Panels/EditorBottomPanel/` — the whole
  secondary panel (Problems, Output, Test Results tabs; its Terminal tab was
  already disabled)
- `src/modules/WorkStation/CodeEditor/Panels/EditorMainPane/content/LintScanContent/`
  and `src/modules/WorkStation/TabContent/renderers/lintScan.tsx` — the
  `lint-scan` tab
- `src/modules/MainApp/Integrations/DevTools/{LanguageServersPage,LintToolsPage}/`
  and `src/modules/MainApp/Integrations/hooks/lsp/` — the install / enable /
  server-log UI
- `src/modules/MainApp/Settings/sections/EditorSection/components/LanguageServersSection.tsx`
  — the Settings → Editor entry point into those pages
- `src/modules/shared/launchpad/components/WorkspaceToolsReadiness.tsx` — the
  LSP/lint readiness widget
- `src/modules/WorkStation/CodeEditor/LspInstallPrompt/` — the "install a
  language server" toast
- `src/features/CodeMirror/Editor/extensions/linter/` — in-editor squiggles
- `src/services/lsp/` — the frontend LSP client / workspace-scan layer
- `src/store/workstation/codeEditor/diagnostics/` and
  `src/modules/WorkStation/CodeEditor/hooks/diagnostics/`
- `src/modules/WorkStation/shared/StatusBar/utils/{useLspDropdown,languageServicePanelRows}.ts`
  — the status-bar LSP indicator and its dropdown

**Output:**

- `src/modules/WorkStation/CodeEditor/hooks/output/` and
  `src/types/workstation/output.ts` — the output-channel store
- `src/store/workstation/codeEditor/outputIntegration/taskOutputAtom.ts`
- `src/modules/WorkStation/TabContent/renderers/output.tsx` — the `output` tab
- `src/services/guiAgent/` — `GUIAgentService` existed only to write dispatched
  actions into the panel's "GUI Agent" channel. Left in place it would have
  buffered every action forever (`connect()` is never called any more), so it
  was archived rather than neutered.
- `.../hooks/gitOutputIntegration/{formatters,constants,useFileWatchHeartbeat}.ts`
  — ANSI message formatting, the panel-log dedup set, and the "no changes" idle
  heartbeat

**Test runner:**

- `src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/{content/TestingContent,tabs/TestingTab.tsx}`
- `src/modules/WorkStation/CodeEditor/hooks/useTestRunner.ts`, `src/services/test/`,
  `src/store/workstation/codeEditor/testRunner/`, `src/types/testing/`
- `src/modules/WorkStation/ActionSystem/registration/actions/testActions.zod.ts`
- `src-tauri/crates/test-runner/` — the whole Rust crate (nothing but the
  archived frontend used it)

**Backend:**

- `src-tauri/crates/lsp/src/broadcast.rs` — the WebSocket fan-out IoC point.
  Diagnostics are still cached in-process for `query_lsp`; only the push to the
  frontend is gone.

**Orphaned by the above:**

- `src/modules/WorkStation/CodeEditor/Panels/shared/{PanelLayout.tsx,AutoScrollContainer.tsx,_panel-mixins.scss}`
  — used only by the bottom panel's tab contents
- `src/modules/shared/layouts/GenericBottomPanel/` — already dead before this
  change, and its stated purpose was the "Settings (LSP, Lint, Downloads
  output)" panel

### What deliberately stayed live

- **`src-tauri/crates/lsp/`** — everything except `broadcast.rs`. `agent-core`
  calls `lsp_get_workspace_config`, `lsp_set_server_enabled`,
  `lsp_check_installed`, `lsp_get_install_command`, `servers_for_language_id`,
  `LspManager`, and `lsp::types::*` as ordinary Rust. `LspManagerState` is still
  `app.manage`d at startup.
- **`src/modules/WorkStation/CodeEditor/hooks/gitOutputIntegration/`** — git
  push / pull / fetch / commit / stage run _through_ this layer, so it could not
  be deleted with the panel. The output writes, the `requestAnimationFrame`
  batching (which existed only to coalesce DOM updates), and the channel
  bookkeeping were stripped; streamed lines are still accumulated in memory to
  populate the git error dialog. The `WithOutput` method names and the
  `gitOutputIntegration` paths were left alone on purpose — renaming them would
  have touched every source-control call site and buried the behavioural change.
  **Follow-up:** rename the directory, `gitOutputIntegrationAtom`, and the
  `*WithOutput` methods in a separate mechanical PR.
- **`ChatPanel/blocks/ToolCallBlock/OutputContent.tsx` and `LspStatusOutputData`**
  — these render the _agent's_ tool output in chat, including `manage_lsp`
  results. Unrelated to the editor panel of the same name.
- **`IdeContext.linter_errors`** (`agent-core`) — the Rust field and its prompt
  rendering are untouched, but the frontend no longer populates it (the
  collector read `globalLspDiagnosticsAtom`, which no longer exists), so it is
  always empty. An agent-side producer can fill it later.

### Shared files edited in place

- `src/modules/WorkStation/CodeEditor/index.tsx` — dropped the secondary-panel
  mount, `useDiagnostics`, and `useOutputChannels`
- `.../EditorLayout/components/EditorIntegrations/index.tsx` — now only wires git
  operations and the go-to-line bridge
- `src/features/CodeMirror/Editor/` — removed `enableLinting`,
  `onDiagnosticsChange`, and the whole `Diagnostic` prop chain through
  `EditorMainPane` → `CodeViewerContent` → `ContentView`
- `src/store/workstation/tabs/` — dropped the `output` and `lint-scan` tab types,
  factories, categories, and the `"lint"` tab category
- `src/store/ui/workStationLayout/` — dropped the bottom-panel _tab_ atoms
  (`BOTTOM_PANEL_TABS`, labels, order, persist), the terminal-sidebar width, and
  the Code Editor secondary-panel _position_ atom. The generic collapse/height
  atoms stay — Browser DevTools and the Simulator placeholder still use them.
- `src/store/ui/workStationLayout/primarySidebarAtoms.ts`,
  `EditorPrimarySidebar/config.ts` — removed the `testing` sidebar tab
- `src/services/panel/PanelService.ts`, `panelActions.zod.ts`,
  `ActionSystem/actionIds.ts` — removed `panel.showBottom`
- `src/util/dialogs/gitErrorDialog.ts`, `src/hooks/git/useGitErrorDialog.ts` —
  the "Show Command Output" button routed to the Output panel; that branch is
  gone and non-stash failures now offer "Open Git Log" / "Cancel" (the Git Log
  tab still carries the command output)
- `src/ActionSystem/ActionSystemContext.tsx` — removed the `GUIAgentService`
  logging calls
- `src/modules/MainApp/Integrations/DevTools/DevToolsCategoryView.tsx` — the
  category is now just Dependencies; the `devToolsTab` deep-link plumbing in
  `IntegrationsDetailPanel`, `useIntegrationsPage`, and `useAppNavigation` went
  with it
- `src/modules/WorkStation/CodeEditor/SessionReplay/CodePanel/severity.tsx` —
  **new file**; inlines `DiagnosticSeverity` + `getSeverityIcon`, which the
  search-results renderer borrowed from the Problems panel but which have
  nothing to do with LSP
- `src-tauri/src/commands/handler_list.inc` — removed 33 `lsp_*` / `lint_*` and
  5 `test_runner::*` command registrations
- `src-tauri/src/lib.rs`, `src-tauri/src/setup/hooks.rs` — removed
  `register_lsp_hooks()` and the `TestRunnerState` manage
- `src-tauri/Cargo.toml` — dropped the `test_runner` workspace member/dependency

### Known consequences

- The Chat panel's **Workspace → Overview** tab is now empty except its footer
  actions; the tools-readiness widget was its entire body.
- The Code Editor has **no secondary panel at all** any more.
- Translation keys for the removed surfaces (`tabs.problems`, `tabs.output`,
  `tabs.testResults`, `placeholders.outputChannelLabel`,
  `workstation.languageServices`, `languageServersPage.*`, …) were left in the
  13 locale files. `scripts/quality/check-missing-i18n-keys.mjs` only reports
  _missing_ keys, so these are inert. **Follow-up:** sweep them separately.
