/**
 * Shared pull error handling logic for useSyncOperations.
 * Both handleSync and handlePull share the same dialog flow for pull errors.
 */
import type { TypedDispatch } from "@src/ActionSystem";
import {
  PullConflictDialog,
  RebaseConflictDialog,
} from "@src/components/GitDialogs";
import type { GitOperationResult } from "@src/hooks/git/useGitOperations";
import { createLogger } from "@src/hooks/logger";
import type { GitFile } from "@src/types/git/types";

const log = createLogger("pullErrorHandlers");

export interface HandlePullErrorOptions {
  pullResult: GitOperationResult;
  currentBranch: string | undefined;
  currentFiles: GitFile[];
  doPull: () => Promise<GitOperationResult>;
  stashPush: (message?: string, includeUntracked?: boolean) => Promise<boolean>;
  stashPop: (index: number) => Promise<boolean>;
  dispatch: TypedDispatch | undefined;
}

/**
 * Handles error cases from a failed git pull by showing the appropriate dialog.
 * Returns `true` if the error was handled (caller should return early).
 * Returns `false` if the error was not recognized (caller should log and return).
 */
export async function handlePullError({
  pullResult,
  currentBranch,
  currentFiles,
  doPull,
  stashPush,
  stashPop,
  dispatch,
}: HandlePullErrorOptions): Promise<boolean> {
  if (pullResult.errorType === "uncommitted_changes") {
    const result = await PullConflictDialog.open({
      branchName: currentBranch || "current branch",
      remoteName: "origin",
      conflictingFiles: currentFiles
        .filter((file: GitFile) => !file.staged)
        .map((file: GitFile) => file.path)
        .slice(0, 10),
    });

    if (result === "stash_pull") {
      // Include untracked files: a pull is blocked by an untracked file
      // about to be overwritten just as easily as by a tracked one, and the
      // user chose to stash their local changes wholesale.
      const stashed = await stashPush(
        `Auto-stash before pulling into ${currentBranch || "current branch"}`,
        true
      );
      if (!stashed) {
        // stashPush surfaces its own failure toast; retrying the pull on a
        // still-dirty tree would only reproduce the error it just showed.
        log.error("Stash failed; pull not retried");
        return true;
      }
      const retryPull = await doPull();
      if (!retryPull.success) {
        log.error("Pull failed after stash");
      }
      // Restore regardless of the retry's outcome — the user chose "stash
      // and pull", not "move my changes into the stash". The stash was
      // pushed onto the tree one operation ago, so the fresh entry is at
      // index 0 (a rebase pull creates no autostash on a clean tree). If
      // the pop conflicts with the pulled commits, git keeps the entry and
      // stashPop surfaces its failure toast, so nothing is silently lost.
      await stashPop(0);
    } else if (result === "discard_pull") {
      const allFilePaths = currentFiles.map((file: GitFile) => file.path);
      if (allFilePaths.length > 0 && dispatch) {
        await dispatch("git.discardAll", {}, "user");
      }
      const retryPull = await doPull();
      if (!retryPull.success) {
        log.error("Pull failed after discard");
      }
    }
    return true;
  }

  if (pullResult.errorType === "merge_conflicts") {
    const result = await RebaseConflictDialog.open({
      conflictingFiles: currentFiles
        .filter((fileItem: GitFile) => fileItem.status === "conflict")
        .map((fileItem: GitFile) => fileItem.path),
      operationType: "merge",
    });

    if (result === "abort" && dispatch) {
      await dispatch("git.mergeAbort", {}, "user");
    }
    return true;
  }

  return false;
}
