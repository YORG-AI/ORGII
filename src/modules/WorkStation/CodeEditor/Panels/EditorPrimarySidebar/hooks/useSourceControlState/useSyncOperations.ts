/**
 * useSyncOperations Hook
 *
 * Handles git sync operations: pull, push, and combined sync.
 * Includes optimistic ahead/behind tracking and error handling with dialogs.
 *
 * Uses dispatch() for all git operations to ensure AI/human unification.
 */
import { type MutableRefObject, useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useActionSystemOptional } from "@src/ActionSystem";
import { getGitRemotes } from "@src/api/http/git/remotes";
import {
  LARGE_PUSH_THRESHOLD,
  LargePushConfirmDialog,
  ProtectedBranchDialog,
  PushRejectedDialog,
} from "@src/components/GitDialogs";
import {
  type GitOperationResult,
  useGitOperations,
} from "@src/hooks/git/useGitOperations";
import { createLogger } from "@src/hooks/logger";
import type { GitFile } from "@src/types/git/types";
import { showGitActionDialogSafely } from "@src/util/dialogs/gitActionDialog";

import { handlePullError } from "./pullErrorHandlers";

const log = createLogger("SyncOperations");

export interface UseSyncOperationsOptions {
  selectedRepoId: string | null;
  repoPath: string;
  currentBranch: string | undefined;
  gitFiles: GitFile[];
  /** Base ahead count from git status */
  baseAhead: number;
  /** Behind count from git status */
  behind: number;
  /** Whether the current branch has an upstream (remote tracking branch) */
  hasUpstream: boolean;
  stashPush: (message?: string, includeUntracked?: boolean) => Promise<boolean>;
  stashPop: (index: number) => Promise<boolean>;
  fetchGitStatus: () => Promise<void>;
  refreshStashes: () => Promise<void>;
  /** Ref to PR creation handler (used when push hits a protected branch) */
  onCreatePrRef?: MutableRefObject<
    (() => Promise<{ url?: string; error?: string }>) | null
  >;
}

export interface UseSyncOperationsResult {
  /** Number of local commits ahead of remote (includes optimistic offset) */
  ahead: number;
  /** Callback to sync (pull + push) */
  handleSync: () => Promise<void>;
  /** Whether sync operation is in progress */
  syncLoading: boolean;
  /** Callback to pull only */
  handlePull: () => Promise<void>;
  /** Whether pull operation is in progress */
  pullLoading: boolean;
  /** Callback to push only */
  handlePush: () => Promise<void>;
  /** Whether push operation is in progress */
  pushLoading: boolean;
  /** Callback to fetch only */
  handleFetch: () => Promise<void>;
  /** Whether fetch operation is in progress */
  fetchLoading: boolean;
  /** Increment optimistic ahead offset (called after commit) */
  incrementOptimisticAhead: () => void;
  /** Reset optimistic ahead offset (called when gitStatus updates) */
  resetOptimisticAhead: () => void;
  /** Callback to publish branch (push with --set-upstream) */
  handlePublish: () => Promise<void>;
  /** Whether publish operation is in progress */
  publishLoading: boolean;
}

