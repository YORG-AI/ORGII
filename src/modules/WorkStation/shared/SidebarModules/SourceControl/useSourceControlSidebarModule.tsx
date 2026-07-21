/**
 * useSourceControlSidebarModule
 *
 * Self-contained Source Control sidebar tab. Owns its own filter state,
 * view-mode toggle, action button list, inner refs, and filter-mode dropdown
 * header (Uncommitted / Unstaged / Staged / Stashed / Git History).
 * Any sidebar (Code Editor, Control Tower peek, future tab-specific
 * sidebars) can mount it with just `repoPath` + `repoId`.
 *
 * Returns a `PrimarySidebarTab` ready to be passed to
 * `PrimarySidebarLayoutWithSections`.
 */
import { useAtomValue } from "jotai";
import { ArrowLeft, CircleDot, RefreshCw, RotateCcw } from "lucide-react";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import type { GitWorktreeEntry } from "@src/api/http/git/types";
import type { SectionHeaderAction } from "@src/components/TreePanelSidebar/types";
import { useGitStatus } from "@src/contexts/git";
import { sessionIdAtom } from "@src/engines/SessionCore";
import { useFileReviewBatchActions } from "@src/hooks/fileReview";
import { useRefreshSpin } from "@src/hooks/ui";
import {
  SectionFilterInput,
  makeSectionFilterAction,
} from "@src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/components/SectionFilterInput";
import {
  ICON_CONFIG,
  PANEL_CONSTANTS,
} from "@src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/config";
import { useSourceControlActions } from "@src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/hooks";
import { useSectionFilter } from "@src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/hooks/useSectionFilter";
import {
  type SourceControlTabHandle,
  useSourceControlTabConfig,
} from "@src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/tabs/SourceControlTab";
import type { PrimarySidebarTab } from "@src/modules/WorkStation/shared/PrimarySidebarLayout";
import { Placeholder } from "@src/modules/shared/layouts/blocks";
import { workstationIssueCallbackAtomFamily } from "@src/store/workstation/codeEditor/workstationIssueAtom";
import {
  workstationPrCallbackAtomFamily,
  workstationRepoScopeKey,
} from "@src/store/workstation/codeEditor/workstationPrAtom";
import type { SourceControlHistorySelection } from "@src/store/workstation/tabs";
import type { GitFile } from "@src/types/git/types";
import { confirmDestructiveAction } from "@src/util/dialogs/confirmDestructiveAction";

import type { SourceControlFilterMode } from "./SourceControlFilterHeader";

const HistoryRefreshIcon = ICON_CONFIG.refresh;
const GitHistoryContent = React.lazy(
  () =>
    import("@src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/content/GitHistoryContent")
);
const PullRequestContent = React.lazy(
  () =>
    import("@src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/content/PullRequestContent")
);
const IssuesContent = React.lazy(
  () =>
    import("@src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/content/IssuesContent")
);

const AlternateModeFallback = () => (
  <Placeholder variant="loading" placement="sidebar" fillParentHeight />
);

export interface UseSourceControlSidebarModuleOptions {
  repoPath: string;
  repoId: string;
  /** Current branch name, forwarded to PullRequestContent for display. */
  branchName?: string;
  /** Optional callback when a git file is clicked — opens diff tab in caller. */
  onGitFileSelect?: (file: GitFile) => void;
  /** Optional callback when a history node is selected for inline display. */
  onGitHistorySelectionChange?: (
    selection: SourceControlHistorySelection
  ) => void;
  /**
   * Optional callback when the sidebar's current git file list changes.
   * `scopeRepoRoot` identifies which pane reported the update (host repo or
   * a worktree path) so the consumer can scope a bulk replace.
   */
  onGitFilesChange?: (files: GitFile[], scopeRepoRoot?: string) => void;
  /** Multi-root workspace? (changes header layout to per-folder collapse rows.) */
  isMultiRoot?: boolean;
  /** Shared filter mode owned by the host header. */
  filterMode?: SourceControlFilterMode;
  onFilterModeChange?: (mode: SourceControlFilterMode) => void;
  /** Notify parent on row click without updating sidebar selection. */
  navigateWithoutSelecting?: boolean;
  /** Optional worktree list supplied by the host to avoid duplicate fetches. */
  worktrees?: GitWorktreeEntry[];
  hasWorktrees?: boolean;
  worktreesLoading?: boolean;
  refreshWorktrees?: () => Promise<void>;
}

export interface UseSourceControlSidebarModuleResult {
  /** Drop-in `PrimarySidebarTab` config (key, label, icon, sections). */
  tab: PrimarySidebarTab;
  /** Imperative handle for `refresh()` from outside (status-bar Sync button etc.). */
  ref: React.RefObject<SourceControlTabHandle | null>;
}

