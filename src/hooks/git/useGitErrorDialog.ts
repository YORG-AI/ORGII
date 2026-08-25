/**
 * useGitErrorDialog Hook
 *
 * Handles showing the git error dialog and performing actions based on user choice.
 *
 * Actions:
 * - Stash and Continue: Stash local changes and retry operation
 * - Open Git Log: Creates a new tab with GitLogViewer
 * - Show Command Output: Switches to Output panel in bottom panel
 * - Cancel: Dismisses dialog without action
 */
import { useCallback } from "react";

import { gitApi } from "@src/api/http/git";
import { ROUTES } from "@src/config/routes";
import { getRepoContext } from "@src/services/git/operations/types";
import { gitPullStrategyAtom } from "@src/store/ui/editorSettingsAtom";
import {
  createGitLogTab,
  openWorkstationTabAtom,
  presentedWorkstationWorkspaceKeyAtom,
} from "@src/store/workstation/tabs";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";
import { showGitActionDialogSafely } from "@src/util/dialogs/gitActionDialog";
import {
  type GitErrorDialogOptions,
  type GitErrorDialogResult,
  buildGitErrorInfo,
  showGitErrorDialog,
} from "@src/util/dialogs/gitErrorDialog";
import { askNativeDialogSafely } from "@src/util/dialogs/nativeDialog";

// ============================================
// Types
// ============================================

export interface UseGitErrorDialogOptions {
  /** Callback to retry the failed operation */
  onRetry?: () => void | Promise<void>;
}

export interface UseGitErrorDialogReturn {
  /**
   * Show the git error dialog
   * Returns the user's choice
   */
  showErrorDialog: (
    options: GitErrorDialogOptions
  ) => Promise<GitErrorDialogResult>;

  /**
   * Handle git operation error with full dialog flow
   * Automatically performs the chosen action
   */
  handleGitError: (options: GitErrorDialogOptions) => Promise<void>;
}

async function stashAndRetryOperation(
  options: GitErrorDialogOptions,
  onRetry?: () => void | Promise<void>
): Promise<void> {
  const repoContext = options.repoId
    ? { repoId: options.repoId, repoPath: options.repoPath || "" }
    : getRepoContext();
  if (!repoContext) {
    showGitActionDialogSafely(
      "Cannot stash changes because repository context is unavailable.",
      "error"
    );
    return;
  }

  const stashResult = await gitApi.gitStashPush({
    repo_id: repoContext.repoId,
    repo_path: repoContext.repoPath || undefined,
    message: `Auto-stash before retrying ${options.operation}`,
    include_untracked: true,
  });

  if (!stashResult?.success) {
    showGitActionDialogSafely(
      stashResult?.message || "Failed to stash local changes.",
      "error"
    );
    return;
  }

  const stashRefLabel = stashResult.stash_ref || "the latest stash";
  let retrySucceeded = false;

  if (onRetry) {
    try {
      await Promise.resolve(onRetry());
      retrySucceeded = true;
    } catch (error) {
      showGitActionDialogSafely(
        error instanceof Error ? error.message : "Failed to retry operation.",
        "error"
      );
    }
  }

  if (!onRetry) {
    try {
      const store = getInstrumentedStore();
      const strategy = store.get(gitPullStrategyAtom) ?? undefined;

      if (options.operation === "pull") {
        await gitApi.gitPull({
          repo_id: repoContext.repoId,
          repo_path: repoContext.repoPath || undefined,
          strategy,
        });
        retrySucceeded = true;
      } else if (options.operation === "sync") {
        await gitApi.gitPull({
          repo_id: repoContext.repoId,
          repo_path: repoContext.repoPath || undefined,
          strategy,
        });
        await gitApi.gitPush({
          repo_id: repoContext.repoId,
          repo_path: repoContext.repoPath || undefined,
        });
        retrySucceeded = true;
      } else {
        showGitActionDialogSafely(
          "Changes were stashed. Retry this operation manually.",
          "info"
        );
        return;
      }
    } catch (error) {
      showGitActionDialogSafely(
        error instanceof Error ? error.message : "Retry after stash failed.",
        "error"
      );
      return;
    }
  }

  if (
    !retrySucceeded ||
    (options.operation !== "pull" && options.operation !== "sync")
  ) {
    return;
  }

  try {
    const operationLabel =
      options.operation.charAt(0).toUpperCase() + options.operation.slice(1);
    const shouldUnstash = await askNativeDialogSafely(
      `${operationLabel} completed successfully. Restore stashed changes now (${stashRefLabel})?`,
      {
        title: "Restore Stashed Changes",
        kind: "info",
        okLabel: "Unstash Changes",
        cancelLabel: "Keep Stashed",
      }
    );

    if (!shouldUnstash) {
      return;
    }

    const unstashResult = await gitApi.gitStashApply({
      repo_id: repoContext.repoId,
      repo_path: repoContext.repoPath || undefined,
      index: 0,
      pop: true,
    });

    if (!unstashResult?.success) {
      showGitActionDialogSafely(
        unstashResult?.message ||
          "Failed to restore stashed changes. You can apply the stash manually later.",
        "error"
      );
      return;
    }

    showGitActionDialogSafely("Stashed changes restored.", "info");
  } catch (error) {
    showGitActionDialogSafely(
      error instanceof Error
        ? error.message
        : "Failed to complete unstash flow after sync.",
      "error"
    );
  }
}

