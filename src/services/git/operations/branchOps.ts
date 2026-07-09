/**
 * Branch Operations — checkout, stash, stashPop, stashApply, stashDrop
 */
import { gitApi } from "@src/api/http/git";
import type { CheckoutErrorType } from "@src/api/http/git/branchOps";
import type { GitErrorType } from "@src/api/http/git/streaming";
import { CheckoutBlockedDialog } from "@src/components/GitDialogs/CheckoutBlockedDialog";
import { CheckoutConflictDialog } from "@src/components/GitDialogs/CheckoutConflictDialog";

import { TerminalService } from "../../terminal";
import { runGuardedCheckout } from "./guardedCheckout";
import {
  type GitOperationResult,
  getRepoContext,
  parseGitError,
} from "./types";

// ============================================
// Core Operations
// ============================================

/**
 * Raw, unguarded checkout — does NOT surface the `CheckoutConflictDialog` on
 * a dirty working tree.
 *
 * @internal Do NOT call from UI code. Use `checkoutWithDialog` instead, which
 * routes through `runGuardedCheckout` and shows the conflict resolution dialog.
 */
export async function checkoutRaw(
  branch: string,
  create?: boolean
): Promise<GitOperationResult> {
  const cmd = create ? `git checkout -b ${branch}` : `git checkout ${branch}`;
  const repo = getRepoContext();

  if (repo) {
    const result = await runGuardedCheckout({
      repoId: repo.repoId,
      repoPath: repo.repoPath,
      ref: branch,
      create,
      onConflict: (name) => CheckoutConflictDialog.open({ branchName: name }),
      onBlocked: ({ branch: name, errorType, message }) =>
        CheckoutBlockedDialog.open({
          branchName: name,
          errorType,
          message,
        }),
    });
    return {
      success: result.success,
      errorType: toGitErrorType(result.errorType),
      message: result.message,
    };
  }

  try {
    await TerminalService.execute(cmd);
    return { success: true, errorType: "none" };
  } catch (error) {
    const parsed = parseGitError(error);
    return {
      success: false,
      errorType: parsed.type,
      message: parsed.message,
    };
  }
}

/**
 * Stash changes
 */
export async function stash(
  message?: string,
  includeUntracked?: boolean
): Promise<GitOperationResult> {
  const repo = getRepoContext();

  if (repo) {
    try {
      await gitApi.gitStashPush({
        repo_id: repo.repoId,
        repo_path: repo.repoPath,
        message: message || null,
        include_untracked: includeUntracked || false,
      });
      return { success: true, errorType: "none" };
    } catch (error) {
      const parsed = parseGitError(error);
      return {
        success: false,
        errorType: parsed.type,
        message: parsed.message,
      };
    }
  }

  let cmd = "git stash push";
  if (includeUntracked) {
    cmd += " --include-untracked";
  }
  if (message) {
    cmd += ` -m "${message}"`;
  }
  try {
    await TerminalService.execute(cmd);
    return { success: true, errorType: "none" };
  } catch (error) {
    const parsed = parseGitError(error);
    return {
      success: false,
      errorType: parsed.type,
      message: parsed.message,
    };
  }
}

/**
 * Pop a stash by index (apply and remove)
 */
export async function stashPop(index: number = 0): Promise<GitOperationResult> {
  const repo = getRepoContext();

  if (repo) {
    try {
      await gitApi.gitStashApply({
        repo_id: repo.repoId,
        repo_path: repo.repoPath,
        index,
        pop: true,
      });
      return { success: true, errorType: "none" };
    } catch (error) {
      const parsed = parseGitError(error);
      return {
        success: false,
        errorType: parsed.type,
        message: parsed.message,
      };
    }
  }

  try {
    await TerminalService.execute(`git stash pop stash@{${index}}`);
    return { success: true, errorType: "none" };
  } catch (error) {
    const parsed = parseGitError(error);
    return {
      success: false,
      errorType: parsed.type,
      message: parsed.message,
    };
  }
}

/**
 * Apply stash without removing
 */
export async function stashApply(
  index: number = 0
): Promise<GitOperationResult> {
  const repo = getRepoContext();

  if (repo) {
    try {
      await gitApi.gitStashApply({
        repo_id: repo.repoId,
        repo_path: repo.repoPath,
        index,
      });
      return { success: true, errorType: "none" };
    } catch (error) {
      const parsed = parseGitError(error);
      return {
        success: false,
        errorType: parsed.type,
        message: parsed.message,
      };
    }
  }

  try {
    await TerminalService.execute(`git stash apply stash@{${index}}`);
    return { success: true, errorType: "none" };
  } catch (error) {
    const parsed = parseGitError(error);
    return {
      success: false,
      errorType: parsed.type,
      message: parsed.message,
    };
  }
}

/**
 * Drop a stash
 */
export async function stashDrop(
  index: number = 0
): Promise<GitOperationResult> {
  const repo = getRepoContext();

  if (repo) {
    try {
      await gitApi.gitStashDrop({
        repo_id: repo.repoId,
        repo_path: repo.repoPath,
        index,
      });
      return { success: true, errorType: "none" };
    } catch (error) {
      const parsed = parseGitError(error);
      return {
        success: false,
        errorType: parsed.type,
        message: parsed.message,
      };
    }
  }

  try {
    await TerminalService.execute(`git stash drop stash@{${index}}`);
    return { success: true, errorType: "none" };
  } catch (error) {
    const parsed = parseGitError(error);
    return {
      success: false,
      errorType: parsed.type,
      message: parsed.message,
    };
  }
}

// ============================================
// Operations with Error Dialog
// ============================================

/**
 * Map the guarded-checkout core's `CheckoutErrorType` onto the `GitErrorType`
 * used by the `GitOperationResult` contract that ActionSystem callers consume.
 */
function toGitErrorType(errorType: CheckoutErrorType | "none"): GitErrorType {
  if (errorType === "none") return "none";
  if (errorType === "uncommitted_changes") return "uncommitted_changes";
  // branch_not_found / merge_in_progress / rebase_in_progress / other have no
  // dedicated GitErrorType — surface them as the generic failure bucket.
  return "unknown";
}

/**
 * Checkout with conflict handling (Issue #17 de-dup).
 *
 * Routes the ActionSystem `GIT_CHECKOUT` path through the SAME guarded-checkout
 * core as `useBranchCheckout.selectBranch`, so a dirty tree surfaces the unified
 * `CheckoutConflictDialog` (stash/discard/cancel) instead of the old divergent
 * `showGitErrorDialog` flow. The result is mapped back to the
 * `{ success, message, errorType }` contract its callers depend on.
 */
export async function checkoutWithDialog(
  branch: string,
  create?: boolean
): Promise<GitOperationResult> {
  const repoContext = getRepoContext();

  if (!repoContext) {
    // No repo context → fall back to the terminal-based checkout (no dialog).
    return checkoutRaw(branch, create);
  }

  const result = await runGuardedCheckout({
    repoId: repoContext.repoId,
    repoPath: repoContext.repoPath,
    ref: branch,
    create,
    onConflict: (name) => CheckoutConflictDialog.open({ branchName: name }),
    onBlocked: ({ branch: name, errorType, message }) =>
      CheckoutBlockedDialog.open({
        branchName: name,
        errorType,
        message,
      }),
  });

  return {
    success: result.success,
    errorType: toGitErrorType(result.errorType),
    message: result.message,
  };
}
