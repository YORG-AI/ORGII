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
