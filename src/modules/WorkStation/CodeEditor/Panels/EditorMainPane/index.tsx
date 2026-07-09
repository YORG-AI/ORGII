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
import { useAtomValue, useSetAtom } from "jotai";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  CircleDot,
  ExternalLink,
  ListChevronsDownUp,
} from "lucide-react";
import React, {
  Suspense,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { useActionSystem } from "@src/ActionSystem";
import Button from "@src/components/Button";
import Select from "@src/components/Select";
import type { SelectOption } from "@src/components/Select";
import TabPill from "@src/components/TabPill";
import { useGitStatus } from "@src/contexts/git";
import {
  usePublishWorkstationTabHeader,
  useWorkStationTabShortcutBridge,
} from "@src/hooks/workStation";
import {
  NoTabsPlaceholder,
  TabBarBottomPanelToggle,
} from "@src/modules/WorkStation/shared";
import { HEADER_ICON_SIZE } from "@src/modules/WorkStation/shared/tokens";
import { useStickyMount } from "@src/modules/shared/hooks/useStickyMount";
import { workStationPrimarySidebarCollapsedAtom } from "@src/store/ui/workStationAtom";
import { gitReviewNavigationAtom } from "@src/store/workstation/codeEditor/gitReviewNavigationAtom";
import {
  SOURCE_CONTROL_ALL_SESSIONS_FILTER,
  sourceControlSessionFilterAtom,
} from "@src/store/workstation/codeEditor/sourceControlSessionFilterAtom";
import { workstationSelectedIssueAtom } from "@src/store/workstation/codeEditor/workstationIssueAtom";
import {
  type SourceControlHistorySelection,
  createGitCommitDetailTab,
  createStashDetailTab,
} from "@src/store/workstation/tabs";
import type { GitFile } from "@src/types/git/types";

import { CodeEditorDefaultHeader } from "./components/CodeEditorDefaultHeader";
import { createEditorQuickActions } from "./config";
import { TabContentRenderer } from "./content";
import SourceControlMainPane from "./content/SourceControlMainPane";
import type { SourceControlMainTabData } from "./content/sourceControlMainProps";
import {
  SOURCE_CONTROL_OTHER_SESSIONS_FILTER,
  useEditorPaneState,
  useFileContentManager,
  useSourceControlSessionAttribution,
  useTabContentSync,
} from "./hooks";
import "./index.scss";
import type { EditorContentProps } from "./types";

const TerminalMainContent = React.lazy(
  () => import("./content/TerminalMainContent")
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
    onDiagnosticsChange,
    onCursorPositionChange,
    terminalState,
    sourceControlHeaderLeadingSlot,
    sourceControlHeaderTrailingSlot,
    sourceControlFilterMode = "uncommitted",
    showSourceControlModePill = true,
  }) => {
    // ============================================
    // External Hooks
    // ============================================

    const { t } = useTranslation();
    const { dispatch } = useActionSystem();
    const { forceRefresh } = useGitStatus();
    const sourceControlSessionFilter = useAtomValue(
      sourceControlSessionFilterAtom
    );
    const selectedIssueState = useAtomValue(workstationSelectedIssueAtom);
    const setSourceControlSessionFilter = useSetAtom(
      sourceControlSessionFilterAtom
    );

    // ============================================
    // File Content Manager (extracted hook)
    // ============================================

    // We need activeFilePath first, so get pane state to determine it
    const paneStateForPath = useEditorPaneState();
    const activeFilePath = useMemo(() => {
      if (paneStateForPath.activeTab?.type === "file") {
        return paneStateForPath.activeTab.data.filePath as string;
      }
      return null;
    }, [paneStateForPath.activeTab]);

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

    // Refs for pane state hook (needed for save-on-close)
    const fileContentStateRef = useRef(fileContentManager);
    const forceRefreshRef = useRef(forceRefresh);

    // Update refs in effect (not during render)
    useEffect(() => {
      fileContentStateRef.current = fileContentManager;
      forceRefreshRef.current = forceRefresh;
    });

    // ============================================
    // Pane State Management (extracted hook)
    // ============================================

    const { tabs, activeTabId, activeTab, closeTab, updatePaneState } =
      useEditorPaneState(fileContentStateRef, forceRefreshRef);
    const isTerminalTabActive = activeTab?.type === "terminal";
    const isSourceControlActive = activeTab?.type === "source-control";

    // The Source Control tab is pinned, so this is normally always present. We
    // drive the keep-alive main pane from the persisted tab (not `activeTab`)
    // so its diff/scroll survive navigating to a file tab and back (issue #16).
    const sourceControlTab = useMemo(
      () => tabs.find((tab) => tab.type === "source-control") ?? null,
      [tabs]
    );

    // Mount the keep-alive Source Control pane lazily — only after the user has
    // opened it at least once — so users who never touch Source Control don't
    // pay the heavy chunk's parse/render cost. Once visited it stays mounted.
    const hasVisitedSourceControl = useStickyMount(isSourceControlActive);

    // Computed whenever the Source Control pane is (or has been) mounted so the
    // attributed file list stays populated while the pane is hidden — otherwise
    // returning to it would flash empty and reset scroll.
    const sourceControlBaseFiles = useMemo(() => {
      if (!sourceControlTab) return [];
      if (!isSourceControlActive && !hasVisitedSourceControl) return [];
      const gitStatusFiles = Array.from(gitFilesByPath.values());
      if (gitStatusFiles.length > 0) return gitStatusFiles;
      return (sourceControlTab.data.files ?? []) as GitFile[];
    }, [
      sourceControlTab,
      isSourceControlActive,
      hasVisitedSourceControl,
      gitFilesByPath,
    ]);

    const {
      attributedFiles: sourceControlAttributedFiles,
      sessionOptions: sourceControlAttributedSessionOptions,
      otherCount: sourceControlOtherCount,
    } = useSourceControlSessionAttribution({
      files: sourceControlBaseFiles,
      repoPath,
    });

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

    const handleGitDiffUnsavedChange = useCallback(
      (hasUnsaved: boolean) => {
        updatePaneState((state) => {
          const currentId = activeTabId;
          if (!currentId) return state;
          const targetTab = state.tabs.find((tab) => tab.id === currentId);
          if (!targetTab) return state;
          if (
            targetTab.type !== "git-diff" &&
            targetTab.type !== "source-control"
          ) {
            return state;
          }
          if (targetTab.hasUnsavedChanges === hasUnsaved) return state;
          return {
            ...state,
            tabs: state.tabs.map((tab) =>
              tab.id === currentId
                ? { ...tab, hasUnsavedChanges: hasUnsaved }
                : tab
            ),
          };
        });
      },
      [updatePaneState, activeTabId]
    );

    const handleBinaryUnsavedChange = useCallback(
      (hasUnsaved: boolean) => {
        updatePaneState((state) => {
          const currentId = activeTabId;
          if (!currentId) return state;
          const targetTab = state.tabs.find((tab) => tab.id === currentId);
          if (!targetTab || targetTab.type !== "file") return state;
          if (targetTab.hasUnsavedChanges === hasUnsaved) return state;
          return {
            ...state,
            tabs: state.tabs.map((tab) =>
              tab.id === currentId
                ? { ...tab, hasUnsavedChanges: hasUnsaved }
                : tab
            ),
          };
        });
      },
      [activeTabId, updatePaneState]
    );

    const [sourceControlCollapseAllSignal, setSourceControlCollapseAllSignal] =
      useState(0);

    const handleSourceControlModeChange = useCallback(
      (mode: "focus" | "all-changes") => {
        updatePaneState((state) => {
          const tabIndex = state.tabs.findIndex(
            (item) => item.type === "source-control"
          );
          if (tabIndex === -1) return state;
          const existing = state.tabs[tabIndex];
          if (existing.data.mode === mode && !existing.data.historySelection) {
            return state;
          }
          const nextTabs = [...state.tabs];
          nextTabs[tabIndex] = {
            ...existing,
            data: {
              ...existing.data,
              mode,
              historySelection: null,
            },
          };
          return { ...state, tabs: nextTabs };
        });
      },
      [updatePaneState]
    );

    const handleSourceControlCollapseAll = useCallback(() => {
      setSourceControlCollapseAllSignal((prev) => prev + 1);
    }, []);

    const gitReviewNavigation = useAtomValue(gitReviewNavigationAtom);

    const handleReviewPrevFile = useCallback(() => {
      document.dispatchEvent(new CustomEvent("review-prev-file"));
    }, []);

    const handleReviewNextFile = useCallback(() => {
      document.dispatchEvent(new CustomEvent("review-next-file"));
    }, []);

    const sourceControlSessionOptions = useMemo<SelectOption[]>(() => {
      const formatLabelWithCount = (label: string, count: number) =>
        `${label} (${count})`;
      const allSessionsLabel = t("sourceControl.sessionFilter.allSessions");
      const otherLabel = t("dashboard.other");
      const attributedCount = sourceControlAttributedSessionOptions.reduce(
        (total, option) => total + option.count,
        0
      );
      const totalCount = attributedCount + sourceControlOtherCount;

      return [
        {
          value: SOURCE_CONTROL_ALL_SESSIONS_FILTER,
          label: (
            <span className="whitespace-nowrap">
              {formatLabelWithCount(allSessionsLabel, totalCount)}
            </span>
          ),
          triggerLabel: formatLabelWithCount(allSessionsLabel, totalCount),
        },
        ...sourceControlAttributedSessionOptions.map((option) => ({
          value: option.sessionId,
          label: (
            <span className="whitespace-nowrap">
              {formatLabelWithCount(option.label, option.count)}
            </span>
          ),
          triggerLabel: formatLabelWithCount(option.label, option.count),
        })),
        ...(sourceControlOtherCount > 0
          ? [
              {
                value: SOURCE_CONTROL_OTHER_SESSIONS_FILTER,
                label: (
                  <span className="whitespace-nowrap">
                    {formatLabelWithCount(otherLabel, sourceControlOtherCount)}
                  </span>
                ),
                triggerLabel: formatLabelWithCount(
                  otherLabel,
                  sourceControlOtherCount
                ),
              },
            ]
          : []),
      ];
    }, [sourceControlAttributedSessionOptions, sourceControlOtherCount, t]);

    useEffect(() => {
      if (
        sourceControlSessionFilter === SOURCE_CONTROL_ALL_SESSIONS_FILTER ||
        sourceControlSessionOptions.some(
          (option) => option.value === sourceControlSessionFilter
        )
      ) {
        return;
      }
      setSourceControlSessionFilter(SOURCE_CONTROL_ALL_SESSIONS_FILTER);
    }, [
      setSourceControlSessionFilter,
      sourceControlSessionFilter,
      sourceControlSessionOptions,
    ]);

    const handleSourceControlSessionFilterChange = useCallback(
      (nextValue: string | number | (string | number)[]) => {
        if (Array.isArray(nextValue)) return;
        setSourceControlSessionFilter(String(nextValue));
      },
      [setSourceControlSessionFilter]
    );

    const handleOpenSourceControlHistoryInNewTab = useCallback(
      (selection: SourceControlHistorySelection) => {
        if (selection.type === "pr" || selection.type === "issue") return;

        const nextTab =
          selection.type === "stash"
            ? createStashDetailTab(
                selection.stashIndex,
                selection.commitMessage,
                selection.stashCommitSha
              )
            : createGitCommitDetailTab(
                selection.commitSha,
                selection.shortSha,
                selection.commitMessage
              );

        updatePaneState((state) => {
          const existing = state.tabs.find((tab) => tab.id === nextTab.id);
          const tabs = existing ? state.tabs : [...state.tabs, nextTab];
          return { ...state, tabs, activeTabId: nextTab.id };
        });
      },
      [updatePaneState]
    );

    const sourceControlHeaderContent = useMemo(() => {
      if (activeTab?.type !== "source-control") return null;
      const hasFocusPath = Boolean(activeTab.data.focusPath);
      const mode =
        activeTab.data.mode === "all-changes" ? "all-changes" : "focus";
      const historySelection = activeTab.data.historySelection as
        | SourceControlHistorySelection
        | null
        | undefined;
      const isIssuesMode = sourceControlFilterMode === "issues";
      const showModePill =
        showSourceControlModePill && !isIssuesMode && !historySelection;
      const sourceControlModeTabs = [
        { key: "focus", label: t("sourceControl.pill.focus") },
        {
          key: "all-changes",
          label: t("sourceControl.pill.allChanges"),
        },
      ];
      const showCollapseAll =
        showModePill && mode === "all-changes" && !historySelection;
      const showReviewNavigation =
        showModePill &&
        mode === "focus" &&
        !historySelection &&
        hasFocusPath &&
        gitReviewNavigation.total > 0;
      const selectedIssue = selectedIssueState.issue;
      const showIssueHeader = isIssuesMode && selectedIssue;
      return (
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          {sourceControlHeaderLeadingSlot}
          {sourceControlHeaderLeadingSlot && sourceControlHeaderTrailingSlot ? (
            <span
              className="pointer-events-none mx-0.5 h-4 w-px shrink-0 bg-border-2"
              aria-hidden
            />
          ) : null}
          {sourceControlHeaderTrailingSlot}
          {showIssueHeader && (
            <div className="flex min-w-0 flex-1 items-center gap-2 pl-1">
              <span
                className={`shrink-0 ${selectedIssue.state === "open" ? "text-success-6" : "text-text-3"}`}
              >
                <CircleDot size={HEADER_ICON_SIZE.sm} strokeWidth={2} />
              </span>
              <span className="shrink-0 font-mono text-[11px] text-text-3">
                #{selectedIssue.number}
              </span>
              <span
                className="min-w-0 flex-1 truncate text-[13px] font-medium text-text-1"
                title={selectedIssue.title}
              >
                {selectedIssue.title}
              </span>
            </div>
          )}
          {showModePill && (
            <>
              <span
                className="pointer-events-none mx-1.5 h-4 w-px shrink-0 bg-border-2"
                aria-hidden
              />
              <TabPill
                activeTab={mode}
                tabs={sourceControlModeTabs}
                onChange={(key) =>
                  handleSourceControlModeChange(key as "focus" | "all-changes")
                }
                variant="pill"
                color="fill"
                fillWidth={false}
                size="small"
              />
            </>
          )}

          <span className="ml-auto flex h-7 flex-shrink-0 items-center gap-px">
            {showIssueHeader && (
              <a
                href={selectedIssue.html_url}
                target="_blank"
                rel="noreferrer"
                className="flex h-7 w-7 items-center justify-center rounded text-text-3 transition-colors hover:bg-fill-2 hover:text-text-1"
                title={t("common:actions.openOnGitHub", "Open on GitHub")}
                onClick={(e) => e.stopPropagation()}
              >
                <ExternalLink size={HEADER_ICON_SIZE.sm} />
              </a>
            )}
            {historySelection &&
              (historySelection.type === "commit" ||
                historySelection.type === "stash") && (
                <Button
                  htmlType="button"
                  variant="tertiary"
                  size="small"
                  iconOnly
                  className="flex-shrink-0"
                  onClick={() =>
                    handleOpenSourceControlHistoryInNewTab(historySelection)
                  }
                  title={t("common:actions.openInNewTab")}
                  icon={<ArrowUpRight size={HEADER_ICON_SIZE.sm} />}
                />
              )}

            {showReviewNavigation && (
              <>
                <Button
                  htmlType="button"
                  variant="tertiary"
                  size="small"
                  iconOnly
                  onClick={handleReviewPrevFile}
                  title={t("common:actions.reviewPreviousFile")}
                  aria-label={t("common:actions.reviewPreviousFile")}
                  className="shrink-0"
                  icon={
                    <ArrowLeft size={HEADER_ICON_SIZE.sm} strokeWidth={1.75} />
                  }
                />
                <Button
                  htmlType="button"
                  variant="tertiary"
                  size="small"
                  iconOnly
                  onClick={handleReviewNextFile}
                  title={t("common:actions.reviewNextFile")}
                  aria-label={t("common:actions.reviewNextFile")}
                  className="shrink-0"
                  icon={
                    <ArrowRight size={HEADER_ICON_SIZE.sm} strokeWidth={1.75} />
                  }
                />
              </>
            )}

            {showCollapseAll &&
              sourceControlFilterMode === "uncommitted" &&
              sourceControlSessionOptions.length > 1 && (
                <>
                  <Select
                    value={sourceControlSessionFilter}
                    onChange={handleSourceControlSessionFilterChange}
                    options={sourceControlSessionOptions}
                    size="small"
                    variant="ghost"
                    radius="lg"
                    dropdownAlign="right"
                    dropdownWidthMode="auto"
                    className="w-auto max-w-[220px]"
                  />
                  <span
                    className="pointer-events-none mx-1 h-4 w-px shrink-0 bg-border-2"
                    aria-hidden
                  />
                </>
              )}

            {showCollapseAll && (
              <Button
                htmlType="button"
                variant="tertiary"
                size="small"
                iconOnly
                className="flex-shrink-0"
                onClick={handleSourceControlCollapseAll}
                title={t("actions.collapseAll")}
                icon={<ListChevronsDownUp size={HEADER_ICON_SIZE.md} />}
              />
            )}
            <TabBarBottomPanelToggle />
          </span>
        </div>
      );
    }, [
      activeTab,
      gitReviewNavigation.total,
      handleOpenSourceControlHistoryInNewTab,
      handleReviewNextFile,
      handleReviewPrevFile,
      handleSourceControlCollapseAll,
      handleSourceControlModeChange,
      handleSourceControlSessionFilterChange,
      selectedIssueState,
      showSourceControlModePill,
      sourceControlFilterMode,
      sourceControlHeaderLeadingSlot,
      sourceControlHeaderTrailingSlot,
      sourceControlSessionFilter,
      sourceControlSessionOptions,
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
                <NoTabsPlaceholder icon="editor" actions={editorQuickActions} />
              ) : (
                <TabContentRenderer
                  activeTab={activeTab}
                  repoPath={repoPath}
                  repoId={repoId ?? null}
                  fileContentState={fileContentManager}
                  gitFilesByPath={gitFilesByPath}
                  sourceControlAttributedFiles={sourceControlAttributedFiles}
                  gitDiffLoading={gitDiffLoading}
                  forceRefresh={forceRefresh}
                  onFileSelect={onFileSelect}
                  onFileSelectWithLine={onFileSelectWithLine}
                  onDiagnosticsChange={onDiagnosticsChange}
                  onCursorPositionChange={onCursorPositionChange}
                  onSearchTabTitleChange={handleSearchTabTitleChange}
                  onGitDiffUnsavedChange={handleGitDiffUnsavedChange}
                  onBinaryUnsavedChange={handleBinaryUnsavedChange}
                  sourceControlCollapseAllSignal={
                    sourceControlCollapseAllSignal
                  }
                  sourceControlFilterMode={sourceControlFilterMode}
                  terminalState={terminalState}
                  editorQuickActions={editorQuickActions}
                />
              )}
            </div>
          )}

          {/*
            Keep-alive Source Control main pane. Mounted once the tab has been
            visited, then shown/hidden (instead of unmounted) so the diff view,
            scroll position, and lazy chunk survive navigating to a file tab and
            back. Sits above the TabContentRenderer layer when active; the
            `source-control` case in TabContentRenderer is a no-op so this owns
            the rendering. (Issue #16)
          */}
          {hasVisitedSourceControl && sourceControlTab && (
            <div
              className={`absolute inset-0 flex min-h-0 flex-col ${
                isSourceControlActive && !isTerminalTabActive
                  ? "z-20 opacity-100"
                  : "pointer-events-none z-0 opacity-0"
              }`}
              aria-hidden={!(isSourceControlActive && !isTerminalTabActive)}
            >
              <SourceControlMainPane
                tabData={sourceControlTab.data as SourceControlMainTabData}
                repoPath={repoPath}
                repoId={repoId ?? null}
                gitFilesByPath={gitFilesByPath}
                sourceControlAttributedFiles={sourceControlAttributedFiles}
                sourceControlFilterMode={sourceControlFilterMode}
                gitDiffLoading={gitDiffLoading}
                sourceControlCollapseAllSignal={sourceControlCollapseAllSignal}
                editorQuickActions={editorQuickActions}
                onForceReload={forceRefresh}
                onFileSelect={onFileSelect}
                onGitDiffUnsavedChange={handleGitDiffUnsavedChange}
              />
            </div>
          )}
        </div>
      </div>
    );
  }
);

EditorContent.displayName = "EditorContent";

export default EditorContent;

// Re-export types for consumers
export type { EditorContentProps } from "./types";
