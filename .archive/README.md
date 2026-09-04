# .archive

Code parked out of the live build but kept in-tree (and in git history). Excluded from `tsconfig.json` (`exclude: [".archive"]`), so nothing here is type-checked or bundled. Paths mirror their original `src/` location, so restoring is a reverse `git mv`.

## Browser component UI index — archived 2026-08-30

The repository-wide React/Vue/Svelte component index used by Browser
WebDevTools was retired. Its `UiIndexState` retained a parsed index for every
repository in an in-process `RwLock<HashMap<...>>`, while the frontend added
status/build/clear state and AST lookup branches to source navigation. Browser
source navigation now uses direct framework/debug metadata when available and
bounded filename/content search otherwise.

**What moved here:**

- `src-tauri/crates/ui-indexer/` — the component parsers, index state, lookup
  commands, types, and tests
- `src/modules/WorkStation/Browser/hooks/useSourceNavigation.ts` — the original
  indexed source-navigation implementation retained as a historical snapshot
- `src/modules/WorkStation/Browser/hooks/sourceNavigation/{types,componentScorer}.ts`
  — index contracts and result scoring
- `src/modules/WorkStation/Browser/Panels/BrowserSecondaryPanel/components/WebDevTools/hooks/uiIndexControls.ts`
  — the retired status/build/clear IPC boundary extracted from the shared hook

**What deliberately stayed live:**

- Browser WebDevTools Design and CSS panels, computed-style editing, and DOM
  inspection
- direct source paths supplied by code-inspector attributes or framework debug
  metadata
- on-demand filename and regex content search for components
- the `scan_global_tokens` CSS-variable scanner, moved to the active `browser`
  crate because the Design token UI still consumes it

**Shared files edited in place:** the Tauri workspace/command/state wiring and
the WebDevTools source tab had their component-index branches removed. The
source tab still opens direct locations and offers on-demand search when only a
component name is known.

**To restore:** reverse the Rust/frontend moves, restore the archived
`useSourceNavigation` and types snapshots, move `scan_global_tokens` back (or
keep the browser-owned implementation and omit the archived duplicate), then
restore the Tauri command registrations, managed `UiIndexState`, and WebDevTools
build/clear controls.

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

## Orphaned modules sweep — archived 2026-08-29

The second mechanical sweep of this kind (see **Orphaned modules sweep —
archived 2026-07-27** above for the first). Not a feature removal: **259 files
that no file in the repo imports**, found by rebuilding the `src/` import graph
and diffing it against the file list. The set regrew mostly from the Benchmark
(2026-08-16) and LSP/Output (2026-08-25) archivals, which severed entry points
without sweeping everything they orphaned.

The graph resolved the `@src` / `@api` / `@common` / `@page` / `@assets`
aliases, lazy `import(/* webpackChunkName */ …)`, `new Worker(new URL(…))`,
`vi.mock`, and source paths referenced as plain strings from root configs
(vitest `setupFiles`, webpack entry). Roots were `src/index.tsx`, every
`*.test.ts` under `src/`, and every `src/` path named from `scripts/`,
`tests/`, `tools/`, or a root config.

**What moved here (259 files, 20,192 LOC).** Largest clusters:

