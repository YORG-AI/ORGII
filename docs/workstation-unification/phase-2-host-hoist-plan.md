# WorkStation Unification — Phase 2 Execution Plan (Host-Context Hoist → Retire App Levels)

**Status:** planning · **Date:** 2026-07-14 · **Owner:** (you)

Goal: collapse the WorkStation from _ViewMode → App/Dock → Tab_ down to **one flat, unified tab surface**. Click `+` to open a tab, tabs persist while open, offload when closed — no dock, no per-app sub-routes, no app-switcher chip.

This is not a rewrite. The store already runs a **single flat tab pool** (`workstationLayoutAtom.mainPane`, persisted to `localStorage` key `workstation:layout-v2`), the `+` menu already opens tabs into it, and a lazy per-type dispatcher (`UnifiedTabContent` + `REGISTRY`) is **built but parked**. The code itself names the remaining work "Phase 2 — host context hoist."

---

## Why it isn't done yet (the one real blocker)

`UnifiedTabContent` renders any tab by looking up `REGISTRY[tab.type]` and mounting a lazy renderer with props `{ tab, paneId, isActive }` only. **28 of 44 renderers are still `HostCoupledPlaceholder` stubs** because their real components need host-owned context that lives _below_ the dispatcher today:

- **Editor** owns `fileContentState`, `gitFilesByPath`, `terminalState` + a 14-field callback bag.
- **Browser** owns the DevTools polling stack + the `+ New Browser Tab` request→session effect.
- **Database** owns the query-executor ref bridge + unsaved-CRUD (`pendingChanges`) + result-grid state.
- **Project** owns a callback bundle (`onSelectProject`, `onCreateProject`, …) + a 3-tab keep-alive multiplexer.

Mounting `UnifiedTabContent` and deleting the dock **today** degrades all four surfaces to placeholder panes. So the dock comes out **last**, after each host's context is hoisted above the dispatcher.

**Ship boundary rule:** during the migration, a tab type routes through the unified dispatcher _only once its host is hoisted_. Un-hoisted hosts keep the old `AppShellContent` keep-alive path. The two paths coexist per-host until Phase 2.5.

---

## Cross-cutting: the dispatcher must be keep-alive-aware

Every host already keeps non-active surfaces mounted to preserve scroll / in-flight queries / unsaved edits. A naive "mount active tab only" dispatcher regresses all of them. So the unified container is **mount-and-hide with an offload policy**, not remount-on-switch. This is also your product ask ("persist each opened tab; when closed offload"). The two requirements are the same requirement.

Decision still open (defer to Phase 2.6, tunable): keep **all** open tabs mounted, or an **LRU cap of N** (keep N most-recent mounted, offload the rest — their state is already persisted so re-open is cheap). Plan assumes keep-alive-aware container with a pluggable policy; default `all` first, add LRU cap in 2.6.

---

## Phase 2.0 — Foundations (additive, no behavior change)

Two new pieces the per-host phases build on. Nothing is deleted; nothing is rewired into the live app yet.

### 2.0a — Host-context publication seam (`WorkStationDispatcherContext`)

`UnifiedTabContentProps` is only `{ tab, paneId, isActive }`. Renderers need more. Add a React context published _above_ the dispatcher that each host fills with its hoisted surface; renderers read it instead of taking props from their old host switch.

- **New:** `src/modules/WorkStation/TabContent/DispatcherContext.tsx` — one context per host namespace (`editor`, `browser`, `data`, `project`) or a single context with per-host slices. Prefer per-host slices so a host provider only mounts its own.
- **New:** `src/modules/WorkStation/TabContent/hooks/useEditorHostContext.ts`, `useBrowserHostContext.ts`, `useDataHostContext.ts`, `useProjectHostContext.ts` — typed accessors; throw if read outside their provider (guards against re-introducing the placeholder degradation).
- **Touch:** `src/modules/WorkStation/TabContent/types.ts` — document that renderers may read host context via these hooks; `UnifiedTabContentProps` stays `{ tab, paneId, isActive }`.

