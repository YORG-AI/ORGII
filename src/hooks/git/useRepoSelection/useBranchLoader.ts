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
  // Both loaders can be in flight at once; keep the flag on until the last
  // one settles so the UI never flashes an empty branch mid-load.
  const branchLoadingCountRef = useRef(0);
  const beginBranchLoading = useCallback(() => {
    branchLoadingCountRef.current += 1;
    setBranchLoading(true);
  }, []);
  const endBranchLoading = useCallback(() => {
    branchLoadingCountRef.current = Math.max(
      0,
      branchLoadingCountRef.current - 1
    );
    if (branchLoadingCountRef.current === 0) setBranchLoading(false);
  }, []);

  // In-flight tracking is keyed by branch context (repo + worktree) and
  // versioned by a sequence number. A request for a NEW context supersedes
  // the in-flight one instead of being dropped — the stale response is
  // discarded when it lands. A boolean "loading" bail here used to drop the
  // new repo's fetch entirely, leaving the branch empty after fast switches.
  const branchListSeqRef = useRef(0);
  const branchListInFlightKeyRef = useRef<string | null>(null);
  const lastBranchRepoRef = useRef<string | null>(null);
  const fastBranchSeqRef = useRef(0);
  const fastBranchInFlightKeyRef = useRef<string | null>(null);
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
    if (fastBranchInFlightKeyRef.current === branchContextKey) return;
    if (lastFastBranchRepoRef.current === branchContextKey) return;

    const repo = selectedRepo;
    if (repo?.kind === REPO_KIND.FOLDER) return;

    // Pass repo_path as a hint when available; the Rust backend falls back to
    // the DB lookup by repo_id alone, so this works even for freshly-created
    // agent repos that haven't been loaded into reposAtom yet.
    const repoPath = activeWorktree
      ? activeWorkspaceRootPath
      : repo?.path || repo?.fs_uri;

    const requestSeq = ++fastBranchSeqRef.current;
    fastBranchInFlightKeyRef.current = branchContextKey;
    beginBranchLoading();

    try {
      const branchName = await gitApi.getGitCurrentBranchName({
        repo_id: selectedRepoId,
        ...(repoPath ? { repo_path: repoPath } : {}),
      });

      // Superseded by a newer request (or a reset) — discard the stale
      // response instead of writing another repo's branch into the atom.
      if (fastBranchSeqRef.current !== requestSeq) return;

      if (branchName) {
        setCurrentBranch(branchName);
        lastFastBranchRepoRef.current = branchContextKey;
      }
    } catch (error) {
      log.error("[useBranchLoader] Failed to fast load current branch:", error);
    } finally {
      if (fastBranchSeqRef.current === requestSeq) {
        fastBranchInFlightKeyRef.current = null;
      }
      endBranchLoading();
    }
  }, [
    selectedRepoId,
    selectedRepo,
    activeWorktree,
    activeWorkspaceRootPath,
    branchContextKey,
    setCurrentBranch,
    beginBranchLoading,
    endBranchLoading,
  ]);

  // ============================================
  // Load Full Branch List (SLOW - for branch dropdown)
  // ============================================

  const loadBranchesImmediate = useCallback(async () => {
    if (isCheckingOut) return;
    if (!selectedRepoId) return;
    if (branchListInFlightKeyRef.current === branchContextKey) return;
    if (lastBranchRepoRef.current === branchContextKey) return;

    const repo = selectedRepo;
    if (repo?.kind === REPO_KIND.FOLDER) return;
    const repoPath = activeWorktree
      ? activeWorkspaceRootPath
      : repo?.path || repo?.fs_uri;

    const requestSeq = ++branchListSeqRef.current;
    branchListInFlightKeyRef.current = branchContextKey;
    beginBranchLoading();

    try {
      const response = await gitApi.getGitBranches({
        repo_id: selectedRepoId,
        ...(repoPath ? { repo_path: repoPath } : {}),
      });

      // Superseded by a newer request (or a reset) — discard stale data.
      if (branchListSeqRef.current !== requestSeq) return;

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
      if (branchListSeqRef.current === requestSeq) {
        branchListInFlightKeyRef.current = null;
      }
      endBranchLoading();
    }
  }, [
    selectedRepoId,
    selectedRepo,
    activeWorktree,
    activeWorkspaceRootPath,
    branchContextKey,
    setBranches,
    setCurrentBranch,
    beginBranchLoading,
    endBranchLoading,
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
    // Invalidate anything still in flight: a reset means the selection is
    // changing, so a response issued before it must not repopulate the atoms.
    branchListSeqRef.current += 1;
    branchListInFlightKeyRef.current = null;
    fastBranchSeqRef.current += 1;
    fastBranchInFlightKeyRef.current = null;
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
