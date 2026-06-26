/**
 * useEditorStatusBarGit
 *
 * Encapsulates all git-sync, workspace-label, and sync-in-progress logic
 * for EditorStatusBar, keeping the component file under 600 lines.
 */
import { useAtomValue } from "jotai";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { PushRejectedDialog } from "@src/components/GitDialogs";
import Message from "@src/components/Message";
import { useGitStatus } from "@src/contexts/git";
import { showGitErrorAndHandle } from "@src/hooks/git/useGitErrorDialog";
import {
  type GitOperationResult,
  useGitOperations,
} from "@src/hooks/git/useGitOperations";
import { useRepoSelection } from "@src/hooks/git/useRepoSelection";
import { useRefreshSpin } from "@src/hooks/ui";
import { workspaceGitStatusMapAtom } from "@src/store/git";
import type { GitPullStrategy } from "@src/store/ui/editorSettingsAtom";
import {
  isMultiRootWorkspaceAtom,
  workspaceFoldersAtom,
} from "@src/store/ui/workspaceFoldersAtom";
import { workspaceNameAtom } from "@src/store/workspace/derived";

const DEFAULT_REMOTE_NAME = "origin";
const REBASE_PULL_STRATEGY: GitPullStrategy = "rebase";

export interface UseEditorStatusBarGitOptions {
  repoName: string | undefined;
  repoPath: string | undefined;
  branchName: string | undefined;
}

export interface UseEditorStatusBarGitReturn {
  workspaceLabel: string | undefined;
  workspaceTooltip: string;
  isMultiRoot: boolean;
  aheadCount: number;
  behindCount: number;
  needsPublish: boolean;
  isSyncBusy: boolean;
  isPublishing: boolean;
  canSyncDisplayedRepo: boolean;
  syncSpinClass: string | undefined;
  syncStatusLabel: string | null;
  handleSyncClick: () => void;
  handleFetchClick: () => Promise<void>;
  handlePullClick: () => Promise<void>;
  handleRebaseClick: () => Promise<void>;
  handlePushClick: () => Promise<void>;
  checkoutLoading: boolean;
}

