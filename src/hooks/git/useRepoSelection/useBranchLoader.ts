/**
 * useBranchLoader - Handles branch loading (fast current branch + full list)
 */
import { useAtom, useAtomValue } from "jotai";
import { useCallback, useRef, useState } from "react";

import { gitApi } from "@src/api/http/git";
import { createLogger } from "@src/hooks/logger";
import {
  type Branch,
  REPO_KIND,
  branchesAtom,
  currentBranchAtom,
  selectedRepoAtom,
  selectedRepoIdAtom,
} from "@src/store/repo";
import {
  activeWorkspaceRootPathAtom,
  activeWorktreeAtom,
} from "@src/store/workspace";
import { debounce } from "@src/util/core/debounce";

import { isCheckingOut } from "./singleton";
import type { UseBranchLoaderReturn } from "./types";

const log = createLogger("useBranchLoader");

export function useBranchLoader(): UseBranchLoaderReturn {
  const selectedRepoId = useAtomValue(selectedRepoIdAtom);
  const [branches, setBranches] = useAtom(branchesAtom);
  const [_currentBranch, setCurrentBranch] = useAtom(currentBranchAtom);
  const selectedRepo = useAtomValue(selectedRepoAtom);
  const activeWorktree = useAtomValue(activeWorktreeAtom);
  const activeWorkspaceRootPath = useAtomValue(activeWorkspaceRootPathAtom);
  const branchContextKey = activeWorktree
    ? `${selectedRepoId}:${activeWorktree.path}`
    : selectedRepoId;

  const [branchLoading, setBranchLoading] = useState(false);

  const loadingBranchesRef = useRef(false);
  const lastBranchRepoRef = useRef<string | null>(null);
  const loadingFastBranchRef = useRef(false);
  const lastFastBranchRepoRef = useRef<string | null>(null);

  // Ref to always call the latest loadBranchesImmediate
  const loadBranchesImmediateRef = useRef<(() => Promise<void>) | undefined>(
    undefined
  );

  // Debounced branch loading
  const debouncedLoadBranchesRef = useRef<
    ReturnType<typeof debounce> | undefined
  >(undefined);

  // ============================================
  // Load Current Branch Name (FAST - for startup)
  // ============================================

  const loadCurrentBranchFast = useCallback(async () => {
    if (isCheckingOut) return;
    if (!selectedRepoId) return;
    if (loadingFastBranchRef.current) return;
    if (lastFastBranchRepoRef.current === branchContextKey) return;

    const repo = selectedRepo;
    if (repo?.kind === REPO_KIND.FOLDER) return;

    // Pass repo_path as a hint when available; the Rust backend falls back to
    // the DB lookup by repo_id alone, so this works even for freshly-created
    // agent repos that haven't been loaded into reposAtom yet.
    const repoPath = activeWorktree
      ? activeWorkspaceRootPath
      : repo?.path || repo?.fs_uri;

    loadingFastBranchRef.current = true;

    try {
      const branchName = await gitApi.getGitCurrentBranchName({
        repo_id: selectedRepoId,
        ...(repoPath ? { repo_path: repoPath } : {}),
      });

      if (branchName) {
        setCurrentBranch(branchName);
        lastFastBranchRepoRef.current = branchContextKey;
      }
    } catch (error) {
      log.error("[useBranchLoader] Failed to fast load current branch:", error);
    } finally {
      loadingFastBranchRef.current = false;
    }
  }, [
    selectedRepoId,
    selectedRepo,
    activeWorktree,
    activeWorkspaceRootPath,
    branchContextKey,
    setCurrentBranch,
  ]);

  // ============================================
  // Load Full Branch List (SLOW - for branch dropdown)
  // ============================================

  const loadBranchesImmediate = useCallback(async () => {
    if (isCheckingOut) return;
    if (!selectedRepoId) return;
    if (loadingBranchesRef.current) return;
    if (lastBranchRepoRef.current === branchContextKey) return;

    const repo = selectedRepo;
    if (repo?.kind === REPO_KIND.FOLDER) return;
    const repoPath = activeWorktree
      ? activeWorkspaceRootPath
      : repo?.path || repo?.fs_uri;

    loadingBranchesRef.current = true;
    setBranchLoading(true);

    try {
      const response = await gitApi.getGitBranches({
        repo_id: selectedRepoId,
        ...(repoPath ? { repo_path: repoPath } : {}),
      });

      if (response) {
        const apiBranches = response.branches || [];
        const gitBranch = response.current_branch || "";

        const branchList: Branch[] = apiBranches.map((branch) => ({
          name: branch.name,
          isCurrent: branch.name === gitBranch,
          isRemote: branch.branch_type === "remote",
        }));

        setBranches(branchList);
        if (gitBranch) {
          setCurrentBranch(gitBranch);
        }

        // Only mark as loaded when we received a non-empty branch list,
        // so repos that start with no commits can retry once data is ready.
        if (apiBranches.length > 0) {
          lastBranchRepoRef.current = branchContextKey;
        }
      }
    } catch (error) {
      log.error("[useBranchLoader] Failed to load branches:", error);
    } finally {
      setBranchLoading(false);
      loadingBranchesRef.current = false;
    }
  }, [
    selectedRepoId,
    selectedRepo,
    activeWorktree,
    activeWorkspaceRootPath,
    branchContextKey,
    setBranches,
    setCurrentBranch,
  ]);

  // Keep ref updated with latest loadBranchesImmediate
  loadBranchesImmediateRef.current = loadBranchesImmediate;

  // Create debounced version on first render
  if (!debouncedLoadBranchesRef.current) {
    debouncedLoadBranchesRef.current = debounce(
      () => {
        loadBranchesImmediateRef.current?.();
      },
      300,
      { maxWait: 1000 }
    );
  }

  const resetBranchTracking = useCallback(() => {
    lastBranchRepoRef.current = null;
    lastFastBranchRepoRef.current = null;
  }, []);

  return {
    branchLoading,
    branchesLoaded: branches.length > 0,
    loadBranchList: debouncedLoadBranchesRef.current,
    refreshBranches: loadBranchesImmediate,
    loadCurrentBranchFast,
    resetBranchTracking,
  };
}
