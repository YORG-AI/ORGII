/**
 * useSpotlightPickerActions Hook
 *
 * Workspace/branch/worktree selection and CRUD action handlers for
 * `GlobalSpotlightInner` — select workspace, select/create/remove a
 * worktree, select/create/delete a branch, checkout detached HEAD.
 * Extracted verbatim from `GlobalSpotlight/index.tsx`; no behavior changes.
 */
import type { TFunction } from "i18next";
import type { Dispatch, SetStateAction } from "react";
import { useCallback } from "react";

import { gitApi, removeGitWorktree } from "@src/api/http/git";
import type { GitWorktreeEntry } from "@src/api/http/git";
import type { Repo } from "@src/store/repo";
import type { WorktreeLaunchSource } from "@src/store/session/worktreeLaunchSourceAtom";
import type { ActiveWorktreeSelection } from "@src/store/workspace";
import { showGitActionDialogSafely } from "@src/util/dialogs/gitActionDialog";

import {
  type WorkspacePickerMode,
  getWorktreeBaseRef,
  getWorktreeCreateName,
} from "../../globalSpotlight.helpers";
import type {
  DeleteBranchOptions,
  DeleteBranchResult,
  RemoveWorktreeOptions,
  RemoveWorktreeResult,
} from "../../palettes/BranchPalette/types";
import { refreshWorktreeMap } from "../../palettes/BranchPalette/useWorktreeMap";
import type { RepoItem } from "../../types";

// ============================================
// Types
// ============================================

export interface UseSpotlightPickerActionsOptions {
  selectedRepoId: string;
  currentRepo: Repo | undefined;
  currentRepoPath: string;
  selectRepo: (repoId: string) => void;
  selectBranch: (branch: string) => Promise<void>;
  refreshBranches: () => Promise<void>;
  closeModal: () => void;
  t: TFunction;
  setActiveWorktree: (selection: ActiveWorktreeSelection | null) => void;
  setCurrentBranch: (branch: string) => void;
  setWorkspacePickerMode: Dispatch<SetStateAction<WorkspacePickerMode | null>>;
  setBranchPickerOpen: Dispatch<SetStateAction<boolean>>;
  setWorktreePickerOpen: Dispatch<SetStateAction<boolean>>;
}

export interface UseSpotlightPickerActionsResult {
  handleWorkspaceSelect: (repoId: string, repo: RepoItem) => void;
  handleWorktreePickerSelect: (worktree: GitWorktreeEntry) => void;
  handleWorktreePickerCreate: (source: WorktreeLaunchSource) => Promise<void>;
  handleBranchPickerSelect: (branchName: string) => Promise<void>;
  handleCreateBranch: (
    branchName: string,
    startPoint?: string
  ) => Promise<void>;
  handleDeleteBranch: (
    branchName: string,
    options?: DeleteBranchOptions
  ) => Promise<DeleteBranchResult>;
  handleRemoveWorktree: (
    worktreePath: string,
    options?: RemoveWorktreeOptions
  ) => Promise<RemoveWorktreeResult>;
  handleCheckoutDetached: () => Promise<void>;
}

// ============================================
// Hook
// ============================================

