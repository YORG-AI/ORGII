/**
 * useSourceControlState Hook
 *
 * Unified state management for Source Control panel.
 * Combines all git-related hooks into a single state object to avoid
 * duplicate state issues when rendering Changes and Commit sections separately.
 *
 * This hook should be called ONCE per Source Control instance, and its
 * state passed down to child components as props.
 */
import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { DetachedHeadDialog } from "@src/components/GitDialogs";
import { useGitStatus } from "@src/contexts/git";
import { useRepoSelection } from "@src/hooks/git/useRepoSelection";
import { useCommitForm } from "@src/modules/WorkStation/CodeEditor/hooks/sourceControl/useCommitForm";
import { useFileSelection } from "@src/modules/WorkStation/CodeEditor/hooks/sourceControl/useFileSelection";
import { useGitFiles } from "@src/modules/WorkStation/CodeEditor/hooks/sourceControl/useGitFiles";
import { gitAutoCreatePrAtom } from "@src/store/ui/editorSettingsAtom";
import { gitReviewNavigationAtom } from "@src/store/workstation/codeEditor/gitReviewNavigationAtom";
import { gitOutputIntegrationAtom } from "@src/store/workstation/codeEditor/outputIntegration";
import {
  workstationPrAtomFamily,
  workstationPrCallbackAtomFamily,
  workstationPrCommitMessageAtomFamily,
  workstationRepoScopeKey,
} from "@src/store/workstation/codeEditor/workstationPrAtom";

import { useStashState } from "../useStashState";
import type {
  SourceControlState,
  UseSourceControlStateOptions,
  UseSourceControlStateResult,
} from "./types";
import { useFileOperations } from "./useFileOperations";
import { useMergeRebaseState } from "./useMergeRebaseState";
import { useSyncOperations } from "./useSyncOperations";

