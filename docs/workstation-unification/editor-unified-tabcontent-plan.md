# Editor host → `UnifiedTabContent` swap — implementation plan

**Status:** planning · **Date:** 2026-07-14 · **Scope:** Code Editor host only (`EditorMainPane`)

Goal: render the active Code Editor tab through the shared `UnifiedTabContent` dispatcher
(`src/modules/WorkStation/TabContent/`) instead of the bespoke `TabContentRenderer`
(`src/modules/WorkStation/CodeEditor/Panels/EditorMainPane/content/TabContentRenderer/`),
then delete the now-dead `TabContentRenderer` path. This finishes the Phase 2.4 host-context
hoist: the `EditorHostProvider` + `useEditorHostContext()` seam is already mounted above the
content area — the editor is the last host still painting via its own switch.

## Recommendation: land behind verification, not blind

This plan is deliverable **(B)** from the task. The swap is completable, but it is **not a pure
mechanical swap** — it requires a new `directory` renderer, a shared-registry remap, and a type
decoupling before `TabContentRenderer` can be deleted. Two real divergences were found by reading
(one a live regression), and this is a high-traffic surface in a Tauri desktop app that cannot be
click-verified from the agent environment. Land it in one PR **with a human running the app through
the per-tab-type checklist below**, especially the source-control / terminal keep-alive overlays and
directory tabs.

---

## Current wiring (what exists today)

`EditorMainPane/index.tsx` render tree (≈ lines 775–877):

```
<EditorHostProvider value={editorHostValue}>            // already mounted (Phase 2.4)
  <CodeEditorDefaultHeader .../>
  <div relative>
    {shouldMountTerminalContent && <TerminalMainContent overlay/>}   // keep-alive, z-10 when active
    {!isTerminalTabActive && (
      <div z-10>
        {showAppPlaceholder
          ? <NoTabsPlaceholder icon="editor" .../>       // hasNoTabs || isExplorerHome
          : <TabContentRenderer activeTab=... 15 props />}  // ← THE SWAP TARGET (≈ lines 812–834)
      </div>
    )}
    {hasVisitedSourceControl && sourceControlTab && (
      <SourceControlMainPane overlay/>                    // keep-alive, z-20 when active
    )}
  </div>
</EditorHostProvider>
```

Key facts established by reading:

- `editorHostValue` already publishes the exact 14-field bag the editor renderers consume
  (`fileContentState`, `gitFilesByPath`, `gitDiffLoading`, `forceRefresh`, `onFileSelect`,
  `onFileSelectWithLine`, `onDiagnosticsChange`, `onCursorPositionChange`, `onSearchTabTitleChange`,
  `onGitDiffUnsavedChange`, `onBinaryUnsavedChange`, `terminalState`, `repoPath`, `repoId`).
- `TabContentRenderer` is imported in exactly **one** place (`EditorMainPane/index.tsx`).
  `preloadSourceControlTabContent` (exported from the same file) is imported in **one** place
  (`CodeEditor/index.tsx:50,152`).
- The **source-control** main pane and the **terminal** main pane are painted by their own
  keep-alive overlays in `EditorMainPane`, _independent of_ `TabContentRenderer`. `TabContentRenderer`'s
  `case "source-control"` returns `null` and its `case "terminal"` is unreachable (the whole content
  branch is gated by `!isTerminalTabActive`). The registry mirrors this: `sourceControl.tsx` renders
  `null`, and the `terminal` renderer stays gated. **Both overlays are untouched by this swap.**

---

## The swap itself

In `EditorMainPane/index.tsx`, replace the `<TabContentRenderer .../>` element (≈ lines 812–834) with:

```tsx
{
  activeTab ? (
    <UnifiedTabContent tab={activeTab} paneId="main" isActive />
  ) : (
    // Preserve TabContentRenderer's `!activeTab` branch: an empty read-only editor.
    // showAppPlaceholder already covers hasNoTabs; this guards the rare
    // tabs-exist-but-activeTab-null window so we don't render a blank pane.
    <Suspense fallback={<LazyFallback />}>
      <CodeViewerContent
        selectedFile={null}
        fileContent=""
        loading={false}
        error={null}
        repoPath={repoPath}
        onFileSelect={onFileSelect}
        onContentChange={fileContentManager.handleContentChange}
        onSave={fileContentManager.handleSave}
        onDiscard={fileContentManager.handleDiscard}
        onReload={fileContentManager.handleReload}
        hasUnsavedChanges={false}
        saving={false}
        requiresFilePreviewRoute={false}
        onDiagnosticsChange={onDiagnosticsChange}
        onCursorPositionChange={onCursorPositionChange}
      />
    </Suspense>
  );
}
```