export function useSpotlightPickerActions(
  deps: UseSpotlightPickerActionsOptions
): UseSpotlightPickerActionsResult {
  const {
    selectedRepoId,
    currentRepo,
    currentRepoPath,
    selectRepo,
    selectBranch,
    refreshBranches,
    closeModal,
    t,
    setActiveWorktree,
    setCurrentBranch,
    setWorkspacePickerMode,
    setBranchPickerOpen,
    setWorktreePickerOpen,
  } = deps;

  const handleWorkspaceSelect = useCallback(
    (repoId: string, _repo: RepoItem) => {
      selectRepo(repoId);
      setWorkspacePickerMode(null);
      closeModal();
    },
    [closeModal, selectRepo, setWorkspacePickerMode]
  );

  const handleWorktreePickerSelect = useCallback(
    (worktree: GitWorktreeEntry) => {
      if (!selectedRepoId) return;
      setActiveWorktree({
        repoId: selectedRepoId,
        path: worktree.path,
        branch: worktree.branch,
        isMain: worktree.is_main,
      });
      setCurrentBranch(worktree.branch);
      setWorktreePickerOpen(false);
      closeModal();
    },
    [
      closeModal,
      selectedRepoId,
      setActiveWorktree,
      setCurrentBranch,
      setWorktreePickerOpen,
    ]
  );

  const handleWorktreePickerCreate = useCallback(
    async (source: WorktreeLaunchSource) => {
      if (!selectedRepoId || !currentRepoPath) {
        showGitActionDialogSafely("No repo selected", "error");
        return;
      }

      const name = getWorktreeCreateName(source);
      const basePath = currentRepoPath.replace(/[/\\]+$/, "");
      const worktreePath = `${basePath}/.orgii/worktrees/${name}`;
      try {
        const created = await gitApi.createGitWorktree({
          repo_id: selectedRepoId,
          repo_path: currentRepoPath,
          worktree_path: worktreePath,
          branch: name,
          base_ref: getWorktreeBaseRef(source),
        });
        await refreshWorktreeMap(selectedRepoId, currentRepoPath);
        handleWorktreePickerSelect(created);
        showGitActionDialogSafely(`Worktree "${name}" created`, "info");
      } catch (error) {
        showGitActionDialogSafely(
          error instanceof Error ? error.message : String(error),
          "error"
        );
      }
    },
    [currentRepoPath, handleWorktreePickerSelect, selectedRepoId]
  );

  const handleBranchPickerSelect = useCallback(
    async (branchName: string) => {
      // Await the guarded checkout BEFORE tearing down the modal — otherwise
      // closeModal() races the CheckoutConflictDialog selectBranch may open.
      await selectBranch(branchName);
      setBranchPickerOpen(false);
      closeModal();
    },
    [closeModal, selectBranch, setBranchPickerOpen]
  );

  const handleCreateBranch = useCallback(
    async (branchName: string, startPoint?: string) => {
      if (!selectedRepoId || !currentRepo) {
        showGitActionDialogSafely("No repo selected", "error");
        return;
      }

      // Create WITHOUT checking out, then route the checkout through
      // selectBranch so a dirty working tree surfaces the CheckoutConflictDialog
      // instead of the raw create+checkout bypassing the guard.
      const result = await gitApi.gitCreateBranch({
        repo_id: selectedRepoId,
        repo_path: currentRepo.path,
        name: branchName,
        start_point: startPoint ?? null,
        checkout: false,
      });

      if (!result.success) {
        showGitActionDialogSafely(
          result.error || `Failed to create branch "${branchName}"`,
          "error"
        );
        return;
      }

      showGitActionDialogSafely(`Branch "${branchName}" created`, "info");
      await selectBranch(branchName);
      setBranchPickerOpen(false);
      closeModal();
    },
    [closeModal, currentRepo, selectBranch, selectedRepoId, setBranchPickerOpen]
  );

  const handleDeleteBranch = useCallback(
    async (
      branchName: string,
      options?: DeleteBranchOptions
    ): Promise<DeleteBranchResult> => {
      if (!selectedRepoId || !currentRepo) {
        const message = "No repo selected";
        if (!options?.silent) {
          showGitActionDialogSafely(message, "error");
        }
        return { success: false, message };
      }

      const result = await gitApi.gitDeleteBranch({
        repo_id: selectedRepoId,
        repo_path: currentRepo.path,
        branch_name: branchName,
      });

      if (!result.success) {
        const message =
          result.error || `Failed to delete branch "${branchName}"`;
        if (!options?.silent) {
          showGitActionDialogSafely(message, "error");
        }
        return { success: false, message };
      }

      if (!options?.silent) {
        showGitActionDialogSafely(`Branch "${branchName}" deleted`, "info");
      }
      if (!options?.skipRefresh) {
        await refreshBranches();
      }
      return { success: true };
    },
    [currentRepo, refreshBranches, selectedRepoId]
  );

  const handleRemoveWorktree = useCallback(
    async (
      worktreePath: string,
      options?: RemoveWorktreeOptions
    ): Promise<RemoveWorktreeResult> => {
      if (!selectedRepoId || !currentRepo) {
        const message = "No repo selected";
        if (!options?.silent) {
          showGitActionDialogSafely(message, "error");
        }
        return { success: false, message };
      }

      try {
        await removeGitWorktree({
          repo_id: selectedRepoId,
          repo_path: currentRepo.path,
          worktree_path: worktreePath,
          force: true,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!options?.silent) {
          showGitActionDialogSafely(message, "error");
        }
        return { success: false, message };
      }

      if (!options?.silent) {
        showGitActionDialogSafely(`Worktree "${worktreePath}" removed`, "info");
      }
      if (!options?.skipRefresh) {
        await refreshBranches();
      }
      return { success: true };
    },
    [currentRepo, refreshBranches, selectedRepoId]
  );

  const handleCheckoutDetached = useCallback(async () => {
    if (!selectedRepoId || !currentRepo) {
      showGitActionDialogSafely("No repo selected", "error");
      return;
    }

    // Route through the guarded checkout flow (selectBranch special-cases
    // HEAD-style refs) so a dirty tree surfaces the CheckoutConflictDialog
    // rather than bypassing it with a raw gitCheckout. selectBranch reports its
    // own failures; we keep the detached-HEAD success copy.
    await selectBranch("HEAD");

    showGitActionDialogSafely(
      t("selectors.branch.actions.checkoutDetachedSuccess"),
      "info"
    );
    await refreshBranches();
    setBranchPickerOpen(false);
    closeModal();
  }, [
    closeModal,
    currentRepo,
    refreshBranches,
    selectBranch,
    selectedRepoId,
    setBranchPickerOpen,
    t,
  ]);

  return {
    handleWorkspaceSelect,
    handleWorktreePickerSelect,
    handleWorktreePickerCreate,
    handleBranchPickerSelect,
    handleCreateBranch,
    handleDeleteBranch,
    handleRemoveWorktree,
    handleCheckoutDetached,
  };
}