### 2.0b — Keep-alive-aware container (`UnifiedTabHost`)

- **New:** `src/modules/WorkStation/TabContent/UnifiedTabHost.tsx` — takes the open-tab list from `mainPaneTabsAtom`, mounts each open tab's `UnifiedTabContent` inside a keep-alive wrapper (`display` toggle for inactive), and applies the offload policy (`all` | `lru:N`). Closed tab → removed from pool → unmounts → offload hook fires.
- **New:** `src/modules/WorkStation/TabContent/useTabOffloadPolicy.ts` — policy hook; returns which open tabs are "hot" (mounted) vs "cold" (offloaded).
- **Reuse:** `mainPaneTabsAtom`, `mainPaneActiveTabIdAtom`, `activeWorkStationTabAtom` from `src/store/workstation/tabs/atoms.ts`.

**Exit criteria for 2.0:** `UnifiedTabHost` renders the already-real (non-placeholder) tab types (chat, agent-config, settings, search-results-that-are-self-contained, benchmark, url-preview, token-category) correctly in isolation, behind a feature flag, with keep-alive working. No host hoisted yet.

---

## Phase 2.1 — Project host (cheapest; the template) — **do this first**

**Difficulty: EASY→MEDIUM. No live OS resource.** Every content callback is reconstructable from Jotai atoms + pure tab factories.

**Host files**

- Root: `src/modules/ProjectManager/ProjectManagerCore.tsx` (wraps `ActionSystemProvider` + `ProjectManagerLayout`).
- Host logic: `src/modules/ProjectManager/ProjectManagerLayout/index.tsx`.
- Today's dispatcher: `src/modules/ProjectManager/ProjectManagerLayout/components/ProjectManagerContentRouter.tsx` (`switch(activeTab.type)` + keep-alive multiplexer).
- Callback source: `src/modules/ProjectManager/ProjectManagerLayout/hooks/useProjectTabActions.ts` — **already a self-contained, atom-derived hook.**
- Prop contract: `src/modules/ProjectManager/ProjectManagerLayout/types.ts` (`ProjectManagerContentRouterProps`).

**Hoist surface → `useProjectHostContext`**

- Publish the `useProjectTabActions` bundle (`onSelectProject`, `onCreateProject`, `onCreateWorkItem`, `onOpenProjects`, `onOpenLinearProjects`, `onOpenRepoSettings`, `onExpandWorkItemToTab`, `onOpenChatSession`, `projectQuickActions`) + tab mutations (`onCloseTab`/`onUpdateTabData`/`onUpdateTabMeta`/`onSetTabUnsaved` from `useWorkStationTabs`) + `onProjectListRefreshRequested` + `repoPath`/`repoName`.
- `repoPath`/`repoName` are **not atoms** (AppShell app-mode props) → source them from the active-repo context in the provider.
- `embeddedWorkItemDetailTabs` (React-local `useState`, `ProjectManagerLayout` ~L143) feeds **only the sidebar**, not content — leave it in the host; content just fires `onEmbeddedWorkItemDetailStateChange`.

**Keep-alive requirement (the blocker):** `project-workitems` (no hyphen — heavy `WorkItemsPage`), `project-linear-projects`, `project-linear-work-items` are mounted simultaneously and toggled `display:none` (router ~L121–217). `UnifiedTabHost` must keep this family hot while any is open. Mind the naming: `project-workitems` (no hyphen) = per-project keep-alive page; `project-work-items` (hyphen) = lightweight index.

