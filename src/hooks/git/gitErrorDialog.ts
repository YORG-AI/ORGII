/**
 * Shows the git error dialog and performs actions based on user choice.
 *
 * Actions:
 * - Stash and Continue: Stash local changes and retry operation
 * - Open Git Log: Creates a new tab with GitLogViewer
 * - Show Command Output: Switches to Output panel in bottom panel
 * - Cancel: Dismisses dialog without action
 */
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
  buildGitErrorInfo,
  showGitErrorDialog,
} from "@src/util/dialogs/gitErrorDialog";
import { askNativeDialogSafely } from "@src/util/dialogs/nativeDialog";

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
  const repoParams = {
    repo_id: repoContext.repoId,
    repo_path: repoContext.repoPath || undefined,
  };

  const stashResult = await gitApi.gitStashPush({
    ...repoParams,
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

  // Capture the fresh stash's commit id right away: "stash@{0}" is
  // positional, and any stash created before the restore (a leftover
  // autostash, a concurrent stash action) would make index 0 — and a pop of
  // it — target the WRONG entry.
  const listAfterPush = await gitApi.gitStashList(repoParams);
  const stashSha = listAfterPush?.stashes[0]?.commit_sha ?? null;
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
  } else {
    // Retry the SAME operation the user attempted: prefer the parameters it
    // actually ran with over re-reading settings — an explicit
    // "pull with rebase" must not retry as a merge pull.
    const store = getInstrumentedStore();
    const strategy =
      options.retryContext?.strategy ??
      store.get(gitPullStrategyAtom) ??
      undefined;
    const remote = options.retryContext?.remote;
    const branch = options.retryContext?.branch;

    try {
      if (options.operation === "pull") {
        await gitApi.gitPull({ ...repoParams, remote, branch, strategy });
        retrySucceeded = true;
      } else if (options.operation === "sync") {
        await gitApi.gitPull({ ...repoParams, remote, branch, strategy });
        await gitApi.gitPush({ ...repoParams, remote, branch });
        retrySucceeded = true;
      } else {
        // Not automatically retryable (checkout, commit, …): the stash was
        // made so the user can retry by hand — leave it in place and say so.
        showGitActionDialogSafely(
          `Changes were stashed (${stashRefLabel}). Retry this operation manually, then restore the stash.`,
          "info"
        );
        return;
      }
    } catch (error) {
      showGitActionDialogSafely(
        error instanceof Error ? error.message : "Retry after stash failed.",
        "error"
      );
    }
  }

  // Always reach a restore decision — succeed or fail, the user's changes
  // must never stay silently parked in the stash. (The dialog's hint
  // explicitly promises to "ask if you want to restore those stashed
  // changes".)
  const operationLabel =
    options.operation.charAt(0).toUpperCase() + options.operation.slice(1);
  const prompt = retrySucceeded
    ? `${operationLabel} completed successfully. Restore stashed changes now (${stashRefLabel})?`
    : `The ${options.operation} retry failed. Restore your stashed changes now (${stashRefLabel})?`;

  try {
    const shouldUnstash = await askNativeDialogSafely(prompt, {
      title: "Restore Stashed Changes",
      kind: "info",
      okLabel: "Unstash Changes",
      cancelLabel: "Keep Stashed",
    });

    if (!shouldUnstash) {
      return;
    }

    // Re-resolve the stash by its commit id: its index may have shifted if
    // anything else touched the stash list meanwhile.
    let index = 0;
    if (stashSha) {
      const listAtRestore = await gitApi.gitStashList(repoParams);
      const match = listAtRestore?.stashes.find(
        (entry) => entry.commit_sha === stashSha
      );
      if (listAtRestore && !match) {
        showGitActionDialogSafely(
          "The auto-stash is no longer in the stash list; nothing to restore.",
          "info"
        );
        return;
      }
      index = match?.index ?? 0;
    }

    const unstashResult = await gitApi.gitStashApply({
      ...repoParams,
      index,
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