- `src/modules/MainApp/Inbox` — 11 files, 1,780 LOC
- `src/modules/MainApp/Integrations` — 21 files, 1,220 LOC
- `src/modules/WorkStation/CodeEditor` — 9 files, 1,091 LOC
- `src/features/CodeViewer` — 7 files, 1,074 LOC
- `src/engines/Simulator/components` — 6 files, 949 LOC
- `src/modules/ProjectManager/Panels` — 4 files, 679 LOC
- `src/hooks/theme` — 5 files, 675 LOC
- `src/modules/MainApp/AgentOrgs` — 9 files, 618 LOC
- `src/scaffold/WizardSystem/shared` — 4 files, 598 LOC
- `src/engines/ChatPanel/ChatItems` — 5 files, 591 LOC
- `src/components/DatePicker` — 2 files, 587 LOC
- `src/engines/TerminalCore/components` — 3 files, 450 LOC
- `src/features/CodeViewer/hooks` — 1 file, 422 LOC
- `src/components/TreePanelSidebar` — 2 files, 406 LOC
- `src/features/CodeViewer/components` — 3 files, 398 LOC
- `src/scaffold/WizardSystem/variants` — 8 files, 386 LOC
- `src/components/DevPassport` — 5 files, 374 LOC
- `src/engines/ChatPanel/InputArea` — 4 files, 336 LOC
- `src/features/SessionCreator/components` — 4 files, 301 LOC
- `src/modules/WorkStation/Chat` — 3 files, 300 LOC
- `src/components/Breadcrumb` — 1 file, 284 LOC
- `src/util/ui/theme` — 1 file, 274 LOC

**Also moved:** seven `.scss`/`.css` files that only the archived components
imported (`DatePicker/index.scss`, `DevPassport/{devpassport,styles}.css`,
`AskUserChatItem/index.scss`, `CodeViewer/{EditableCodeViewer,ModernSplitDiff}.scss`,
`GitDiffContent/ImageDiffView.scss`).

**No shared files were edited.** Nothing imported these modules, so severing
them required no changes to live code — this archival is a pure `git mv`, the
same as the 2026-07-27 sweep. 41 directories left empty by the move were
removed.

### The one that was not merely unused: `src/lib/dndKit/`

`src/lib/dndKit.ts` (a file) and `src/lib/dndKit/` (a directory with its own
`index.ts`) both defined `getUiScaleFromCssVar`, `scaleAwareModifier`, and
`useWebViewSensors`. Node and webpack resolve `@src/lib/dndKit` to the **file**,
so all eight live importers — `KanbanBoard`, `DragTable`, `QueuedMessages`,
`useSelectionExtension`, `terminalHandlers`, `KanbanColumn`,
`useTextSelectionDropdown` — have always gotten `dndKit.ts`, and the directory
never loaded. Editing the directory copy would have changed nothing at runtime.
The directory is archived; `src/lib/dndKit.ts` stays and is now the only copy.

The other 13 file/directory shadowing pairs under `src/` were checked and are
fine: each has importers reaching into the directory, so only the shadowed
barrel is unreachable.

**Deliberately left live:**

- `src/styles/_common.scss` and
  `.../FilePreviewContent/CsvTableView/index.scss` — both are unreferenced, but
  _already_ were before this sweep and neither belongs to an archived module.
  `CsvTableView/index.tsx` is live and simply never imports its own stylesheet,
  unlike every sibling preview; that reads as a missing import rather than a
  dead file, so it needs a fix, not an archival.
- Barrel files (`index.ts` / `exports.ts`) that nothing imports but which
  re-export live modules — same judgement call as the 2026-07-27 sweep.

**Verification:** `tsc --noEmit` clean; full vitest suite green (1268 files /
9999 tests). Both run with every file below already moved out of `src/`.

**To restore:** reverse the `git mv` for the file in question. No other edits
are needed.

## Test-only modules — archived 2026-08-29

A companion pass to the sweep above, asking a different question: not "what does
nothing import?" but **"what does nothing but its own test import?"** Rebuilding
the graph from _production_ roots only (`src/index.tsx` and `src/` paths named
from `scripts/`, `tests/`, `tools/`, or a root config — no test roots) leaves
modules the app never loads and only the suite keeps alive. A passing test is
not evidence a module is wanted.

**26 modules + the 21 tests that were their only consumer (8,081 LOC).**

Whole units:

- `src/components/DevPassport/` — `PassportBook`, `Stamp`, `types` + its test.
  The rest of the feature (`PassportDisplay`, `PassportDossier`, the barrel, two
  stylesheets) went in the sweep above; this completes it.