**Renderers to convert (10)** — `src/modules/WorkStation/TabContent/renderers/`:
| Tab type | Renderer | Needs (from `useProjectHostContext` + `tab.data`) |
|---|---|---|
| `project-dashboard` | `projectDashboard.tsx` | `onSelectProject/onCreateProject/onOpenLinearProjects`, `orgScope/orgId`, `workStationTabId` |
| `project-work-items` | `projectWorkItems.tsx` | `onExpandWorkItemToTab/onOpenLinearProjects/onCreateProject/onCreateWorkItem`, `orgId` |
| `project-workitems` | `projectWorkitemsCompat.tsx` | **heaviest**, keep-alive; full callback set + `repoPath` |
| `project-linear-projects` | `projectLinearProjects.tsx` | `onCreateProject/onCreateWorkItem/onUpdateTabData/onEmbeddedWorkItemDetailStateChange`, `repoPath` |
| `project-linear-work-items` | `projectLinearWorkItems.tsx` | same, surface forced to WORK_ITEMS |
| `project-settings` | `projectSettings.tsx` | **only `tab.data.section`** (stub note overstates — fix it) |
| `project-org` | `projectOrg.tsx` | `onUpdateTabData/onSelectProject/onCreateProject/onCreateWorkItem/onExpandWorkItemToTab/onOpenLinearProjects` + org fields |
| `project-org-settings` | `projectOrgSettings.tsx` | same, `orgView` forced to SETTINGS |
| `project-git-sync-review` | `projectGitSyncReview.tsx` | **only `tab.data.orgId/orgName`** (stub note overstates — fix it) |
| `workItem-detail` | `workItemDetail.tsx` | `onCloseTab/onOpenChatSession/onUpdateTabData/onUpdateTabMeta` + workItem fields |

**Also keep mounted above dispatcher (side-effect publications):** `projectStatusBarCallbacksAtom`/`projectStatusBarStateAtom` (`useProjectStatusBar`), `workstationProjectTabBarAtom` (the `+` "onAddProject"), `useWorkStationTabShortcutBridge` (⌘W). None are read by content, so low risk.

**Steps:** (1) add `ProjectHostProvider` filling `useProjectHostContext` from `useProjectTabActions`; (2) mount it above `UnifiedTabHost` for project tabs behind the flag; (3) convert the 10 renderers to read context; (4) make `UnifiedTabHost` keep-alive-aware for the 3-tab family; (5) route project tabs through unified when flag on, dock still switches other hosts. **Ship.**

---

## Phase 2.2 — Browser host

**Difficulty: MEDIUM.** Big win: the webview engine (`SharedBrowserApp`) and session store (`BrowserProvider`) are **already mounted above WorkStation** (`src/modules/index.tsx:458–463`) — webviews already survive tab switches.

**Host files**

- Root: `src/modules/WorkStation/Browser/index.tsx` → `src/modules/WorkStation/Browser/BrowserLayout/index.tsx`.
- Logic hook: `src/modules/WorkStation/Browser/BrowserLayout/useBrowserLayoutState.ts`.
- Sessions/DevTools hook: `src/hooks/workStation/browser/useBrowserSessions.ts`.

**Already global (no lift):** session context (`src/contexts/workstation/BrowserContext.tsx` via `BrowserProvider`), tab store (`src/store/workstation/browser/tabs`), webview host registry (`src/modules/WorkStation/Browser/shared/sharedBrowserHostAtoms.ts`), most panel atoms in `src/store/ui/workStationAtom.ts`.

**Hoist payload → `useBrowserHostContext` (the real work):**

- DevTools polling stack — `useBrowserConsole`, `useBrowserNetworkLogs`, `useWebviewInspector` (instantiated inside `useBrowserSessions`): `entries`, `errorCount`, `warningCount`, `networkEntries`, `selectedElement`, `isInspectMode`, `currentUrl`, `webviewLabel`. Must move to a single **always-mounted owner above the dispatcher** and re-publish as atoms/context — **without double-instantiating pollers** (IPC pressure; respect the `POLLING_START_DELAY_MS` guard) or dropping in-hook caches.
- Two React-local `useState`s to lift: `devToolsPanelWidth` (`useBrowserSessions.ts:128`), `devToolsPanelHeight` (`BrowserLayout/index.tsx:67`).