export function useEditorStatusBarGit({
  repoName,
  repoPath,
  branchName,
}: UseEditorStatusBarGitOptions): UseEditorStatusBarGitReturn {
  const { t } = useTranslation();

  const { scopedGitStatus, loading: statusLoading } = useGitStatus();
  const { selectedRepoId, currentRepo, checkoutLoading } = useRepoSelection({
    autoLoad: false,
  });

  const isMultiRoot = useAtomValue(isMultiRootWorkspaceAtom);
  const workspaceFolders = useAtomValue(workspaceFoldersAtom);
  const workspaceGitStatusMap = useAtomValue(workspaceGitStatusMapAtom);
  const workspaceName = useAtomValue(workspaceNameAtom);

  const workspaceLabel = useMemo(() => {
    if (!isMultiRoot) return repoName;
    return workspaceName || `${repoName} Workspace`;
  }, [isMultiRoot, repoName, workspaceName]);

  const workspaceTooltip = useMemo(() => {
    if (!isMultiRoot) return `Repo: ${repoName}`;
    const names = workspaceFolders.map((f) => f.name);
    const label = workspaceName || `${repoName} Workspace`;
    return `${label}\n${workspaceFolders.length} repos: ${names.join(", ")}`;
  }, [isMultiRoot, repoName, workspaceName, workspaceFolders]);

  const selectedRepoPath = currentRepo?.path || currentRepo?.fs_uri;
  const currentGitStatus = useMemo(() => {
    if (!repoPath) return null;
    if (scopedGitStatus?.repoPath === repoPath) return scopedGitStatus.status;
    return workspaceGitStatusMap.get(repoPath) ?? null;
  }, [repoPath, scopedGitStatus, workspaceGitStatusMap]);
  const operationRepoPath =
    selectedRepoPath === repoPath ? selectedRepoPath : undefined;
  const operationRepoId = operationRepoPath
    ? selectedRepoId || undefined
    : undefined;
  const canSyncDisplayedRepo = !!operationRepoPath;
  const { push, pull, fetch, publish, isLoading } = useGitOperations({
    repoId: operationRepoId,
    repoPath: operationRepoPath,
    useActionSystem: false,
    showErrorDialogs: false,
  });

  const aheadCount = currentGitStatus?.branch_ahead_behind?.ahead ?? 0;
  const behindCount = currentGitStatus?.branch_ahead_behind?.behind ?? 0;
  const needsPublish =
    !currentGitStatus?.current_upstream_branch && currentGitStatus?.exists;

  const [syncInProgress, setSyncInProgress] = useState(false);
  const [syncStatusLabel, setSyncStatusLabel] = useState<string | null>(null);

  const handleFetchClick = useCallback(async () => {
    if (!canSyncDisplayedRepo) return;

    setSyncInProgress(true);
    setSyncStatusLabel(t("sourceControl.fetch"));
    try {
      const result = await fetch({ remote: DEFAULT_REMOTE_NAME, prune: true });
      if (!result.success) {
        Message.error(
          t("git.messages.fetchFailed", { error: result.errorType })
        );
      }
    } finally {
      setSyncInProgress(false);
      setSyncStatusLabel(null);
    }
  }, [canSyncDisplayedRepo, fetch, t]);

  const handlePublish = useCallback(async () => {
    if (!canSyncDisplayedRepo) return;

    setSyncStatusLabel(t("git.actions.publish"));
    const result = await publish();
    setSyncStatusLabel(null);
    if (result.success) {
      Message.success(
        t("workstation.publishBranchToOrigin", { branch: branchName })
      );
    } else {
      Message.error(
        t("git.messages.publishFailed", { error: result.errorType })
      );
    }
  }, [publish, branchName, canSyncDisplayedRepo, t]);

  const handlePullClick = useCallback(async () => {
    if (!canSyncDisplayedRepo) return;

    setSyncStatusLabel(t("sourceControl.pull"));
    await pull({ showErrorDialogs: true });
    setSyncStatusLabel(null);
  }, [canSyncDisplayedRepo, pull, t]);

  const handleRebaseClick = useCallback(async () => {
    if (!canSyncDisplayedRepo) return;

    setSyncStatusLabel("Pull with rebase");
    await pull({
      strategy: REBASE_PULL_STRATEGY,
      showErrorDialogs: true,
    });
    setSyncStatusLabel(null);
  }, [canSyncDisplayedRepo, pull]);

  const showSyncErrorDialog = useCallback(
    async (result: GitOperationResult, fallbackMessage: string) => {
      await showGitErrorAndHandle({
        operation: "sync",
        repoId: operationRepoId,
        repoPath: operationRepoPath,
        errorType: result.errorType,
        errorMessage: result.message || fallbackMessage,
        commandOutput: result.message,
      });
    },
    [operationRepoId, operationRepoPath]
  );

  const handlePushRejected = useCallback(async () => {
    setSyncStatusLabel(t("sourceControl.fetch"));
    const fetchResult = await fetch({
      remote: DEFAULT_REMOTE_NAME,
      prune: true,
    });
    setSyncStatusLabel(null);

    const result = await PushRejectedDialog.open({
      branchName: branchName || "current branch",
      remoteName: DEFAULT_REMOTE_NAME,
      behindCount: fetchResult.success && behindCount > 0 ? behindCount : 1,
    });

    if (result === "pull_push") {
      setSyncStatusLabel(t("sourceControl.pull"));
      const pullResult = await pull({ showErrorDialogs: false });
      if (!pullResult.success) {
        await showSyncErrorDialog(pullResult, "Pull operation failed");
        setSyncStatusLabel(null);
        return;
      }

      setSyncStatusLabel(t("sourceControl.push"));
      const pushResult = await push();
      if (!pushResult.success) {
        Message.error(
          t("git.messages.pushFailed", { error: pushResult.errorType })
        );
      }
    } else if (result === "force") {
      setSyncStatusLabel(t("sourceControl.push"));
      await push({ force: true });
    }

    setSyncStatusLabel(null);
  }, [branchName, behindCount, fetch, pull, push, showSyncErrorDialog, t]);

  const handlePushClick = useCallback(async () => {
    if (!canSyncDisplayedRepo) return;

    setSyncStatusLabel(
      needsPublish ? t("git.actions.publish") : t("sourceControl.push")
    );
    const result = needsPublish ? await publish() : await push();
    if (!result.success && result.errorType === "non_fast_forward") {
      await handlePushRejected();
      return;
    }

    setSyncStatusLabel(null);
    if (!result.success) {
      Message.error(t("git.messages.pushFailed", { error: result.errorType }));
    }
  }, [
    canSyncDisplayedRepo,
    needsPublish,
    publish,
    push,
    handlePushRejected,
    t,
  ]);

  const handleSync = useCallback(async () => {
    if (!canSyncDisplayedRepo) return;

    if (needsPublish) {
      await handlePublish();
      return;
    }

    setSyncInProgress(true);
    setSyncStatusLabel(t("git.actions.sync"));
    try {
      const fetchResult = await fetch({
        remote: DEFAULT_REMOTE_NAME,
        prune: true,
      });
      if (!fetchResult.success) {
        Message.error(
          t("git.messages.fetchFailed", { error: fetchResult.errorType })
        );
        return;
      }

      const pullResult = await pull({ showErrorDialogs: false });
      if (!pullResult.success) {
        await showSyncErrorDialog(pullResult, "Pull operation failed");
        return;
      }

      if (aheadCount > 0) {
        const pushResult = await push();
        if (!pushResult.success) {
          if (pushResult.errorType === "non_fast_forward") {
            await handlePushRejected();
          } else {
            Message.error(
              t("git.messages.pushFailed", { error: pushResult.errorType })
            );
          }
          return;
        }
      }

      if (aheadCount > 0 || behindCount > 0) {
        Message.success(t("git.messages.syncSuccess"));
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      Message.error(t("git.messages.syncFailed", { error: msg }));
    } finally {
      setSyncInProgress(false);
      setSyncStatusLabel(null);
    }
  }, [
    push,
    pull,
    fetch,
    behindCount,
    aheadCount,
    canSyncDisplayedRepo,
    needsPublish,
    handlePublish,
    handlePushRejected,
    showSyncErrorDialog,
    t,
  ]);

  const isPublishing = isLoading.publish;
  const isSyncBusy =
    isLoading.pull ||
    isLoading.push ||
    isLoading.fetch ||
    syncInProgress ||
    statusLoading ||
    isPublishing;

  const { spinClass: syncSpinClass, handleClick: handleSyncClick } =
    useRefreshSpin(needsPublish ? handlePublish : handleSync, isSyncBusy);

  return {
    workspaceLabel,
    workspaceTooltip,
    isMultiRoot,
    aheadCount,
    behindCount,
    needsPublish: !!needsPublish,
    isSyncBusy,
    isPublishing,
    canSyncDisplayedRepo,
    syncSpinClass,
    syncStatusLabel,
    handleSyncClick,
    handleFetchClick,
    handlePullClick,
    handleRebaseClick,
    handlePushClick,
    checkoutLoading,
  };
}