function navigateToCodeEditorIfNeeded(): void {
  if (typeof window === "undefined") {
    return;
  }

  const codeEditorPath = ROUTES.workStation.code.path;
  const isCodeEditorRoute =
    window.location.pathname === codeEditorPath ||
    window.location.pathname.startsWith(`${codeEditorPath}/`);

  if (isCodeEditorRoute) {
    return;
  }

  window.dispatchEvent(
    new CustomEvent("action-system-navigate", {
      detail: { path: codeEditorPath },
    })
  );
}

// ============================================
// Hook Implementation
// ============================================

export function useGitErrorDialog(
  hookOptions: UseGitErrorDialogOptions = {}
): UseGitErrorDialogReturn {
  const { onRetry } = hookOptions;

  /**
   * Open a git log tab with the error details
   */
  const openGitLogTab = useCallback((options: GitErrorDialogOptions) => {
    navigateToCodeEditorIfNeeded();

    const store = getInstrumentedStore();
    const errorInfo = buildGitErrorInfo(options);
    const workspace = store.get(presentedWorkstationWorkspaceKeyAtom);

    const tab = createGitLogTab(
      errorInfo.operation,
      errorInfo.errorMessage,
      errorInfo.commandOutput,
      errorInfo.timestamp
    );

    store.set(openWorkstationTabAtom, {
      workspace,
      tab,
    });
  }, []);

  /**
   * Show the error dialog and return user's choice
   */
  const showErrorDialog = useCallback(
    async (options: GitErrorDialogOptions): Promise<GitErrorDialogResult> => {
      return showGitErrorDialog(options);
    },
    []
  );

  /**
   * Handle git error with full dialog flow
   * Shows dialog and performs the chosen action
   */
  const handleGitError = useCallback(
    async (options: GitErrorDialogOptions): Promise<void> => {
      const result = await showErrorDialog(options);

      switch (result) {
        case "stash-and-continue":
          await stashAndRetryOperation(options, onRetry);
          break;

        case "open-git-log":
          openGitLogTab(options);
          break;

        case "cancel":
        default:
          // Do nothing
          break;
      }

      // If retry callback provided and user might want to retry after viewing
      // The retry button is available in the GitLogViewer component
      if (onRetry && result === "open-git-log") {
        // Retry callback is passed to GitLogViewer via tab data
        // No immediate action needed here
      }
    },
    [showErrorDialog, openGitLogTab, onRetry]
  );

  return {
    showErrorDialog,
    handleGitError,
  };
}

// ============================================
// Standalone function for use outside React
// ============================================

/**
 * Show git error dialog and handle result (standalone, no React hooks)
 *
 * Use this in services or non-React contexts.
 */
export async function showGitErrorAndHandle(
  options: GitErrorDialogOptions
): Promise<void> {
  const store = getInstrumentedStore();

  const result = await showGitErrorDialog(options);

  switch (result) {
    case "stash-and-continue":
      await stashAndRetryOperation(options);
      break;

    case "open-git-log": {
      navigateToCodeEditorIfNeeded();

      const errorInfo = buildGitErrorInfo(options);
      const tab = createGitLogTab(
        errorInfo.operation,
        errorInfo.errorMessage,
        errorInfo.commandOutput,
        errorInfo.timestamp
      );

      const workspace = store.get(presentedWorkstationWorkspaceKeyAtom);
      store.set(openWorkstationTabAtom, {
        workspace,
        tab,
      });
      break;
    }

    case "cancel":
    default:
      // Do nothing
      break;
  }
}

export default useGitErrorDialog;
