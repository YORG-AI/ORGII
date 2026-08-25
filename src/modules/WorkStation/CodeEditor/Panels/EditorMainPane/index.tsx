/**
 * EditorContent Component
 *
 * Main content area with tabs for different view types:
 * - File editor
 * - Git diff viewer
 * - Terminal
 * - Output channels
 * - Debug console
 *
 * Architecture:
 * - TabBar is owned by AppShell (`WorkstationTabBar`).
 * - Content components (CodeViewerContent, GitDiffContent) render below
 * - Uses extracted hooks for state management and side effects
 *
 * Folder structure:
 * - content/     - Tab content renderers (CodeViewerContent, GitDiffContent, etc.)
 * - components/  - Shared subcomponents
 * - hooks/       - Extracted hooks (useEditorPaneState, useFileContentManager, etc.)
 * - types.ts     - TypeScript types
 * - config.ts    - Constants and configuration
 */
import { useAtom, useAtomValue } from "jotai";
import React, {
  Suspense,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from "react";
import { useTranslation } from "react-i18next";

import { useActionSystem } from "@src/ActionSystem";
import { useGitStatus } from "@src/contexts/git";
import { useSourceControlAttention } from "@src/hooks/git/useSourceControlAttention";
import { useWorkStationTabShortcutBridge } from "@src/hooks/tabHost/useWorkStationTabShortcutBridge";
import { usePublishWorkstationTabHeader } from "@src/hooks/tabHost/useWorkstationTabHeader";
import UnifiedTabContent from "@src/modules/WorkStation/TabContent/UnifiedTabContent";
import { NoTabsPlaceholder } from "@src/modules/WorkStation/shared";
import { Placeholder } from "@src/modules/shared/layouts/blocks";
import { workStationPrimarySidebarCollapsedAtom } from "@src/store/ui/workStationAtom";
import { diffViewModeAtom } from "@src/store/workstation/codeEditor";
import { workstationSelectedIssueAtomFamily } from "@src/store/workstation/codeEditor/workstationIssueAtom";
import { workstationRepoScopeKey } from "@src/store/workstation/codeEditor/workstationPrAtom";
import type { GitFile } from "@src/types/git/types";

import { CodeEditorDefaultHeader } from "./components/CodeEditorDefaultHeader";
import { SourceControlHeaderContent } from "./components/SourceControlHeaderContent";
import { createEditorQuickActions } from "./config";
import type { SourceControlMainTabData } from "./content/sourceControlMainProps";
import {
  type EditorHostContextValue,
  EditorHostProvider,
} from "./context/editorHostContext";
import {
  type UseFileContentManagerReturn,
  useEditorPaneState,
  useFileContentManager,
  useSourceControlPaneActions,
  useTabContentSync,
  useUnsavedChangeHandlers,
} from "./hooks";
import "./index.scss";
import type { EditorContentProps } from "./types";

const TerminalMainContent = React.lazy(
  () => import("./content/TerminalMainContent")
);

// Empty read-only editor shown in the rare tabs-exist-but-activeTab-null window
// (see the `!activeTab` guard below). Mirrors the old TabContentRenderer's
// `!activeTab` branch.
const CodeViewerContent = React.lazy(
  () => import("./content/CodeViewerContent")
);
const SourceControlMainPane = React.lazy(
  () => import("./content/SourceControlMainPane")
);

/** Lightweight fallback shown while lazy chunks load */
const LazyFallback = () => (
  <Placeholder variant="loading" placement="detail-panel" fillParentHeight />
);

// ============================================
// Main Component
// ============================================

const EditorContent: React.FC<EditorContentProps> = memo(
  ({
    repoPath,
    repoId,
    repoDisplayName,
    gitFilesByPath,
    gitDiffLoading,
    onFileSelect,
    onFileSelectWithLine,
    onCursorPositionChange,
    terminalState,
    sourceControlHeaderLeadingSlot,
    sourceControlHeaderTrailingSlot,
    sourceControlFilterMode = "uncommitted",
    sourceControlActiveRepoRoot = repoPath,
    showSourceControlModePill = true,
  }) => {
    // ============================================
    // External Hooks
    // ============================================

    const { t } = useTranslation();
    const { dispatch } = useActionSystem();
    const { forceRefresh } = useGitStatus();
    const scopeKey = workstationRepoScopeKey(repoId, repoPath);
    const selectedIssueState = useAtomValue(
      workstationSelectedIssueAtomFamily(scopeKey)
    );
    const [diffViewMode, setDiffViewMode] = useAtom(diffViewModeAtom);

    // ============================================
    // Pane State Management (extracted hook)
    // ============================================

    // Refs for the pane state hook (needed for save-on-close). Declared ahead
    // of it so the hook is called exactly once: they are only dereferenced
    // inside closeTab's async body, never during render, so the effect below
    // populates them well before any user interaction can reach them.
    const fileContentStateRef = useRef<UseFileContentManagerReturn | null>(
      null
    );
    const forceRefreshRef = useRef(forceRefresh);

    const { tabs, activeTabId, activeTab, closeTab, updatePaneState } =
      useEditorPaneState(fileContentStateRef, forceRefreshRef);

    // ============================================
    // File Content Manager (extracted hook)
    // ============================================

    const activeFilePath = useMemo(() => {
      if (activeTab?.type === "file") {
        return activeTab.data.filePath as string;
      }
      return null;
    }, [activeTab]);

    const activeFileIsCsvTable = useMemo(() => {
      if (!activeFilePath) return false;
      const lowerPath = activeFilePath.toLowerCase();
      return lowerPath.endsWith(".csv") || lowerPath.endsWith(".tsv");
    }, [activeFilePath]);

    // File content manager with handlers
    const fileContentManager = useFileContentManager({
      activeFilePath,
      onSaveSuccess: forceRefresh,
    });

    // Update refs in effect (not during render)
    useEffect(() => {
      fileContentStateRef.current = fileContentManager;
      forceRefreshRef.current = forceRefresh;
    });

    const isTerminalTabActive = activeTab?.type === "terminal";
    const isSourceControlActive = activeTab?.type === "source-control";
    // While the Source Control page is on screen, the git watcher polls at
    // its fast interval; otherwise it relaxes to halve idle git load.
    useSourceControlAttention(isSourceControlActive);

    const sourceControlTab = isSourceControlActive ? activeTab : null;

    // Only build the All Changes input while Source Control is visible. Leaving
    // the tab unmounts its editors, content cache, and subscriptions.
    const sourceControlBaseFiles = useMemo(() => {
      if (!sourceControlTab) return [];
      const gitStatusFiles = Array.from(gitFilesByPath.values());
      if (gitStatusFiles.length > 0) return gitStatusFiles;
      return (sourceControlTab.data.files ?? []) as GitFile[];
    }, [sourceControlTab, gitFilesByPath]);

    // ============================================
    // Tab Content Sync (extracted hook - side effects only)
    // ============================================

    useTabContentSync({
      activeTab,
      hasUnsavedChanges:
        fileContentManager.isBinary || activeFileIsCsvTable
          ? activeTab?.hasUnsavedChanges === true ||
            fileContentManager.hasUnsavedChanges
          : fileContentManager.hasUnsavedChanges,
      fileLoading: fileContentManager.loading,
      fileContent: fileContentManager.content,
      updatePaneState,
    });

    // ============================================
    // Tab Handlers (use provided or default to internal)
    // ============================================

    const handleWorkStationCloseActiveEditorTab = useCallback(() => {
      if (activeTabId) void closeTab(activeTabId);
    }, [activeTabId, closeTab]);

    // Code Editor intentionally has no `onNewTab` handler: ⌘T has no
    // editor-specific meaning, and file lookup is owned by ⌘P (file
    // palette). In All-Tabs mode the unified `+` menu (TabBarPlusMenu)
    // claims ⌘T directly via its own `workstation-new-tab` listener.
    useWorkStationTabShortcutBridge({
      enabled: true,
      onCloseActiveTab: handleWorkStationCloseActiveEditorTab,
    });

    // ============================================
    // Tab Bar Handlers
    // ============================================

    const handleSearchTabTitleChange = useCallback(
      (tabId: string, query: string) => {
        const trimmedQuery = query.trim();
        const nextTitle = trimmedQuery ? `Search: ${trimmedQuery}` : "Search";

        updatePaneState((state) => {
          const tabs = state.tabs;
          const targetTab = tabs.find((tab) => tab.id === tabId);
          if (!targetTab || targetTab.title === nextTitle) {
            return state;
          }

          return {
            ...state,
            tabs: tabs.map((tab) =>
              tab.id === tabId ? { ...tab, title: nextTitle } : tab
            ),
          };
        });
      },
      [updatePaneState]
    );

    const { handleGitDiffUnsavedChange, handleBinaryUnsavedChange } =
      useUnsavedChangeHandlers({ activeTabId, updatePaneState });

    // ============================================
    // Source Control actions (extracted hook)
    // ============================================

    const {
      sourceControlRefreshSpinClass,
      handleSourceControlRefresh,
      sourceControlCollapseAllSignal,
      handleSourceControlModeChange,
      handleSourceControlCollapseAll,
      handleSourceControlCloseFocus,
      gitReviewNavigation,
      handleReviewPrevFile,
      handleReviewNextFile,
      handleOpenSourceControlHistoryInNewTab,
      sourceControlQuickActions,
    } = useSourceControlPaneActions({
      t,
      updatePaneState,
      forceRefresh,
      gitDiffLoading,
      sourceControlFilterMode,
    });

    // Memoized so `usePublishWorkstationTabHeader` sees a stable `content`
    // identity — a fresh element every render would re-publish the global
    // header slot on each pass.
    const sourceControlHeaderContent = useMemo(() => {
      if (activeTab?.type !== "source-control") return null;
      return (
        <SourceControlHeaderContent
          activeTab={activeTab}
          sourceControlFilterMode={sourceControlFilterMode}
          showSourceControlModePill={showSourceControlModePill}
          gitReviewNavigationTotal={gitReviewNavigation.total}
          selectedIssue={selectedIssueState.issue}
          sourceControlHeaderLeadingSlot={sourceControlHeaderLeadingSlot}
          sourceControlHeaderTrailingSlot={sourceControlHeaderTrailingSlot}
          sourceControlRefreshSpinClass={sourceControlRefreshSpinClass}
          diffViewMode={diffViewMode}
          t={t}
          onDiffViewModeChange={setDiffViewMode}
          onModeChange={handleSourceControlModeChange}
          onOpenHistoryInNewTab={handleOpenSourceControlHistoryInNewTab}
          onReviewPrevFile={handleReviewPrevFile}
          onReviewNextFile={handleReviewNextFile}
          onCollapseAll={handleSourceControlCollapseAll}
          onRefresh={handleSourceControlRefresh}
        />
      );
    }, [
      activeTab,
      diffViewMode,
      gitReviewNavigation.total,
      handleOpenSourceControlHistoryInNewTab,
      handleReviewNextFile,
      handleReviewPrevFile,
      handleSourceControlCollapseAll,
      handleSourceControlModeChange,
      handleSourceControlRefresh,
      selectedIssueState,
      showSourceControlModePill,
      sourceControlFilterMode,
      sourceControlHeaderLeadingSlot,
      sourceControlHeaderTrailingSlot,
      sourceControlRefreshSpinClass,
      setDiffViewMode,
      t,
    ]);

    usePublishWorkstationTabHeader({
      host: "code",
      content: sourceControlHeaderContent,
      enabled: activeTab?.type === "source-control",
    });

    const isExplorerHome = activeTab?.type === "explorer";

    // Panel state for dynamic quick action labels
    const sidebarCollapsed = useAtomValue(
      workStationPrimarySidebarCollapsedAtom
    );

    // Quick actions from config
    const editorQuickActions = useMemo(
      () =>
        createEditorQuickActions({
          t,
          dispatch,
          sidebarCollapsed,
        }),
      [t, dispatch, sidebarCollapsed]
    );

    // ============================================
    // Host context (Phase 2.4)
    // ============================================

    // Publish the exact 14-field prop bag `TabContentRenderer` receives so
    // editor tab renderers mounted through `UnifiedTabContent` can consume it
    // via `useEditorHostContext`. Sourced from the SAME live instances the host
    // already holds — `fileContentManager` (live file-content manager) and
    // `terminalState` (live PTY) are passed by reference, never recreated.
    const editorHostValue = useMemo<EditorHostContextValue>(
      () => ({
        fileContentState: fileContentManager,
        gitFilesByPath,
        gitDiffLoading,
        forceRefresh,
        onFileSelect,
        onFileSelectWithLine,
        onCursorPositionChange,
        onSearchTabTitleChange: handleSearchTabTitleChange,
        onGitDiffUnsavedChange: handleGitDiffUnsavedChange,
        onBinaryUnsavedChange: handleBinaryUnsavedChange,
        terminalState,
        repoPath,
        repoId: repoId ?? null,
      }),
      [
        fileContentManager,
        gitFilesByPath,
        gitDiffLoading,
        forceRefresh,
        onFileSelect,
        onFileSelectWithLine,
        onCursorPositionChange,
        handleSearchTabTitleChange,
        handleGitDiffUnsavedChange,
        handleBinaryUnsavedChange,
        terminalState,
        repoPath,
        repoId,
      ]
    );

    // ============================================
    // Render
    // ============================================

    const hasNoTabs = tabs.length === 0;
    const shouldMountTerminalContent = isTerminalTabActive;
    // Explorer is the pinned "home" tab — its main pane reuses the same
    // empty-state placeholder we show when there are no tabs at all, so the
    // user always sees the same per-app icon + shortcut hints when they
    // have no file open.
    const showAppPlaceholder = hasNoTabs || isExplorerHome;

    return (
      <EditorHostProvider value={editorHostValue}>
        <div className="code-editor-right-panel flex h-full w-full flex-col">
          <CodeEditorDefaultHeader
            enabled={isExplorerHome}
            repoDisplayName={repoDisplayName}
            activeFilePath={activeFilePath}
          />
          <div className="relative min-h-0 flex-1 overflow-hidden">
            {shouldMountTerminalContent && (
              <div
                className={`absolute inset-0 ${
                  isTerminalTabActive
                    ? "z-10 opacity-100"
                    : "pointer-events-none z-0 opacity-0"
                }`}
                aria-hidden={!isTerminalTabActive}
              >
                <Suspense fallback={null}>
                  <TerminalMainContent
                    terminalState={terminalState}
                    repoPath={repoPath}
                    onFileSelect={onFileSelect}
                    onFileSelectWithLine={onFileSelectWithLine}
                  />
                </Suspense>
              </div>
            )}

            {!isTerminalTabActive && (
              <div className="absolute inset-0 z-10 flex min-h-0 flex-col">
                {showAppPlaceholder ? (
                  <NoTabsPlaceholder
                    icon="editor"
                    actions={editorQuickActions}
                  />
                ) : activeTab ? (
                  <UnifiedTabContent tab={activeTab} paneId="main" isActive />
                ) : (
                  // Preserve TabContentRenderer's `!activeTab` branch: an empty
                  // read-only editor. `showAppPlaceholder` already covers
                  // `hasNoTabs`; this guards the rare tabs-exist-but-activeTab-null
                  // window so we don't render a blank pane.
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
                      onCursorPositionChange={onCursorPositionChange}
                    />
                  </Suspense>
                )}
              </div>
            )}

            {isSourceControlActive && sourceControlTab && (
              <div className="absolute inset-0 z-20 flex min-h-0 flex-col">
                <Suspense fallback={<LazyFallback />}>
                  <SourceControlMainPane
                    tabData={sourceControlTab.data as SourceControlMainTabData}
                    repoPath={repoPath}
                    repoId={repoId ?? null}
                    gitFilesByPath={gitFilesByPath}
                    sourceControlFiles={sourceControlBaseFiles}
                    sourceControlFilterMode={sourceControlFilterMode}
                    activeRepoRoot={sourceControlActiveRepoRoot}
                    gitDiffLoading={gitDiffLoading}
                    sourceControlCollapseAllSignal={
                      sourceControlCollapseAllSignal
                    }
                    sourceControlQuickActions={sourceControlQuickActions}
                    onForceReload={forceRefresh}
                    onFileSelect={onFileSelect}
                    onCloseFocus={handleSourceControlCloseFocus}
                    onGitDiffUnsavedChange={handleGitDiffUnsavedChange}
                  />
                </Suspense>
              </div>
            )}
          </div>
        </div>
      </EditorHostProvider>
    );
  }
);

EditorContent.displayName = "EditorContent";

export default EditorContent;

// Re-export types for consumers
export type { EditorContentProps } from "./types";
