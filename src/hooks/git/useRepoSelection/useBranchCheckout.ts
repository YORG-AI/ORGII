/**
 * useBranchCheckout - Handles branch checkout with conflict resolution
 */
import { useAtom, useAtomValue } from "jotai";
import { useCallback, useEffect, useState } from "react";
import { flushSync } from "react-dom";

import { CheckoutBlockedDialog } from "@src/components/GitDialogs/CheckoutBlockedDialog";
import { CheckoutConflictDialog } from "@src/components/GitDialogs/CheckoutConflictDialog";
import { createLogger } from "@src/hooks/logger";
import { runGuardedCheckout } from "@src/services/git/operations/guardedCheckout";
import {
  REPO_KIND,
  currentBranchAtom,
  selectedRepoAtom,
  selectedRepoIdAtom,
} from "@src/store/repo";
import {
  activeWorkspaceRootPathAtom,
  activeWorktreeAtom,
} from "@src/store/workspace";
import { showGitActionDialogSafely } from "@src/util/dialogs/gitActionDialog";

import {
  addCheckoutStateListener,
  isCheckingOut,
  notifyCheckoutState,
  setIsCheckingOut,
} from "./singleton";
import type { UseBranchCheckoutReturn } from "./types";

const log = createLogger("useBranchCheckout");

export function useBranchCheckout(): UseBranchCheckoutReturn {
  const selectedRepoId = useAtomValue(selectedRepoIdAtom);
  const [currentBranch, setCurrentBranch] = useAtom(currentBranchAtom);
  const selectedRepo = useAtomValue(selectedRepoAtom);
  const activeWorktree = useAtomValue(activeWorktreeAtom);
  const activeWorkspaceRootPath = useAtomValue(activeWorkspaceRootPathAtom);

  const [checkoutLoading, setCheckoutLoading] = useState(isCheckingOut);

  // Subscribe to checkout state changes from any hook instance
  useEffect(() => {
    return addCheckoutStateListener((loading) => setCheckoutLoading(loading));
  }, []);

  const selectBranch = useCallback(
    async (branch: string) => {
      if (!selectedRepoId) {
        log.warn("[useBranchCheckout] Cannot checkout: no repo selected");
        return;
      }

      const repo = selectedRepo;
      const repoPath =
        activeWorktree?.repoId === selectedRepoId
          ? activeWorkspaceRootPath
          : repo?.path || repo?.fs_uri;

      if (!repoPath) {
        log.warn("[useBranchCheckout] Cannot checkout: no repo path");
        return;
      }

      // Plain work folders are not git repos — never call the checkout API.
      if (repo?.kind === REPO_KIND.FOLDER) {
        flushSync(() => {
          setCurrentBranch(branch);
        });
        return;
      }

      // Clearing branch state without git (e.g. after selecting a work folder).
      if (branch.trim() === "") {
        flushSync(() => {
          setCurrentBranch(branch);
        });
        return;
      }

      const previousBranch = currentBranch;

      // Mark checkout in progress
      setIsCheckingOut(true);
      notifyCheckoutState(true);

      // Optimistic update
      flushSync(() => {
        setCurrentBranch(branch);
      });
      try {
        const result = await runGuardedCheckout({
          repoId: selectedRepoId,
          repoPath,
          ref: branch,
          onConflict: (name) =>
            CheckoutConflictDialog.open({ branchName: name }),
          onBlocked: ({ branch: name, errorType, message }) =>
            CheckoutBlockedDialog.open({
              branchName: name,
              errorType,
              message,
            }),
        });

        if (result.success) {
          // Optimistic value already reflects the new branch (the stash/force
          // recovery checked out the same ref), so keep it as-is.
          if (result.outcome !== "checked-out" && result.message) {
            showGitActionDialogSafely(result.message, "info");
          }
        } else {
          // Rollback: nothing was checked out (error or user cancellation).
          setCurrentBranch(previousBranch);
          if (result.outcome !== "cancelled" && !result.blocked) {
            log.error(
              `[useBranchCheckout] Failed to checkout branch "${branch}":`,
              result.message,
              `errorType: ${result.errorType}`
            );
            showGitActionDialogSafely(
              result.message || `Failed to checkout branch "${branch}"`,
              "error"
            );
          }
        }
      } catch (error) {
        setCurrentBranch(previousBranch);
        log.error("[useBranchCheckout] Checkout error:", error);
        showGitActionDialogSafely(
          error instanceof Error
            ? error.message
            : `Failed to checkout branch "${branch}"`,
          "error"
        );
      } finally {
        setIsCheckingOut(false);
        notifyCheckoutState(false);
      }
    },
    [
      selectedRepoId,
      selectedRepo,
      activeWorktree,
      activeWorkspaceRootPath,
      currentBranch,
      setCurrentBranch,
    ]
  );

  return {
    checkoutLoading,
    selectBranch,
  };
}