export function useSourceControlSidebarModule({
  repoPath,
  repoId,
  branchName,
  onGitFileSelect,
  onGitHistorySelectionChange,
  onGitFilesChange,
  isMultiRoot = false,
  filterMode: controlledFilterMode,
  onFilterModeChange,
  navigateWithoutSelecting = false,
  worktrees: hostWorktrees,
  hasWorktrees: hostHasWorktrees,
  worktreesLoading: hostWorktreesLoading,
  refreshWorktrees: hostRefreshWorktrees,
}: UseSourceControlSidebarModuleOptions): UseSourceControlSidebarModuleResult {
  const { t } = useTranslation();
  const sourceControlRef = useRef<SourceControlTabHandle>(null);
  const historyRefreshRef = useRef<(() => void) | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const [showFilter, setShowFilter] = useState(false);
  const [viewMode, setViewMode] = useState<"list-tree" | "list">("list-tree");
  const {
    isOpen: showPrFilter,
    query: prFilterQuery,
    setQuery: setPrFilterQuery,
    toggle: handleTogglePrFilter,
    clear: clearPrFilter,
  } = useSectionFilter();

  const {
    isOpen: showHistoryFilter,
    query: historyFilterQuery,
    setQuery: setHistoryFilterQuery,
    toggle: handleToggleHistoryFilter,
    clear: clearHistoryFilter,
  } = useSectionFilter();
  const filterMode = controlledFilterMode ?? "uncommitted";
  const isHistoryMode = filterMode === "history";
  const isPrMode = filterMode === "pr";
  const isIssuesMode = filterMode === "issues";
  // Narrow the working-tree section filter (drop stashed/history — those
  // are routed via showOnlyStashes / sourceControlContentOverride).
  const sectionFilter: "uncommitted" | "staged" | "unstaged" =
    filterMode === "staged" || filterMode === "unstaged"
      ? filterMode
      : "uncommitted";

  const handleToggleFilter = useCallback(() => {
    setShowFilter((prev) => !prev);
  }, []);

  const handleToggleViewMode = useCallback(() => {
    setViewMode((prev) => (prev === "list-tree" ? "list" : "list-tree"));
  }, []);
  const handleRefresh = useCallback(() => {
    sourceControlRef.current?.refresh();
  }, []);
  const handleHistoryRefreshReady = useCallback((refresh: () => void) => {
    historyRefreshRef.current = refresh;
  }, []);
  const handleHistoryRefresh = useCallback(() => {
    historyRefreshRef.current?.();
  }, []);

  const sourceControlActions = useSourceControlActions({
    showFilter,
    viewMode,
    onToggleFilter: handleToggleFilter,
    onToggleViewMode: handleToggleViewMode,
    onRefresh: handleRefresh,
  });

  const {
    spinClass: historyRefreshSpinClass,
    handleClick: handleHistoryRefreshClick,
  } = useRefreshSpin(handleHistoryRefresh, false);

  const historyActions = useMemo<SectionHeaderAction[]>(
    () => [
      makeSectionFilterAction({
        key: "history-filter",
        isOpen: showHistoryFilter,
        hasQuery: historyFilterQuery.length > 0,
        onToggle: handleToggleHistoryFilter,
        tooltip: t("common:actions.filter", "Filter"),
      }),
      {
        key: "refresh-git-history",
        icon: (
          <HistoryRefreshIcon
            size={PANEL_CONSTANTS.ACTION_ICON_SIZE}
            strokeWidth={PANEL_CONSTANTS.ACTION_ICON_STROKE}
            className={historyRefreshSpinClass}
          />
        ),
        tooltip: "",
        onClick: handleHistoryRefreshClick,
      },
    ],
    [
      showHistoryFilter,
      historyFilterQuery,
      handleToggleHistoryFilter,
      handleHistoryRefreshClick,
      historyRefreshSpinClass,
      t,
    ]
  );

  const globalSessionId = useAtomValue(sessionIdAtom);
  const { pendingCount, onUndoAll } =
    useFileReviewBatchActions(globalSessionId);
  const { forceRefresh: refreshGitStatus } = useGitStatus();
  const [isUndoingAll, setIsUndoingAll] = useState(false);

  const handleUndoAll = useCallback(async () => {
    const confirmed = await confirmDestructiveAction({
      title: t("common:actions.undoAll"),
      message: t("common:confirmation.undoAllChanges", {
        count: pendingCount,
      }),
      okLabel: t("common:actions.undoAll"),
      cancelLabel: t("common:actions.cancel"),
    });
    if (!confirmed) return;
    setIsUndoingAll(true);
    try {
      await onUndoAll();
      refreshGitStatus().catch(() => {});
    } finally {
      if (mountedRef.current) setIsUndoingAll(false);
    }
  }, [t, pendingCount, onUndoAll, refreshGitStatus]);

  const undoAllAction = useMemo<SectionHeaderAction>(
    () => ({
      key: "undo-all-changes",
      icon: (
        <RotateCcw
          size={PANEL_CONSTANTS.ACTION_ICON_SIZE}
          strokeWidth={PANEL_CONSTANTS.ACTION_ICON_STROKE}
        />
      ),
      tooltip: t("common:actions.undoAll"),
      onClick: handleUndoAll,
      forceVisible: true,
    }),
    [handleUndoAll, t]
  );

  const sourceControlActionsWithUndo = useMemo<SectionHeaderAction[]>(
    () =>
      pendingCount > 0 && !isUndoingAll
        ? [undoAllAction, ...sourceControlActions]
        : sourceControlActions,
    [pendingCount, isUndoingAll, undoAllAction, sourceControlActions]
  );

  const {
    isOpen: showIssuesFilter,
    query: issuesFilterQuery,
    setQuery: setIssuesFilterQuery,
    toggle: handleToggleIssuesFilter,
    clear: clearIssuesFilter,
  } = useSectionFilter();

  const scopeKey = workstationRepoScopeKey(repoId, repoPath);
  const issueCallbacks = useAtomValue(
    workstationIssueCallbackAtomFamily(scopeKey)
  );
  const handleIssuesRefresh = useCallback(() => {
    issueCallbacks.refreshIssues?.();
  }, [issueCallbacks]);
  const {
    spinClass: issuesRefreshSpinClass,
    handleClick: handleIssuesRefreshClick,
  } = useRefreshSpin(handleIssuesRefresh, false);
  const issueActions = useMemo<SectionHeaderAction[]>(
    () => [
      makeSectionFilterAction({
        key: "issues-filter",
        isOpen: showIssuesFilter,
        hasQuery: issuesFilterQuery.length > 0,
        onToggle: handleToggleIssuesFilter,
        tooltip: t("common:actions.filter", "Filter"),
      }),
      {
        key: "refresh-issues",
        icon: (
          <RefreshCw
            size={PANEL_CONSTANTS.ACTION_ICON_SIZE}
            strokeWidth={PANEL_CONSTANTS.ACTION_ICON_STROKE}
            className={issuesRefreshSpinClass}
          />
        ),
        tooltip: t("common:actions.refresh", "Refresh"),
        onClick: handleIssuesRefreshClick,
      },
      {
        key: "new-issue",
        icon: (
          <CircleDot
            size={PANEL_CONSTANTS.ACTION_ICON_SIZE}
            strokeWidth={PANEL_CONSTANTS.ACTION_ICON_STROKE}
          />
        ),
        tooltip: "New issue",
        onClick: () => {
          issueCallbacks.openNewIssueForm?.();
        },
      },
    ],
    [
      showIssuesFilter,
      issuesFilterQuery,
      handleToggleIssuesFilter,
      handleIssuesRefreshClick,
      issuesRefreshSpinClass,
      issueCallbacks,
      t,
    ]
  );

  const prCallbacks = useAtomValue(workstationPrCallbackAtomFamily(scopeKey));
  const handlePrRefresh = useCallback(() => {
    prCallbacks.refreshPrs?.();
  }, [prCallbacks]);
  const { spinClass: prRefreshSpinClass, handleClick: handlePrRefreshClick } =
    useRefreshSpin(handlePrRefresh, false);
  const prActions = useMemo<SectionHeaderAction[]>(
    () => [
      makeSectionFilterAction({
        key: "pr-filter",
        isOpen: showPrFilter,
        hasQuery: prFilterQuery.length > 0,
        onToggle: handleTogglePrFilter,
        tooltip: t("common:actions.filter", "Filter"),
      }),
      {
        key: "refresh-prs",
        icon: (
          <RefreshCw
            size={PANEL_CONSTANTS.ACTION_ICON_SIZE}
            strokeWidth={PANEL_CONSTANTS.ACTION_ICON_STROKE}
            className={prRefreshSpinClass}
          />
        ),
        tooltip: t("common:actions.refresh", "Refresh"),
        onClick: handlePrRefreshClick,
      },
    ],
    [
      showPrFilter,
      prFilterQuery,
      handleTogglePrFilter,
      handlePrRefreshClick,
      prRefreshSpinClass,
      t,
    ]
  );

  const actions = isHistoryMode
    ? historyActions
    : isPrMode
      ? prActions
      : isIssuesMode
        ? issueActions
        : sourceControlActionsWithUndo;
  const sectionLabel = isHistoryMode
    ? t("common:labels.gitHistory")
    : isPrMode
      ? t("common:labels.pullRequest", "Pull request")
      : isIssuesMode
        ? t("common:git.issues.title", "Issues")
        : t("tabs.sourceControl");
  const isAlternateMode = isPrMode || isHistoryMode || isIssuesMode;
  const sectionTitle = isAlternateMode ? (
    <button
      type="button"
      className="flex min-w-0 items-center gap-1.5 normal-case"
      onClick={() => onFilterModeChange?.("uncommitted")}
      aria-label={t("tabs.sourceControl")}
      title={t("tabs.sourceControl")}
    >
      <span className="flex h-5 w-5 shrink-0 items-center justify-center">
        <ArrowLeft size={14} className="text-text-3" />
      </span>
      <span className="truncate uppercase">{sectionLabel}</span>
    </button>
  ) : (
    sectionLabel
  );

  const historyContent = useMemo(
    () => (
      <div className="flex h-full min-h-0 flex-col">
        {showHistoryFilter && (
          <SectionFilterInput
            query={historyFilterQuery}
            onChange={setHistoryFilterQuery}
            onClose={clearHistoryFilter}
          />
        )}
        <React.Suspense fallback={<AlternateModeFallback />}>
          <GitHistoryContent
            repoPath={repoPath}
            repoId={repoId}
            viewMode="graph"
            onRefreshReady={handleHistoryRefreshReady}
            onHistorySelectionChange={onGitHistorySelectionChange}
            filterQuery={historyFilterQuery}
          />
        </React.Suspense>
      </div>
    ),
    [
      showHistoryFilter,
      historyFilterQuery,
      setHistoryFilterQuery,
      clearHistoryFilter,
      handleHistoryRefreshReady,
      onGitHistorySelectionChange,
      repoPath,
      repoId,
    ]
  );

  const prContent = useMemo(
    () => (
      <div className="flex h-full min-h-0 flex-col">
        {showPrFilter && (
          <SectionFilterInput
            query={prFilterQuery}
            onChange={setPrFilterQuery}
            onClose={clearPrFilter}
          />
        )}
        <React.Suspense fallback={<AlternateModeFallback />}>
          <PullRequestContent
            branchName={branchName}
            filterQuery={prFilterQuery}
            onHistorySelectionChange={onGitHistorySelectionChange}
            repoId={repoId}
            repoPath={repoPath}
          />
        </React.Suspense>
      </div>
    ),
    [
      showPrFilter,
      prFilterQuery,
      setPrFilterQuery,
      clearPrFilter,
      branchName,
      onGitHistorySelectionChange,
      repoId,
      repoPath,
    ]
  );

  const issuesContent = useMemo(
    () => (
      <div className="flex h-full min-h-0 flex-col">
        <React.Suspense fallback={<AlternateModeFallback />}>
          <IssuesContent
            repoPath={repoPath}
            repoId={repoId}
            branchName={branchName}
            showFilter={showIssuesFilter}
            filterQuery={issuesFilterQuery}
            onFilterQueryChange={setIssuesFilterQuery}
            onFilterClose={clearIssuesFilter}
          />
        </React.Suspense>
      </div>
    ),
    [
      repoPath,
      repoId,
      branchName,
      showIssuesFilter,
      issuesFilterQuery,
      setIssuesFilterQuery,
      clearIssuesFilter,
    ]
  );

  const tab = useSourceControlTabConfig({
    repoPath,
    repoId,
    branchName,
    onGitFileSelect,
    onGitFilesChange,
    onGitHistorySelectionChange,
    showFilter,
    viewMode,
    sourceControlRef,
    actions,
    isMultiRoot,
    showOnlyStashes: filterMode === "stashed",
    sectionFilter,
    navigateWithoutSelecting,
    worktrees: hostWorktrees,
    hasWorktrees: hostHasWorktrees,
    worktreesLoading: hostWorktreesLoading,
    refreshWorktrees: hostRefreshWorktrees,
    sourceControlTitleOverride: isAlternateMode ? sectionTitle : undefined,
    sourceControlCollapsible: !isAlternateMode,
    sourceControlContentOverride: isPrMode
      ? prContent
      : isHistoryMode
        ? historyContent
        : isIssuesMode
          ? issuesContent
          : undefined,
  });

  return useMemo(() => ({ tab, ref: sourceControlRef }), [tab]);
}