- `isActive` is hard-coded `true` — the dispatcher only ever mounts for the active tab here (matches
  `TabContentRenderer`'s default-case `<UnifiedTabContent ... isActive />`, and drives `benchmark`'s
  `publishHeader={isActive}` correctly).
- Drop the now-unused props that were only passed to `TabContentRenderer`
  (`sourceControlAttributedFiles`, `sourceControlCollapseAllSignal`, `sourceControlFilterMode`,
  `editorQuickActions`) — those were already dead in `TabContentRenderer`'s switch (only its `null`
  source-control case existed) and are consumed by the source-control **overlay**, not the dispatcher.
  Keep passing them to `<SourceControlMainPane>` unchanged.
- Import `UnifiedTabContent` from `@src/modules/WorkStation/TabContent/UnifiedTabContent`.
  Keep a lazy `CodeViewerContent` + `LazyFallback` for the null-guard branch (or, simpler, reuse
  `NoTabsPlaceholder`/`TabLoadingPlaceholder` — but the empty read-only editor is the faithful mirror).

---

## Blocker to fix before the swap: `directory` renderer

`registry.ts` maps **both** `directory` and `explorer` to `ExplorerEntry`
(`renderers/explorer.tsx`, a "No workspace open" placeholder). But `TabContentRenderer`'s
`case "directory"` renders `DirectoryExplorerContent`. Today this registry entry is **dead** —
`directory` tabs are intercepted by `TabContentRenderer`'s explicit `case "directory"` and never
reach the registry, and no other host creates `directory` tabs (`createDirectoryTab` is called only
from `hooks/workStation/editor/useCodeEditorEvents.ts` and recursively from
`DirectoryExplorerContent` itself — both editor-only). The moment the editor routes through
`UnifiedTabContent`, that dead entry goes live and **regresses every directory tab to a placeholder.**

Fix (in scope — `TabContent/renderers` + `registry.ts`):