- `src/api/realtime/websocket/` — `client.ts`, `types.ts`, `WSProvider.tsx` +
  `WSProvider.test.ts`; `config.ts` went in the sweep above.
- hosted-key activity sync — `useHostedKeyActivitySync.ts`,
  `hostedKeyEventUtils.ts`, `src/api/http/session/hostedKey.ts` + two tests.
- `src/api/tauri/diff/` and `src/util/diff/index.ts` — see the duplicates note
  below.

Individually: `util/data/converters/eventPayload.ts`,
`util/ui/dom/isNativeElement.ts`, `SessionCore/utils/{waitForSnapshotChange,
sessionGenerationGuard}.ts`, `components/{FloatingScrollNav,TrafficLights}/`,
`ChatPanel/navigation/chatPanelSurfaceReducer.ts`,
`Simulator/utils/eventSegments.ts`, `Org2Cloud/cloudWorkItemLock.ts`,
`MainApp/Settings/settingsRouteModel.ts`,
`SpreadsheetEditor/clipboardUtils.ts`, `shared/pr/types.ts`,
`CodeReviewBlocks/ReviewSeverityIcon.tsx`,
`TerminalCore/terminalSessionSidebarLayout.ts`, `util/ui/theme/luminance.ts`
— each with its one test.

### More duplicate implementations, same shape as `dndKit`

Three of these were not merely unused but _shadowed by a second live copy_:

- `src/util/diff/index.ts` exported `parseUnifiedDiff`; the live parser is
  `src/engines/ChatPanel/blocks/CodeBlock/diffParser.ts`, which defines its own.
- `SpreadsheetEditor/clipboardUtils.ts` exported `parseClipboardText` and
  `stringifyRangeAsTsv`; `WorkStation/shared/TableSurface/hooks/useTableClipboard.ts`
  defines both itself.
- `src/api/tauri/diff/index.ts` was the pre-RPC diff client;
  `api/tauri/rpc/procedures/diff.ts` is the live path and does not import it.

### Deliberately kept — test infrastructure

These are prod-unreachable _by design_ and must stay:

- `src/test/staticImportGraph.ts` (4 test consumers), `src/test/reactSmokeHarness.ts` (14)
- `src/features/Org2Cloud/org2CloudSyncEngine.testUtils.ts` (11)
- `src/config/settingsSchema/assertSettingsUiParity.ts` — a schema-parity
  invariant guard whose whole purpose is to be asserted from a test

### Also kept

`src/api/realtime/websocket/schemas.ts` + its test — imported by
`src/api/tauri/rpc/schemas/cli.ts`, so the directory is not fully dead.

**Verification:** `tsc --noEmit` clean; full vitest suite green. Re-running the
orphan graph afterwards found **no further cascade** — the only unreached files
left in `src/` are the eleven ambient `.d.ts` declarations, which tsconfig
`include` consumes rather than any import.

**To restore:** reverse the `git mv` for the module _and_ its test together.

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

**Rust runner — archived 2026-09-01 (follow-up to the UI archival above):**

- `src-tauri/src/benchmark/` — the SWE-bench runner, agent-batch orchestration, Docker evaluation, preflight, retention, and the 13 `benchmark_*` Tauri commands (3,542 LOC). The UI archival left these compiled and registered with no frontend caller; this is the backend-only removal that entry called for.

**Shared files edited in place** for the Rust archival:

- `src-tauri/src/commands/handler_list.inc` — dropped the 13 `benchmark::benchmark_*` registrations
- `src-tauri/src/lib.rs` — dropped `pub mod benchmark;`
- `src-tauri/src/app/builder.rs` — dropped `benchmark` from the handler-list `use crate::{…}` scope
- `src-tauri/src/app/lifecycle.rs` — dropped the exit-time `benchmark::terminate_running_evaluators_sync()` call (nothing can spawn an evaluator any more)

**What deliberately stayed live:**

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