**Critical coupling:** `workstationNewBrowserSessionRequestAtom` (`+ New Browser Tab`) is consumed **only** by the effect in `BrowserLayout/index.tsx:77–92` (`addBrowserSession`). If `BrowserLayout` unmounts, the tick advances and the action silently no-ops. **Relocate this effect to the always-mounted host** above the dispatcher.

**Renderers to convert (5):**
| Tab type | Renderer | Needs |
|---|---|---|
| `browser-session` | `browserSession.tsx` | mount a rect-publisher (`SharedBrowserWorkspace`/`SharedBrowserHostSlot`) + drive `setActiveSession(tab.data.sessionId)`. Webview already above. |
| `devtools` | `devtools.tsx` | full DevTools subset from `useBrowserHostContext` + `repoPath` + collapse/position handlers — **only renderer needing genuinely host-local state** |
| `token-category` | `tokenCategory.tsx` | **already real** — `tab.data.category` + `activeWorkspaceRootPathAtom` |
| `url-preview` | `urlPreview.tsx` | **already real** — `tab.data.url/title` |
| `dom-component-preview` | `domComponentPreview.tsx` | only `fileName`/`jsonText` — component is self-contained; coupling is nominal (file just lives under CodeEditor) |

**Biggest blocker:** relocating the DevTools polling stack into one always-mounted owner + the new-session effect, without poller duplication. **Ship** once `browser-session` + `devtools` render for real through the dispatcher.

---

## Phase 2.3 — Database host

**Difficulty: MEDIUM.** Connection pool is a **module singleton** (`src/engines/DatabaseCore/factory.ts` `serviceCache`, LRU-50) → survives remount, no per-tab connection thrash.

**Host files**

- Root: `src/modules/WorkStation/DatabaseManager/index.tsx` (wraps `ActionSystemProvider`).
- Today's dispatcher: `src/modules/WorkStation/DatabaseManager/DatabaseLayout/index.tsx` (branches add-connection vs `DatabaseMainPane`; table/query/schema all fall to one pane).
- Pane: `src/modules/WorkStation/DatabaseManager/.../DatabaseMainPane/index.tsx`.
- Atoms: `src/store/workstation/database/atoms.ts`.

**Already global (no lift):** `databaseConnectionsAtom`, `queryHistoryAtom`, connection-config module fns. **Purpose-built but currently unused** atoms ready to become the hoisted surface: `activeConnectionIdAtom`, `selectedTableAtom`, `activeConnectionAtom`, `activeConnectionTablesAtom` (`atoms.ts:179–211`) — wire the host to these instead of re-deriving from tab data.

**Hoist payload → `useDataHostContext` (the blocker):**

- Imperative `executeQueryRef` bridge (`DatabaseLayout/index.tsx:136–147` ↔ `DatabaseMainPane` `onRegisterExecuteQuery`): sidebar-history "Run" calls the mounted pane. Assumes exactly one always-mounted pane.
- Pane-local `pendingChanges` (`src/hooks/database/usePendingChanges.ts`) — **unsaved insert/update/delete edits** — plus result-grid state (`tableData/tableSchema/queryResult/…`). Per-tab unmount under a naive dispatcher **silently drops unsaved CRUD edits**.
- Lift both into atoms **keyed by tab id or `connectionId:tableName`** before per-tab dispatch. Add abort/mounted-guards to `loadTableData`/`handleExecuteQuery` (currently orphan setState on unmount).

**Renderers to convert (4):**
| Tab type | Renderer | Needs / note |
|---|---|---|
| `add-connection` | `addConnection.tsx` | lightest — `onSave`(→`addConnectionConfig`) + `onCancel`(→`closeTab`); form logic self-contained in `useConnectionFormState` |
| `table` | `table.tsx` | `connectionId`+`tableName`+`tables` (global) + lifted grid/edit state |
| `query` | `query.tsx` | `connectionId`+`tables`+`queryHistory` (global) + lifted executor/result state + Run bridge |
| `schema` | `schema.tsx` | **no viewer exists today** (factory-only, no live caller) — needs building or defer |