1. **New file** `src/modules/WorkStation/TabContent/renderers/directory.tsx` — mirror
   `TabContentRenderer`'s `case "directory"`, pulling `repoPath` + `onFileSelect` from
   `useEditorHostContext()` and `directoryPath` from `tab.data`:

   ```tsx
   const DirectoryTabRenderer: React.FC<UnifiedTabContentProps> = memo(
     ({ tab }) => {
       const { repoPath, onFileSelect } = useEditorHostContext();
       const directoryPath = String(tab.data.directoryPath ?? "");
       return (
         <Suspense fallback={<LazyFallback />}>
           <DirectoryExplorerContent
             key={directoryPath}
             directoryPath={directoryPath}
             repoPath={repoPath}
             onFileSelect={onFileSelect}
           />
         </Suspense>
       );
     }
   );
   ```

   (`DirectoryExplorerContent` prop shape: `{ directoryPath, repoPath, onFileSelect }` — all
   available from context/tab.data. Use a lazy import to match the other renderers' code-splitting.)

2. **`registry.ts`** — add `DirectoryEntry` (`Component: lazy(() => import("./renderers/directory"))`,
   `requiresRepo: true`, `debugLabel: "directory"`) and remap `directory: DirectoryEntry`. Leave
   `explorer: ExplorerEntry` as-is. This only changes behavior once the editor routes `directory`
   through the dispatcher (no other host renders `directory`), so it is safe today.

Because `DirectoryTabRenderer` reads `useEditorHostContext()`, it is subject to the same host-scoping
as `file`/`git-diff`/`search`/`terminal`: it throws if rendered outside an `EditorHostProvider`. That
is fine — `directory` is editor-only, and the Project Manager host's router already keeps bespoke
branches / `default → NoTabsPlaceholder` for editor-context-dependent types, so it never reaches this
renderer.

---

## Decoupling required before deleting `TabContentRenderer`

`context/editorHostContext.tsx` derives its value type from the renderer's props:

```ts
export type EditorHostContextValue = Pick<TabContentRendererProps,
  "fileContentState" | "gitFilesByPath" | ... | "repoId">;   // imports ../content/TabContentRenderer/types
```

Deleting `TabContentRenderer/types.ts` breaks this. Convert `EditorHostContextValue` into a
**standalone interface** with the same 14 fields (no runtime change — `editorHostValue` in
`EditorMainPane` already provides exactly these). Bring the field types directly:

- `fileContentState: UseFileContentManagerReturn` (`../hooks/useFileContentManager`)
- `gitFilesByPath: Map<string, GitFile>` (`@src/types/git/types`)
- `terminalState: UseTerminalStateReturn` (`@/src/engines/TerminalCore/types`)
- `onDiagnosticsChange?: (d: Diagnostic[]) => void` (`../../EditorBottomPanel/content/ProblemsContent/types`)
- `onCursorPositionChange?: (p: CursorPosition | null) => void`
  (`@src/modules/WorkStation/shared/StatusBar/EditorStatusBar`)
- remaining fields are `boolean` / `string` / `string | null` / plain callback signatures.

(The 4 source-control-only fields on `TabContentRendererProps` — `sourceControlAttributedFiles`,
`sourceControlCollapseAllSignal`, `sourceControlFilterMode`, `editorQuickActions` — plus `activeTab`
are intentionally **not** part of `EditorHostContextValue` and are consumed elsewhere, so nothing else
needs them relocated.)

---

## `preloadSourceControlTabContent` relocation

It currently lives in `TabContentRenderer/index.tsx` and just fires two dynamic imports
(`SourceControlMainContent`, `GitDiffContent`). Move the function verbatim into
`content/index.ts` (or a tiny `content/preloadSourceControl.ts`) and keep the barrel re-export so
`CodeEditor/index.tsx` import stays valid. No behavior change.

---

## Files to add / change / delete

**Add**

- `src/modules/WorkStation/TabContent/renderers/directory.tsx`

**Change**

- `src/modules/WorkStation/TabContent/registry.ts` — add `DirectoryEntry`, remap `directory`.
- `src/modules/WorkStation/CodeEditor/Panels/EditorMainPane/index.tsx` — swap element; import
  `UnifiedTabContent`; add null-active guard; drop the 4 dead source-control props from the swapped
  element (keep them on `SourceControlMainPane`); remove `TabContentRenderer` import.
- `src/modules/WorkStation/CodeEditor/Panels/EditorMainPane/context/editorHostContext.tsx` — make
  `EditorHostContextValue` standalone (remove `Pick<TabContentRendererProps>`).
- `src/modules/WorkStation/CodeEditor/Panels/EditorMainPane/content/index.ts` — remove the
  `TabContentRenderer` / `TabContentRendererProps` exports; host `preloadSourceControlTabContent`.

**Delete**

- `src/modules/WorkStation/CodeEditor/Panels/EditorMainPane/content/TabContentRenderer/index.tsx`
- `src/modules/WorkStation/CodeEditor/Panels/EditorMainPane/content/TabContentRenderer/types.ts`
  (the whole `TabContentRenderer/` dir)

---

## Per-tab-type verification (read-only parity findings)

Every editor tab type was diffed: what `TabContentRenderer`'s `switch` passes vs. what the
registry renderer + `useEditorHostContext` provide.

| Tab type                                                                             | `TabContentRenderer` case                                         | Registry renderer                                       | Parity                                                                                    |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `file`                                                                               | `CodeViewerContent` (git baseline, deleted-file, csv-dirty logic) | `file.tsx`                                              | **1:1** ✅                                                                                |
| `git-diff` (+ `isTimeline`)                                                          | `GitDiffContent`, key by `tab.id`/`filePath`                      | `gitDiff.tsx`                                           | **1:1** ✅                                                                                |
| `git-commit-detail`                                                                  | `GitCommitDetailContent`                                          | `gitCommitDetail.tsx`                                   | **1:1** ✅                                                                                |
| `git-stash-detail`                                                                   | `GitCommitDetailContent` (stash header)                           | `gitStashDetail.tsx`                                    | **1:1** ✅                                                                                |
| `git-log`                                                                            | read-only `CodeViewerContent` banner                              | `gitLog.tsx`                                            | **1:1** ✅                                                                                |
| `terminal-content`                                                                   | read-only `CodeViewerContent`                                     | `terminalContent.tsx`                                   | **1:1** ✅                                                                                |
| `dom-component-preview`                                                              | `DomComponentPreviewContent`                                      | `domComponentPreview.tsx`                               | **1:1** ✅                                                                                |
| `output`                                                                             | `Placeholder` (channel name)                                      | `output.tsx`                                            | **1:1** ✅                                                                                |
| `settings`                                                                           | `EditorSettings`                                                  | `settings.tsx`                                          | **1:1** ✅                                                                                |
| `search`                                                                             | `SearchEditorContent` (line-aware click)                          | `search.tsx`                                            | **1:1** ✅                                                                                |
| `ai-impact`                                                                          | `AIImpactContent`                                                 | `aiImpact.tsx`                                          | **1:1** ✅                                                                                |
| `benchmark`                                                                          | `BenchmarkRenderer` (`isActive` hard true)                        | `benchmark.tsx`                                         | ✅ (pass `isActive` true)                                                                 |
| `subagent-detail`                                                                    | `SubagentDetailTab`                                               | `subagentDetail.tsx`                                    | **1:1** ✅                                                                                |
| `chat-session`                                                                       | `ChatView readOnly` (gradient shell)                              | `chatSession.tsx`                                       | **1:1** ✅                                                                                |
| `url-preview`                                                                        | `UrlPreviewContent`                                               | `urlPreview.tsx`                                        | **1:1** ✅                                                                                |
| `source-control`                                                                     | `null` (overlay owns)                                             | `sourceControl.tsx` (`null`)                            | ✅ overlay preserved                                                                      |
| `terminal`                                                                           | `TerminalMainContent` (unreachable — overlay owns)                | `terminal.tsx` (still gated)                            | ✅ overlay preserved                                                                      |
| `explorer`                                                                           | empty `CodeViewerContent`                                         | `explorer.tsx` placeholder                              | ✅ intercepted upstream by `isExplorerHome → NoTabsPlaceholder`; never reaches dispatcher |
| **`directory`**                                                                      | **`DirectoryExplorerContent`**                                    | **`ExplorerEntry` placeholder**                         | ❌ **REGRESSION — fix per "Blocker" section**                                             |
| `lint-scan`                                                                          | `LintScanContent repoPath={host.repoPath}`                        | `lintScan.tsx` `repoPath = activeWorkspaceRootPathAtom` | ⚠️ **divergence — see Risks**                                                             |
| `timeline-diff`                                                                      | n/a (dormant; no factory emits it)                                | `timelineDiff.tsx` placeholder                          | ✅ dormant, no reachable change                                                           |
| `agent-config`, `canvas-preview`, `start`, `github-issue-detail`, `github-pr-detail` | already routed via `default → UnifiedTabContent` today            | respective renderers                                    | ✅ unchanged                                                                              |

---

## Risks / unknowns

1. **`directory` regression (must fix, above).** If the registry remap is skipped, directory tabs
   silently become "No workspace open" placeholders.
2. **`lint-scan` `repoPath` source differs.** `TabContentRenderer` passes the host's selected
   `repoPath`; `lintScan.tsx` reads `activeWorkspaceRootPathAtom`. Equal in single-repo workspaces;
   in a multi-root / worktree selection they can differ (selected repo vs. active workspace root).
   Decide intentionally: (a) accept the atom (workspace-wide scan is arguably more correct, and keeps
   the renderer host-independent — the staged author's choice), or (b) for strict parity, read
   `repoPath` from `useEditorHostContext()` in `lintScan.tsx` (couples it to the editor host — no
   other host renders `lint-scan`, so acceptable). Not a hard blocker either way; must be a conscious
   call.
3. **No runtime verification available.** The agent environment cannot launch the Tauri desktop app,
   so the ~22 tab types + the two keep-alive overlays are verified by reading only. Given the
   `directory` bug already slipped through the staging's exhaustiveness check, a human must click
   through the checklist — with special attention to:
   - Source-control: open SC → navigate to a file tab → back; diff view + scroll must survive
     (issue #16 keep-alive), and the SC overlay must sit above the (now `null`) dispatcher layer.
   - Terminal: running PTY survives tab switches (overlay keep-alive; dispatcher `terminal` case
     stays unreachable behind `!isTerminalTabActive`).
   - File editing: unsaved/dirty-diff baselines, deleted-file view, CSV dirty state — all depend on
     the **same live** `fileContentManager` instance flowing through context (it does).
4. **Suspense fallback nuance (cosmetic).** `TabContentRenderer` wraps each case in its own
   `<Suspense fallback={<LazyFallback/>}>`; `UnifiedTabContent` uses one outer
   `<Suspense fallback={<TabLoadingPlaceholder/>}>` (several renderers add an inner Suspense too).
   Both are loading placeholders; the chunk-load fallback visual can differ slightly. No functional
   impact.
5. **Component identity / remount parity.** Switching file→file keeps the same `FileTabRenderer` →
   `CodeViewerContent` instance (no `key`), matching the old switch; type changes remount, also
   matching. Verified by reading, but worth confirming no editor-state loss on rapid tab switches
   during manual testing.
6. **Header publishing is out of scope / unchanged.** Source-control header
   (`usePublishWorkstationTabHeader`) and `benchmark`'s `publishHeader` are driven outside the content
   swap; the swap does not touch them.

## Verification checklist (when landing)

- `npm run typecheck 2>&1 | grep -E "error TS" | grep -viE "ContextInfoButton"` → empty.
- `npx eslint --fix` on all changed/added files → clean.
- `npx vitest run src/modules/WorkStation/CodeEditor/Panels/EditorMainPane/content/__tests__/sourceControlMainProps.test.ts`
  and `.../EditorMainPane/__tests__/config.test.ts` → green (neither imports `TabContentRenderer`,
  so both should be unaffected).
- Manual pass over the per-tab-type table above, prioritizing items 3's overlays + `directory`.
