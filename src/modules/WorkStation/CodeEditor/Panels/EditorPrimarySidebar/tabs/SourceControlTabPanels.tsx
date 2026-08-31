/**
 * SourceControlTabPanels
 *
 * Internal panel components for the Source Control tab:
 * - SourceControlTabContent: shared connected pane for standalone and main-repo views
 * - SourceControlWithWorktrees: scoped host/worktree source control pane
 *
 * Extracted from SourceControlTab.tsx to keep it under 600 lines.
 * PERFORMANCE (Jan 2026): useSourceControlState only runs on first mount.
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import type { GitWorktreeEntry } from "@src/api/http/git/types";
import { repoApi } from "@src/api/tauri/repo";
import Message from "@src/components/Message";
import { Placeholder } from "@src/components/Placeholder";
import type { SourceControlHistorySelection } from "@src/store/workstation/tabs";
import type { GitFile } from "@src/types/git/types";

import SourceControlContent from "../content/SourceControlContent";
import {
  WorktreeSourceControlSection,
  type WorktreeSourceControlSectionHandle,
} from "../content/WorktreeSourceControlSection";
import { useSourceControlState } from "../hooks/useSourceControlState";
import {
  type SourceControlScope,
  normalizeScopePath,
  resolveScopeRepoRoot,
} from "./sourceControlScopePickerHelpers";
import {
  isScopeIdentityChanging,
  scopeIdentityKey,
  shouldShowScopePaneLoading,
} from "./sourceControlScopeSwitchHelpers";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SourceControlContentHandle {
  refresh: () => Promise<void>;
}

interface SourceControlContentProps {
  repoPath: string;
  repoId: string;
  onGitFileSelect?: (file: GitFile) => void;
  /**
   * Notified when this pane's file list changes. The optional
   * `scopeRepoRoot` identifies which repo reported the update — the
   * consumer can use it to scope a bulk replace and avoid wiping entries
   * contributed by sibling panes (e.g. worktrees alongside the host repo).
   */
  onGitFilesChange?: (files: GitFile[], scopeRepoRoot?: string) => void;
  onGitHistorySelectionChange?: (
    selection: SourceControlHistorySelection
  ) => void;
  showFilter: boolean;
  viewMode: "list-tree" | "list";
  showOnlyStashes?: boolean;
  navigateWithoutSelecting?: boolean;
  /** Working-tree section filter: "uncommitted" | "staged" | "unstaged". */
  sectionFilter?: "uncommitted" | "staged" | "unstaged";
  /** Notifies parent when git status loading state changes for this pane. */
  onLoadingChange?: (loading: boolean) => void;
  /** Parent scope-switch overlay owns loading UI for the changes area. */
  suppressLoadingPlaceholder?: boolean;
}