export function useSyncOperations(
  options: UseSyncOperationsOptions
): UseSyncOperationsResult {
  const {
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
  } = options;

  const { t } = useTranslation();

  // Get dispatch for unified operations
  const actionSystem = useActionSystemOptional();
  const dispatch = actionSystem?.dispatch;

  // Use unified git operations - auto-streams to Output panel
  const {
    push: gitPush,
    pull: gitPull,
    fetch: gitFetch,
    publish: gitPublish,
  } = useGitOperations({
    repoId: selectedRepoId || undefined,
    repoPath,
  });

  const [syncLoading, setSyncLoading] = useState(false);
  const [pullLoading, setPullLoading] = useState(false);
  const [pushLoading, setPushLoading] = useState(false);
  const [fetchLoading, setFetchLoading] = useState(false);
  const [publishLoading, setPublishLoading] = useState(false);
  const [optimisticAheadOffset, setOptimisticAheadOffset] = useState(0);

  // Use refs to ensure handleSync always uses latest values
  const aheadRef = useRef(baseAhead + optimisticAheadOffset);
  const behindRef = useRef(behind);
  const fetchGitStatusRef = useRef(fetchGitStatus);
  const refreshStashesRef = useRef(refreshStashes);
  const filesRef = useRef(gitFiles);

  // Update refs on every render
  aheadRef.current = baseAhead + optimisticAheadOffset;
  behindRef.current = behind;
  fetchGitStatusRef.current = fetchGitStatus;
  refreshStashesRef.current = refreshStashes;
  filesRef.current = gitFiles;

  const hasConfiguredRemote = useCallback(async (): Promise<boolean> => {
    if (!selectedRepoId) return false;

    const remotesData = await getGitRemotes({
      repo_id: selectedRepoId,
      repo_path: repoPath,
    });
    return (remotesData?.remotes?.length ?? 0) > 0;
  }, [selectedRepoId, repoPath]);

  const showMissingRemoteHint = useCallback(() => {
    showGitActionDialogSafely(t("sourceControl.noRemoteForPublish"), "warning");
  }, [t]);

  // Helper function to perform pull operation - delegates to useGitOperations
  const doPull = useCallback(async (): Promise<GitOperationResult> => {
    return await gitPull();
  }, [gitPull]);

  // Helper function to perform push operation - delegates to useGitOperations
  const doPush = useCallback(
    async (force = false, setUpstream = false): Promise<GitOperationResult> => {
      if (setUpstream) {
        return await gitPublish();
      }
      return await gitPush({ force });
    },
    [gitPush, gitPublish]
  );

  const handleProtectedBranch = useCallback(async () => {
    const result = await ProtectedBranchDialog.open({
      branchName: currentBranch || "main",
      remoteName: "origin",
    });
    if (result === "create_pr") {
      await onCreatePrRef?.current?.();
    }
  }, [currentBranch, onCreatePrRef]);

  // Handle publish (push with --set-upstream for new branches)
  const handlePublish = useCallback(async () => {
    if (!selectedRepoId || publishLoading) return;

    setPublishLoading(true);
    try {
      if (!(await hasConfiguredRemote())) {
        showMissingRemoteHint();
        return;
      }

      const pushResult = await doPush(false, true);

      if (!pushResult.success) {
        if (pushResult.errorType === "authentication_failed") {
          log.error("Authentication failed. Please check your credentials.");
        } else if (pushResult.errorType === "network_error") {
          log.error("Network error. Please check your connection.");
        } else {
          log.error("Publish failed:", pushResult.errorType);
        }
        return;
      }

      // Refresh status after successful publish
      await Promise.all([
        fetchGitStatusRef.current(),
        refreshStashesRef.current(),
      ]);
    } catch (error) {
      log.error("Failed to publish branch:", error);
    } finally {
      setPublishLoading(false);
    }
  }, [
    selectedRepoId,
    publishLoading,
    hasConfiguredRemote,
    showMissingRemoteHint,
    doPush,
  ]);

  // Handle sync (pull then push, or publish if no upstream)
  // Pull is unconditional — the local behind count may be stale because
  // remote can have new commits we haven't fetched yet. Pull includes
  // a fetch internally, so it always reconciles with the remote first.
  const handleSync = useCallback(async () => {
    if (!selectedRepoId || syncLoading) return;

    // If no upstream, publish instead of sync
    if (!hasUpstream) {
      await handlePublish();
      return;
    }

    setSyncLoading(true);
    try {
      // Always pull first (includes fetch + merge). When already
      // up-to-date this is a fast no-op.
      const pullResult = await doPull();

      if (!pullResult.success) {
        const handled = await handlePullError({
          pullResult,
          currentBranch,
          currentFiles: filesRef.current,
          doPull,
          stashPush,
          stashPop,
          dispatch,
        });
        if (!handled) {
          log.error("Pull failed:", pullResult.errorType);
        }
        return;
      }

      // Decide the push on a FRESH ahead count, not one captured before the
      // pull: commits made outside the panel's commit button (an AI
      // dispatch, the terminal, an external editor) never bump the
      // optimistic offset, and the last status poll may predate them — a
      // stale count made sync silently skip the push (while reporting
      // success), or let a large push bypass its confirmation. Same
      // refresh-then-read pattern the non-fast-forward branch below already
      // uses for the behind count.
      await fetchGitStatusRef.current();
      const currentAhead = aheadRef.current;

      // Check if pushing many commits - show confirmation dialog
      if (currentAhead >= LARGE_PUSH_THRESHOLD) {
        const result = await LargePushConfirmDialog.open({
          commitCount: currentAhead,
          branchName: currentBranch || "current branch",
          remoteName: "origin",
        });

        if (result === "cancel") {
          return;
        }
      }

      // Then push (if ahead)
      if (currentAhead > 0) {
        const pushResult = await doPush();

        if (!pushResult.success) {
          if (pushResult.errorType === "non_fast_forward") {
            await fetchGitStatusRef.current();
            const newBehind = behindRef.current;

            const result = await PushRejectedDialog.open({
              branchName: currentBranch || "current branch",
              remoteName: "origin",
              behindCount: newBehind > 0 ? newBehind : 1,
            });

            if (result === "pull_push") {
              const retryPull = await doPull();
              if (retryPull.success) {
                await doPush();
              }
            } else if (result === "force") {
              await doPush(true);
            }
          } else if (pushResult.errorType === "protected_branch") {
            await handleProtectedBranch();
          } else if (pushResult.errorType === "authentication_failed") {
            log.error("Authentication failed. Please check your credentials.");
          } else if (pushResult.errorType === "network_error") {
            log.error("Network error. Please check your connection.");
          } else {
            log.error("Push failed:", pushResult.errorType);
          }
          return;
        }
      }

      // Reset optimistic offset after successful sync
      setOptimisticAheadOffset(0);

      // Refresh both status and stashes after sync
      await Promise.all([
        fetchGitStatusRef.current(),
        refreshStashesRef.current(),
      ]);
    } catch (error) {
      log.error("Failed to sync:", error);
    } finally {
      setSyncLoading(false);
    }
  }, [
    selectedRepoId,
    syncLoading,
    hasUpstream,
    handlePublish,
    doPull,
    doPush,
    currentBranch,
    stashPush,
    stashPop,
    dispatch,
    handleProtectedBranch,
  ]);

  // Handle standalone pull (with error dialog handling)
  const handlePull = useCallback(async () => {
    if (!selectedRepoId || pullLoading) return;

    setPullLoading(true);
    try {
      const pullResult = await doPull();

      if (!pullResult.success) {
        const handled = await handlePullError({
          pullResult,
          currentBranch,
          currentFiles: filesRef.current,
          doPull,
          stashPush,
          stashPop,
          dispatch,
        });
        if (!handled) {
          log.error("Pull failed:", pullResult.errorType);
        }
        return;
      }

      // Refresh status after successful pull
      await Promise.all([
        fetchGitStatusRef.current(),
        refreshStashesRef.current(),
      ]);
    } catch (error) {
      log.error("Failed to pull:", error);
    } finally {
      setPullLoading(false);
    }
  }, [
    selectedRepoId,
    pullLoading,
    doPull,
    currentBranch,
    stashPush,
    stashPop,
    dispatch,
  ]);

  // Handle standalone push (with preflight fetch + error dialog handling)
  // Fetches first so we can detect remote changes before pushing,
  // avoiding the "push rejected" error when possible.
  const handlePush = useCallback(async () => {
    if (!selectedRepoId || pushLoading) return;

    setPushLoading(true);
    try {
      if (!hasUpstream) {
        setPushLoading(false);
        await handlePublish();
        return;
      }

      const currentAhead = aheadRef.current;

      // Preflight fetch to update remote tracking refs.
      // Non-critical: if fetch fails we still attempt the push.
      await gitFetch().catch(() => {});

      // Refresh status so behind count reflects the fetch
      await fetchGitStatusRef.current();
      const freshBehind = behindRef.current;

      // If remote has new commits, proactively offer pull instead of
      // waiting for the push to fail with non_fast_forward.
      if (freshBehind > 0) {
        const result = await PushRejectedDialog.open({
          branchName: currentBranch || "current branch",
          remoteName: "origin",
          behindCount: freshBehind,
        });

        let pushed = false;
        if (result === "pull_push") {
          const retryPull = await doPull();
          if (retryPull.success) {
            const pushResult = await doPush();
            pushed = pushResult.success;
          }
        } else if (result === "force") {
          const pushResult = await doPush(true);
          pushed = pushResult.success;
        }

        if (pushed) {
          setOptimisticAheadOffset(0);
        }
        await Promise.all([
          fetchGitStatusRef.current(),
          refreshStashesRef.current(),
        ]);
        return;
      }

      // Check if pushing many commits - show confirmation dialog
      if (currentAhead >= LARGE_PUSH_THRESHOLD) {
        const result = await LargePushConfirmDialog.open({
          commitCount: currentAhead,
          branchName: currentBranch || "current branch",
          remoteName: "origin",
        });

        if (result === "cancel") {
          return;
        }
      }

      const pushResult = await doPush();

      if (!pushResult.success) {
        if (pushResult.errorType === "non_fast_forward") {
          await fetchGitStatusRef.current();
          const newBehind = behindRef.current;

          const result = await PushRejectedDialog.open({
            branchName: currentBranch || "current branch",
            remoteName: "origin",
            behindCount: newBehind > 0 ? newBehind : 1,
          });

          if (result === "pull_push") {
            const retryPull = await doPull();
            if (retryPull.success) {
              await doPush();
            }
          } else if (result === "force") {
            await doPush(true);
          }
        } else if (pushResult.errorType === "protected_branch") {
          await handleProtectedBranch();
        } else if (pushResult.errorType === "authentication_failed") {
          log.error("Authentication failed. Please check your credentials.");
        } else if (pushResult.errorType === "network_error") {
          log.error("Network error. Please check your connection.");
        } else {
          log.error("Push failed:", pushResult.errorType);
        }
        return;
      }

      // Reset optimistic offset after successful push
      setOptimisticAheadOffset(0);

      // Refresh status after successful push
      await Promise.all([
        fetchGitStatusRef.current(),
        refreshStashesRef.current(),
      ]);
    } catch (error) {
      log.error("Failed to push:", error);
    } finally {
      setPushLoading(false);
    }
  }, [
    selectedRepoId,
    pushLoading,
    hasUpstream,
    handlePublish,
    doPush,
    doPull,
    gitFetch,
    currentBranch,
    handleProtectedBranch,
  ]);

  // Handle standalone fetch
  const handleFetch = useCallback(async () => {
    if (!selectedRepoId || fetchLoading) return;

    setFetchLoading(true);
    try {
      const fetchResult = await gitFetch();

      if (!fetchResult.success) {
        if (fetchResult.errorType === "authentication_failed") {
          log.error("Authentication failed. Please check your credentials.");
        } else if (fetchResult.errorType === "network_error") {
          log.error("Network error. Please check your connection.");
        } else {
          log.error("Fetch failed:", fetchResult.errorType);
        }
        return;
      }

      // Refresh status after successful fetch
      await Promise.all([
        fetchGitStatusRef.current(),
        refreshStashesRef.current(),
      ]);
    } catch (error) {
      log.error("Failed to fetch:", error);
    } finally {
      setFetchLoading(false);
    }
  }, [selectedRepoId, fetchLoading, gitFetch]);

  const incrementOptimisticAhead = useCallback(() => {
    setOptimisticAheadOffset((prev) => prev + 1);
  }, []);

  const resetOptimisticAhead = useCallback(() => {
    setOptimisticAheadOffset(0);
  }, []);

  return {
    ahead: baseAhead + optimisticAheadOffset,
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
  };
}