**Note:** `query`/`schema` tabs have **no live callers** today (only `table` + `add-connection` are opened). Consider shipping `table` + `add-connection` first; `query`/`schema` can trail or be deferred.

**Biggest blocker:** lifting `pendingChanges` + result-grid + the `executeQueryRef` bridge into per-tab atoms. **Ship** once `table` + `add-connection` render for real without dropping edits.

---

## Phase 2.4 — Editor host (heaviest) — **do last of the four**

**Difficulty: HARD.** Owns live terminal PTYs, LSP, file watchers, and the richest prop bag.

**Host files**

- Today's dispatcher: `src/modules/WorkStation/CodeEditor/Panels/EditorMainPane/content/TabContentRenderer/index.tsx` — `switch(activeTab.type)` taking the 14-field prop bag: `fileContentState` (`UseFileContentManagerReturn`), `gitFilesByPath`, `gitDiffLoading`, `forceRefresh`, `onFileSelect`, `onFileSelectWithLine`, `onDiagnosticsChange`, `onCursorPositionChange`, `onSearchTabTitleChange`, `onGitDiffUnsavedChange`, `onBinaryUnsavedChange`, `terminalState`, `repoPath`, `repoId`.
- Host: `src/modules/WorkStation/CodeEditor/` (EditorContent owns `fileContentState` + `gitFilesByPath`; terminal state store at `src/store/workstation/codeEditor/terminal/`).

**Hoist payload → `useEditorHostContext`:** the whole prop bag. `fileContentState` (file-content manager) and `terminalState` are the heaviest React-local pieces. `gitFilesByPath` derives from git status (can be atom-backed).

**Special cases:**

- `source-control` is rendered by a **keep-alive overlay in `EditorMainPane`** (mounted once, shown/hidden) so diff+scroll survive — `TabContentRenderer` returns `null` for it (double-mount guard). The unified container must preserve this keep-alive.
- Many editor tab types are already handled inline in `TabContentRenderer` (explorer, directory, git-log, terminal-content, output, settings, chat-session, url-preview, benchmark, subagent-detail) and several already delegate to `UnifiedTabContent` via the `default` branch — reuse, don't rebuild.

**Renderers to convert:** `file.tsx` (needs `fileContentState`+`gitFilesByPath`), `gitDiff.tsx`/`timelineDiff.tsx`, `gitCommitDetail.tsx`/`gitStashDetail.tsx`, `sourceControl.tsx`, `gitLog.tsx`, `terminal.tsx`/`terminalContent.tsx`, `search.tsx`, plus verify the already-inline ones route cleanly.

**Biggest blocker:** hoisting `fileContentState` + `terminalState` above the dispatcher without disturbing PTY/LSP lifecycles or the source-control keep-alive overlay. **Ship** once `file` + `source-control` + `terminal` render for real through the dispatcher.

---

## Phase 2.5 — Retire the dock & app levels (only after 2.1–2.4)

Now every host is hoisted, so `AppShellContent` can collapse to a single `UnifiedTabHost` and the app-level machinery deletes.

**Collapse / rewrite**

- `src/modules/WorkStation/AppShell/AppShellContent.tsx` → render just `<UnifiedTabHost>` (keep-alive dispatcher). Delete the 5-host `display:none` block + all `hasVisited*`/`*ContentVisible` props.
- `src/modules/WorkStation/AppShell/index.tsx` → drop `effectiveHost`/`is*Mode`/`visitedModes`/dock wiring; remove `<Dock>`/`StationDockChrome` render.

**Delete (dead once dock is gone)**