export function NotGitInitializedContent({
  repoPath,
  onInitialized,
}: {
  repoPath: string;
  onInitialized: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [initializing, setInitializing] = useState(false);

  const handleInitializeGit = useCallback(async () => {
    setInitializing(true);
    try {
      await repoApi.importLocalRepo({ fs_path: repoPath });
      await onInitialized();
    } catch (error) {
      Message.error(
        error instanceof Error ? error.message : t("errors.unexpectedError")
      );
    } finally {
      setInitializing(false);
    }
  }, [onInitialized, repoPath, t]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Placeholder
        variant={initializing ? "loading" : "empty"}
        placement="sidebar"
        title={
          initializing
            ? t("sourceControl.initializingGit")
            : t("sourceControl.notGitInitialized")
        }
        subtitle={
          initializing
            ? undefined
            : t("sourceControl.notGitInitializedSubtitle")
        }
        action={
          initializing
            ? undefined
            : {
                label: t("sourceControl.initializeGit"),
                onClick: handleInitializeGit,
                variant: "primary",
              }
        }
        fillParentHeight
      />
    </div>
  );
}

// ── SourceControlTabContent ───────────────────────────────────────────────────

export const SourceControlTabContent = forwardRef<
  SourceControlContentHandle,
  SourceControlContentProps
>(
  (
    {
      repoPath,
      repoId,
      onGitFileSelect,
      onGitFilesChange,
      onGitHistorySelectionChange,
      showFilter,
      viewMode,
      showOnlyStashes,
      navigateWithoutSelecting,
      sectionFilter,
      onLoadingChange,
      suppressLoadingPlaceholder,
    },
    ref
  ) => {
    const sourceControlState = useSourceControlState({
      repoPath,
      repoId,
      onGitFileSelect,
      autoLoadStashes: showOnlyStashes,
    });

    useEffect(() => {
      onLoadingChange?.(sourceControlState.loading);
    }, [onLoadingChange, sourceControlState.loading]);

    useEffect(() => {
      onGitFilesChange?.(sourceControlState.state.files, repoPath);
    }, [onGitFilesChange, sourceControlState.state.files, repoPath]);

    const refresh = useCallback(async () => {
      await sourceControlState.refresh();
    }, [sourceControlState]);

    const sourceControlFiles = sourceControlState.state.files;
    const selectSourceControlFile = sourceControlState.state.onFileSelect;

    const handleContentFileSelect = useCallback(
      (fileId: string) => {
        if (!navigateWithoutSelecting) {
          selectSourceControlFile(fileId);
          return;
        }
        const file = sourceControlFiles.find(
          (candidate) => candidate.id === fileId
        );
        if (file) {
          onGitFileSelect?.(file);
        }
      },
      [
        navigateWithoutSelecting,
        onGitFileSelect,
        selectSourceControlFile,
        sourceControlFiles,
      ]
    );

    useImperativeHandle(ref, () => ({ refresh }), [refresh]);

    return (
      <SourceControlContent
        repoId={repoId}
        repoPath={repoPath}
        files={sourceControlState.state.files}
        filteredFiles={sourceControlState.state.filteredFiles}
        selectedFileId={
          navigateWithoutSelecting
            ? ""
            : sourceControlState.state.selectedFileId
        }
        loading={sourceControlState.loading}
        error={sourceControlState.state.error}
        onFileSelect={handleContentFileSelect}
        onStageToggle={sourceControlState.state.onStageToggle}
        onDiscard={sourceControlState.state.onDiscard}
        onDiscardFiles={sourceControlState.state.onDiscardFiles}
        onStageAll={sourceControlState.state.onStageAll}
        onUnstageAll={sourceControlState.state.onUnstageAll}
        onDiscardAll={sourceControlState.state.onDiscardAll}
        onOpenChanges={sourceControlState.state.onOpenChanges}
        onOpenStagedChanges={sourceControlState.state.onOpenStagedChanges}
        commitMessage={sourceControlState.state.commitMessage}
        onCommitMessageChange={sourceControlState.state.onCommitMessageChange}
        onCommit={sourceControlState.state.onCommit}
        onCommitAndPush={sourceControlState.state.onCommitAndPush}
        onCommitAndPublish={sourceControlState.state.onCommitAndPublish}
        onCommitAndSync={sourceControlState.state.onCommitAndSync}
        onAmend={sourceControlState.state.onAmend}
        commitLoading={sourceControlState.state.commitLoading}
        generateCommitMessageLoading={
          sourceControlState.state.generateCommitMessageLoading
        }
        onGenerateCommitMessage={
          sourceControlState.state.onGenerateCommitMessage
        }
        stagedFilesCount={sourceControlState.state.stagedFilesCount}
        branchName={sourceControlState.state.branchName}
        searchQuery={sourceControlState.state.searchQuery}
        onSearchChange={sourceControlState.state.onSearchChange}
        showFilter={showFilter}
        viewMode={viewMode}
        showOnlyStashes={showOnlyStashes}
        sectionFilter={sectionFilter}
        navigateWithoutSelecting={navigateWithoutSelecting}
        conflictFiles={sourceControlState.state.conflictFiles}
        hasConflicts={sourceControlState.state.hasConflicts}
        onStageResolved={sourceControlState.state.onStageResolved}
        isMerging={sourceControlState.state.isMerging}
        mergingBranch={sourceControlState.state.mergingBranch}
        onContinueMerge={sourceControlState.state.onContinueMerge}
        stashes={sourceControlState.state.stashes}
        stashOperationLoading={sourceControlState.state.stashOperationLoading}
        hasChangesToStash={sourceControlState.state.hasChangesToStash}
        onStashPush={sourceControlState.state.onStashPush}
        onStashApply={sourceControlState.state.onStashApply}
        onStashPop={sourceControlState.state.onStashPop}
        onStashDrop={sourceControlState.state.onStashDrop}
        onHistorySelectionChange={onGitHistorySelectionChange}
        ahead={sourceControlState.state.ahead}
        behind={sourceControlState.state.behind}
        onSync={sourceControlState.state.onSync}
        syncLoading={sourceControlState.state.syncLoading}
        onPull={sourceControlState.state.onPull}
        pullLoading={sourceControlState.state.pullLoading}
        onPush={sourceControlState.state.onPush}
        pushLoading={sourceControlState.state.pushLoading}
        onFetch={sourceControlState.state.onFetch}
        fetchLoading={sourceControlState.state.fetchLoading}
        hasUpstream={sourceControlState.state.hasUpstream}
        onPublish={sourceControlState.state.onPublish}
        publishLoading={sourceControlState.state.publishLoading}
        onRefresh={refresh}
        suppressLoadingPlaceholder={suppressLoadingPlaceholder}
      />
    );
  }
);

SourceControlTabContent.displayName = "SourceControlTabContent";

// ── SourceControlWithWorktrees ────────────────────────────────────────────────

interface SourceControlWithWorktreesProps {
  repoPath: string;
  repoId: string;
  worktrees: GitWorktreeEntry[];
  worktreesLoading?: boolean;
  scope: SourceControlScope;
  onGitFileSelect?: (file: GitFile) => void;
  /**
   * Notified whenever the file list of any pane (host or worktree) changes.
   * `scopeRepoRoot` identifies which pane fired so the consumer can scope a
   * bulk replace to that repo only.
   */
  onGitFilesChange?: (files: GitFile[], scopeRepoRoot?: string) => void;
  onGitHistorySelectionChange?: (
    selection: SourceControlHistorySelection
  ) => void;
  showFilter: boolean;
  viewMode: "list-tree" | "list";
  showOnlyStashes?: boolean;
  navigateWithoutSelecting?: boolean;
  /** Working-tree section filter forwarded to every (sub)pane. */
  sectionFilter?: "uncommitted" | "staged" | "unstaged";
}

export const SourceControlWithWorktrees = forwardRef<
  SourceControlContentHandle,
  SourceControlWithWorktreesProps
>(
  (
    {
      repoPath,
      repoId,
      worktrees,
      worktreesLoading = false,
      scope,
      onGitFileSelect,
      onGitFilesChange,
      onGitHistorySelectionChange,
      showFilter,
      viewMode,
      showOnlyStashes,
      navigateWithoutSelecting,
      sectionFilter,
    },
    ref
  ) => {
    const { t } = useTranslation();
    const handleWorktreeFilesChange = useCallback(
      (files: GitFile[], worktreePath: string) => {
        onGitFilesChange?.(files, worktreePath);
      },
      [onGitFilesChange]
    );

    const selectedWorktree =
      scope.kind === "worktree"
        ? worktrees.find(
            (worktree) =>
              normalizeScopePath(worktree.path) ===
              normalizeScopePath(scope.path)
          )
        : undefined;
    const pendingWorktreeScope =
      scope.kind === "worktree" && !selectedWorktree && worktreesLoading;

    const scopeKey = scopeIdentityKey(scope);
    const [trackedScopeKey, setTrackedScopeKey] = useState(scopeKey);
    const scopeIdentityChanging = isScopeIdentityChanging(
      trackedScopeKey,
      scopeKey
    );
    const [paneLoading, setPaneLoading] = useState(true);
    const activeScopeRepoRoot = resolveScopeRepoRoot(scope, repoPath);

    if (scopeIdentityChanging) {
      setTrackedScopeKey(scopeKey);
      setPaneLoading(true);
    }

    const previousScopeKeyForClearRef = useRef(scopeKey);
    useLayoutEffect(() => {
      if (previousScopeKeyForClearRef.current === scopeKey) {
        return;
      }
      previousScopeKeyForClearRef.current = scopeKey;
      onGitFilesChange?.([], activeScopeRepoRoot);
    }, [activeScopeRepoRoot, onGitFilesChange, scopeKey]);

    const handlePaneLoadingChange = useCallback((loading: boolean) => {
      setPaneLoading(loading);
    }, []);

    const showScopePaneLoading = shouldShowScopePaneLoading({
      pendingWorktreeScope,
      scopeIdentityChanging,
      paneLoading,
    });

    const mainRef = useRef<SourceControlContentHandle>(null);
    const worktreeRef = useRef<WorktreeSourceControlSectionHandle>(null);

    useImperativeHandle(
      ref,
      () => ({
        refresh: async () => {
          if (selectedWorktree) {
            await worktreeRef.current?.refresh();
            return;
          }
          await mainRef.current?.refresh();
        },
      }),
      [selectedWorktree]
    );

    if (pendingWorktreeScope) {
      return (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <Placeholder
            variant="loading"
            placement="sidebar"
            title={t("placeholders.loadingChanges")}
            fillParentHeight
          />
        </div>
      );
    }

    return (
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        {showScopePaneLoading ? (
          <div className="bg-surface-1 absolute inset-0 z-10 flex min-h-0 flex-col">
            <Placeholder
              variant="loading"
              placement="sidebar"
              title={t("placeholders.loadingChanges")}
              fillParentHeight
            />
          </div>
        ) : null}
        {selectedWorktree ? (
          <WorktreeSourceControlSection
            key={scopeKey}
            ref={worktreeRef}
            worktreePath={selectedWorktree.path}
            hostRepoId={repoId}
            onGitFileSelect={onGitFileSelect}
            onGitFilesChange={handleWorktreeFilesChange}
            onLoadingChange={handlePaneLoadingChange}
            suppressLoadingPlaceholder={showScopePaneLoading}
            showFilter={showFilter}
            viewMode={viewMode}
            navigateWithoutSelecting={navigateWithoutSelecting}
            sectionFilter={sectionFilter}
          />
        ) : (
          <SourceControlTabContent
            key={scopeKey}
            ref={mainRef}
            repoPath={repoPath}
            repoId={repoId}
            onGitFileSelect={onGitFileSelect}
            onGitFilesChange={onGitFilesChange}
            onGitHistorySelectionChange={onGitHistorySelectionChange}
            onLoadingChange={handlePaneLoadingChange}
            suppressLoadingPlaceholder={showScopePaneLoading}
            showFilter={showFilter}
            viewMode={viewMode}
            showOnlyStashes={showOnlyStashes}
            navigateWithoutSelecting={navigateWithoutSelecting}
            sectionFilter={sectionFilter}
          />
        )}
      </div>
    );
  }
);

SourceControlWithWorktrees.displayName = "SourceControlWithWorktrees";