export function useSourceControlState(
  options: UseSourceControlStateOptions
): UseSourceControlStateResult {
  const {
    repoPath,
    repoId,
    onGitFileSelect,
    autoLoadStashes = false,
  } = options;

  // Local state for file selection
  const [selectedFileId, setSelectedFileId] = useState<string>("");
  const prevRepoIdRef = useRef(repoId);
  const notifiedFileIdRef = useRef<string>("");
  const selectedFileIdRef = useRef(selectedFileId);

  // Track last refresh time
  const lastRefreshTimeRef = useRef<number | null>(null);
  const [lastRefreshTime, setLastRefreshTime] = useState<number | null>(null);

  // Get current repo selection
  const { selectedRepoId, currentBranch } = useRepoSelection({
    autoLoad: true,
  });

  // Get git output integration for streaming
  const gitOutputIntegration = useAtomValue(gitOutputIntegrationAtom);
  const setGitReviewNavigation = useSetAtom(gitReviewNavigationAtom);
  const scopeKey = workstationRepoScopeKey(selectedRepoId, repoPath);

  const { currentGitStatus: gitStatus } = useGitStatus();

  // Hook 1: Fetch git files
  const {
    files: gitFiles,
    setFiles: setGitFiles,
    loading: gitLoading,
    error: gitError,
    fetchGitStatus: originalFetchGitStatus,
  } = useGitFiles({
    selectedRepoId: selectedRepoId,
    repoPath,
    autoLoad: true,
  });

  // Keep refs in sync for stable event handlers
  const filesRef = useRef(gitFiles);
  useEffect(() => {
    filesRef.current = gitFiles;
    selectedFileIdRef.current = selectedFileId;
  }, [gitFiles, selectedFileId]);

  // Wrap fetchGitStatus to update refresh time
  const fetchGitStatus = useCallback(async () => {
    await originalFetchGitStatus();
    const now = Date.now();
    lastRefreshTimeRef.current = now;
    setLastRefreshTime(now);
  }, [originalFetchGitStatus]);

  // Diff content is owned by the rendered Focus or All Changes surface.
  // Keeping this sidebar hook metadata-only avoids duplicate full-body loads.

  // Hook 2: File selection and filtering
  const {
    searchQuery: gitSearchQuery,
    setSearchQuery: setGitSearchQuery,
    filteredFiles,
    selectedFile: selectedGitFile,
  } = useFileSelection({
    files: gitFiles,
    setFiles: setGitFiles,
    selectedFileId,
  });

  // Count staged files
  const stagedFilesCount = gitFiles.filter((file) => file.staged).length;

  // Hook 4: File operations
  const {
    handleStageToggle,
    handleDiscard,
    handleDiscardFiles,
    handleStageAll,
    handleUnstageAll,
    handleDiscardAll,
    handleOpenChanges,
    handleOpenStagedChanges,
    handleStageResolved,
  } = useFileOperations({
    gitFiles,
    setGitFiles,
    selectedRepoId,
    repoPath,
    fetchGitStatus,
    gitOutputIntegration,
  });

  // Hook 5: Commit form management
  const {
    commitSummary: commitMessage,
    setCommitSummary: setCommitMessage,
    commitLoading,
    handleCommit: originalHandleCommit,
    handleCommitAndPush,
    handleCommitAndPublish,
    handleCommitAndSync,
    handleAmend,
    generateLoading,
    handleGenerateCommitMessage,
  } = useCommitForm({
    selectedRepoId: selectedRepoId,
    repoPath,
    files: gitFiles,
    onCommitSuccess: async (options) => {
      if (!options?.pushed) {
        incrementOptimisticAhead();
      }
      await fetchGitStatus();
    },
  });

  // Helper function to check if we're in detached HEAD state
  const isDetachedHead = useCallback((): boolean => {
    if (!gitStatus?.current_branch) return false;
    const branch = gitStatus.current_branch;
    return (
      branch.includes("HEAD detached") ||
      branch.startsWith("(HEAD detached") ||
      /^[a-f0-9]{7,40}$/i.test(branch)
    );
  }, [gitStatus]);

  // Wrap handleCommit to check for detached HEAD
  const handleCommit = useCallback(async () => {
    if (isDetachedHead()) {
      const result = await DetachedHeadDialog.open({
        commitHash: gitStatus?.current_tip?.slice(0, 7) || "HEAD",
        suggestedBranchName: `branch-from-${gitStatus?.current_tip?.slice(0, 7) || "head"}`,
      });

      if (result === "cancel") {
        return;
      }

      if (result === "create_branch") {
        return;
      }
    }

    await originalHandleCommit();
  }, [originalHandleCommit, isDetachedHead, gitStatus]);

  // Hook 6: Stash management
  const {
    stashes,
    operationLoading: stashOperationLoading,
    stashCount,
    stashPush,
    stashApply,
    stashPop,
    stashDrop,
    refresh: refreshStashes,
  } = useStashState({
    repoId: selectedRepoId || "",
    repoPath,
    autoLoad: autoLoadStashes,
    onStashChange: async () => {
      await fetchGitStatus();
    },
  });

  // Determine if there are changes that can be stashed
  const hasChangesToStash = useMemo(() => {
    return gitFiles.length > 0;
  }, [gitFiles]);

  // Get ahead/behind from gitStatus
  const baseAhead = gitStatus?.branch_ahead_behind?.ahead ?? 0;
  const behind = gitStatus?.branch_ahead_behind?.behind ?? 0;

  // Detect if branch has upstream (remote tracking branch)
  const hasUpstream = !!gitStatus?.current_upstream_branch;

  const onCreatePrRef = useRef<
    (() => Promise<{ url?: string; error?: string }>) | null
  >(null);

  // Hook 7: Sync operations
  const {
    ahead,
    handleSync,
    syncLoading,
    handlePull,
    pullLoading,
    handlePush,
    pushLoading,
    handleFetch,
    fetchLoading,
    incrementOptimisticAhead,
    resetOptimisticAhead,
    handlePublish,
    publishLoading,
  } = useSyncOperations({
    selectedRepoId,
    repoPath,
    currentBranch,
    gitFiles,
    baseAhead,
    behind,
    hasUpstream,
    stashPush,
    stashPop,
    fetchGitStatus,
    refreshStashes,
    onCreatePrRef,
  });

  // PR state is owned by the single editor-level useWorkstationPr mount (see
  // useSourceControlSetup). Mirror its published atoms here instead of mounting
  // a second copy — that previously caused duplicate GitHub lookups, duplicate
  // auto-create timers and last-writer-wins races on the global atom.
  const {
    prUrl,
    isCreating: prCreating,
    readyToCreate: prReadyToCreate,
  } = useAtomValue(workstationPrAtomFamily(scopeKey));
  const { createPr } = useAtomValue(workstationPrCallbackAtomFamily(scopeKey));
  const autoCreatePr = useAtomValue(gitAutoCreatePrAtom);
  const setWorkstationPrCommitMessage = useSetAtom(
    workstationPrCommitMessageAtomFamily(scopeKey)
  );

  // Publish the commit summary so the single PR mount can build PR titles from
  // it. Clear it on unmount so a stale message never leaks into a later PR
  // created from elsewhere (e.g. the PinnedActionsBar pill).
  useEffect(() => {
    setWorkstationPrCommitMessage(commitMessage);
  }, [commitMessage, setWorkstationPrCommitMessage]);
  useEffect(
    () => () => setWorkstationPrCommitMessage(""),
    [setWorkstationPrCommitMessage]
  );

  useEffect(() => {
    onCreatePrRef.current = createPr;
  }, [createPr]);

  // Reset optimistic offset when gitStatus updates.
  // Must be an effect — running a setter in the render body causes the
  // commit phase to be re-scheduled, which can starve external updates
  // (e.g. router pushState from a sibling tree) and visibly freeze
  // navigation while this panel is mounted.
  const lastGitStatusAheadRef = useRef<number | null>(null);
  useEffect(() => {
    if (lastGitStatusAheadRef.current !== baseAhead) {
      lastGitStatusAheadRef.current = baseAhead;
      if (ahead !== baseAhead) {
        resetOptimisticAhead();
      }
    }
  }, [baseAhead, ahead, resetOptimisticAhead]);

  // Hook 8: Merge/rebase state
  const {
    conflictFiles,
    hasConflicts,
    isMerging,
    mergingBranch,
    handleContinueMerge,
  } = useMergeRebaseState({
    gitStatus,
    gitFiles,
    selectedRepoId,
    repoPath,
    currentBranch,
    fetchGitStatus,
    handleCommit,
  });

  // Reset selection when repo changes
  useEffect(() => {
    if (prevRepoIdRef.current !== repoId) {
      prevRepoIdRef.current = repoId;
      notifiedFileIdRef.current = "";
      queueMicrotask(() => {
        setSelectedFileId("");
      });
    }
  }, [repoId]);

  // Notify parent when file is selected OR when diff content loads
  const notifiedWithContentRef = useRef(false);

  useEffect(() => {
    if (!selectedFileId || !selectedGitFile || !onGitFileSelect) return;

    const hasContent = selectedGitFile.oldContent !== undefined;
    const isNewFile = notifiedFileIdRef.current !== selectedFileId;

    if (isNewFile) {
      notifiedWithContentRef.current = false;
    }

    const contentJustLoaded = hasContent && !notifiedWithContentRef.current;

    if (isNewFile || contentJustLoaded) {
      notifiedFileIdRef.current = selectedFileId;
      notifiedWithContentRef.current = hasContent;
      onGitFileSelect(selectedGitFile);
    }
  }, [selectedFileId, selectedGitFile, onGitFileSelect]);

  // Handle file selection
  const handleFileSelect = useCallback((fileId: string) => {
    setSelectedFileId(fileId);
  }, []);

  // Publish change-list position for the diff review floating bar (x/y)
  useEffect(() => {
    const idx = gitFiles.findIndex((f) => f.id === selectedFileId);
    const current = idx >= 0 ? idx + 1 : 0;
    const total = gitFiles.length;
    setGitReviewNavigation({ current, total });
  }, [gitFiles, selectedFileId, setGitReviewNavigation]);

  // Listen for "review-next-file" / "review-prev-file" from the diff viewer
  useEffect(() => {
    const goToOffset = (delta: number) => {
      const files = filesRef.current;
      if (files.length === 0) return;
      const currentId = selectedFileIdRef.current;
      const currentIndex = files.findIndex((f) => f.id === currentId);
      const baseIndex = currentIndex >= 0 ? currentIndex : 0;
      const nextIndex = (baseIndex + delta + files.length) % files.length;
      const nextFile = files[nextIndex];
      if (nextFile) {
        setSelectedFileId(nextFile.id);
      }
    };

    const onNext = () => goToOffset(1);
    const onPrev = () => goToOffset(-1);

    document.addEventListener("review-next-file", onNext);
    document.addEventListener("review-prev-file", onPrev);
    return () => {
      document.removeEventListener("review-next-file", onNext);
      document.removeEventListener("review-prev-file", onPrev);
    };
  }, []);

  // Memoize unified state object
  const state: SourceControlState = useMemo(
    () => ({
      files: gitFiles,
      filteredFiles,
      selectedFileId,
      loading: gitLoading,
      error: gitError,
      onFileSelect: handleFileSelect,
      onStageToggle: handleStageToggle,
      onDiscard: handleDiscard,
      onDiscardFiles: handleDiscardFiles,
      onStageAll: handleStageAll,
      onUnstageAll: handleUnstageAll,
      onDiscardAll: handleDiscardAll,
      onOpenChanges: handleOpenChanges,
      onOpenStagedChanges: handleOpenStagedChanges,
      searchQuery: gitSearchQuery,
      onSearchChange: setGitSearchQuery,
      commitMessage,
      onCommitMessageChange: setCommitMessage,
      onCommit: handleCommit,
      onCommitAndPush: hasUpstream ? handleCommitAndPush : undefined,
      onCommitAndPublish: hasUpstream ? undefined : handleCommitAndPublish,
      onCommitAndSync: hasUpstream ? handleCommitAndSync : undefined,
      onAmend: handleAmend,
      commitLoading,
      generateCommitMessageLoading: generateLoading,
      onGenerateCommitMessage: handleGenerateCommitMessage,
      stagedFilesCount,
      branchName: currentBranch,
      ahead,
      behind,
      onSync: handleSync,
      syncLoading,
      onPull: handlePull,
      pullLoading,
      onPush: handlePush,
      pushLoading,
      onFetch: handleFetch,
      fetchLoading,
      hasUpstream,
      onPublish: handlePublish,
      publishLoading,
      conflictFiles,
      hasConflicts,
      onStageResolved: handleStageResolved,
      isMerging,
      mergingBranch,
      onContinueMerge: handleContinueMerge,
      stashes,
      stashOperationLoading,
      stashCount,
      onStashPush: stashPush,
      onStashApply: stashApply,
      onStashPop: stashPop,
      onStashDrop: stashDrop,
      hasChangesToStash,
      prUrl,
      prCreating,
      prReadyToCreate,
      prEligible: prReadyToCreate,
      autoCreatePr,
      onCreatePr: createPr ?? undefined,
    }),
    [
      gitFiles,
      filteredFiles,
      selectedFileId,
      gitLoading,
      gitError,
      handleFileSelect,
      handleStageToggle,
      handleDiscard,
      handleDiscardFiles,
      handleStageAll,
      handleUnstageAll,
      handleDiscardAll,
      handleOpenChanges,
      handleOpenStagedChanges,
      gitSearchQuery,
      setGitSearchQuery,
      commitMessage,
      setCommitMessage,
      handleCommit,
      handleCommitAndPush,
      handleCommitAndPublish,
      handleCommitAndSync,
      handleAmend,
      commitLoading,
      generateLoading,
      handleGenerateCommitMessage,
      stagedFilesCount,
      currentBranch,
      ahead,
      behind,
      handleSync,
      syncLoading,
      handlePull,
      pullLoading,
      handlePush,
      pushLoading,
      handleFetch,
      fetchLoading,
      hasUpstream,
      handlePublish,
      publishLoading,
      conflictFiles,
      hasConflicts,
      handleStageResolved,
      isMerging,
      mergingBranch,
      handleContinueMerge,
      stashes,
      stashOperationLoading,
      stashCount,
      stashPush,
      stashApply,
      stashPop,
      stashDrop,
      hasChangesToStash,
      prUrl,
      prCreating,
      prReadyToCreate,
      autoCreatePr,
      createPr,
    ]
  );

  // Combined refresh function
  const refresh = useCallback(async () => {
    await Promise.all([fetchGitStatus(), refreshStashes()]);
  }, [fetchGitStatus, refreshStashes]);

  return useMemo(
    () => ({
      state,
      refresh,
      loading: gitLoading,
      lastRefreshTime,
    }),
    [state, refresh, gitLoading, lastRefreshTime]
  );
}

export default useSourceControlState;