- `src/store/workstation/dockFilter/atoms.ts` (`dockFilterAtom`, `activeHostAtom`), `dockFilter/navigation.ts` (`buildDockFilterPath`).
- `src/modules/WorkStation/AppShell/hooks/`: `useAppShellDock.ts`, `useAppShellDerivedState.ts`, `useAppShellDockFilterSync.ts`, `useActiveTabHostReconciliation.ts`, `useMyStationDockSegments.ts`.
- `useDockFilterUrlSync` (from `src/hooks/workStation`).
- Dock UI: `src/engines/Simulator/components/Dock/*`, `StationDockChrome` (if not reused by Agent Station — check first).
- App-switcher chip: `src/modules/WorkStation/shared/AppSwitcherChip.tsx`, `AppSwitcherDropdownPanel.tsx`, `AppSwitcherWrappers.tsx`.

**Simplify (don't delete blindly)**

- Routes: `src/config/routeViewModeConfig.ts`, `src/config/routes.ts`, `src/config/routeTabMapping.ts` — drop per-host sub-routes (`/orgii/workstation/{code,browser,data,project}`); keep redirects to the unified base so bookmarks survive.
- `src/config/viewModeTypes.ts` — `AppModeType` tier can shrink; keep `ViewMode` (`mainApp|workStation`).
- `src/store/workstation/tabHost.ts` — becomes dead for routing; keep only if still used for status-bar app derivation (`activeStatusBarAppAtom`).
- Status bar: `useAppShellDerivedState` currently sets `activeStatusBarAppAtom` from `effectiveHost` — re-derive it from the active tab's host via `tabToHost` instead.

**Verify:** ⌘T / `+` menu, ⌘W, tab reorder (dnd-kit), pinned tabs, spotlight (⌘P), deep links to old sub-routes, Agent Station vs My Station toggle.

---

## Phase 2.6 — Offload layer ("when closed, offload")

- **View unmount on close:** falls out of `UnifiedTabHost` — a closed tab leaves the pool → unmounts. Free.
- **Resource refcount:** DB service (`serviceCache`), browser session, terminal PTY should free when the **last** tab referencing them closes. Add refcount/GC keyed by resource id; don't free on tab switch, only on last-close.
- **Open-but-inactive policy:** finalize `all` vs `lru:N` in `useTabOffloadPolicy`. Recommend `lru:N` (state already persisted → cheap re-open) with N tuned to observed tab counts; heavy hosts (browser webview, terminal) pin their live tab hot regardless.

---

## Sequencing summary

| Phase | Scope                                                             | Difficulty | Ships independently?                |
| ----- | ----------------------------------------------------------------- | ---------- | ----------------------------------- |
| 2.0   | Dispatcher context seam + keep-alive container                    | Medium     | Behind flag, no user-visible change |
| 2.1   | **Project** host hoist (10 renderers)                             | Easy→Med   | ✅ project tabs unified, dock stays |
| 2.2   | **Browser** host hoist (5 renderers)                              | Med        | ✅                                  |
| 2.3   | **Database** host hoist (`table`+`add-connection` first)          | Med        | ✅                                  |
| 2.4   | **Editor** host hoist (`file`/`source-control`/`terminal`)        | Hard       | ✅                                  |
| 2.5   | Delete dock / app-switcher / sub-routes; collapse AppShellContent | Med        | ✅ the payoff                       |
| 2.6   | Offload + LRU + resource refcount                                 | Med        | ✅                                  |

**Open decision (Phase 2.6, non-blocking):** offload aggressiveness — keep all open tabs mounted vs LRU cap N. Default `all`, switch to `lru:N` after measuring.

**Per CLAUDE.md:** this is a cross-layer refactor (Jotai stores + `*.tsx`), so each phase should walk the `architecture-audit` checklist for the layers it touches before finalizing. Renderer conversions under `src/modules/WorkStation/**/components/` also fall under `frontend-ui-audit` if they grow beyond mechanical prop-adaptation.
