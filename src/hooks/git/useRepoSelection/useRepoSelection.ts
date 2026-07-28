/**
 * useRepoSelection Hook
 *
 * SIMPLE repo/branch selection logic. Replaces the complex useRepoManager.
 *
 * Logic:
 * 1. Select repo → update both atoms (selectedRepoId + lastUsedRepo)
 * 2. On repo change → fetch current branch from git
 * 3. On app start → useRepoLoader.loadRepos() is the single source of truth
 *    for restoring selectedRepoId (session > lastUsedRepo > first repo)
 *
 * ARCHITECTURE (Feb 2, 2026):
 * - selectedRepoIdAtom is window-scoped (sessionStorage) for multi-window isolation
 * - lastUsedRepoAtom is global (localStorage) for new window initialization
 * - When selecting a repo, we also update lastUsedRepo for new windows
 * - macOS: Updates ORGII's app-controlled File > Open Recent menu
 *
 * NO complex refs, NO stale closures, NO race conditions.
 */
import { invoke } from "@tauri-apps/api/core";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useRef } from "react";

import { createLogger } from "@src/hooks/logger";
import { currentGitStatusAtom } from "@src/store/git";
import { registerOpenedRepo, unregisterWindow } from "@src/store/repo";
import {
  branchesAtom,
  cachedReposAtom,
  currentBranchAtom,
  lastUsedRepoAtom,
  repoMapAtom,
  reposAtom,
  selectedRepoAtom,
  selectedRepoIdAtom,
  updateCachedRepos,
} from "@src/store/repo";
import { toRepoFileSystemPath } from "@src/store/repo/matchRepoByPath";
import { getWindowId } from "@src/util/core/state/windowId";

import { isCheckingOut } from "./singleton";
import type { UseRepoSelectionOptions, UseRepoSelectionReturn } from "./types";
import { useBranchCheckout } from "./useBranchCheckout";
import { useBranchLoader } from "./useBranchLoader";
import { useRepoLoader } from "./useRepoLoader";

const log = createLogger("useRepoSelection");

export function useRepoSelection(
  options: UseRepoSelectionOptions = {}
): UseRepoSelectionReturn {
  const { autoLoad = true } = options;

  // ============================================
  // Atoms
  // ============================================

  const repos = useAtomValue(reposAtom);
  const [selectedRepoId, setSelectedRepoId] = useAtom(selectedRepoIdAtom);
  const [branches, setBranches] = useAtom(branchesAtom);
  const [currentBranch, setCurrentBranch] = useAtom(currentBranchAtom);
  const [_cachedRepos, setCachedRepos] = useAtom(cachedReposAtom);
  const repoMap = useAtomValue(repoMapAtom);
  const currentRepo = useAtomValue(selectedRepoAtom);
  const currentGitStatus = useAtomValue(currentGitStatusAtom);

  const setLastUsedRepo = useSetAtom(lastUsedRepoAtom);

  // ============================================
  // Sub-hooks
  // ============================================

  const { repoLoading, reposLoaded, loadRepos, forceRefreshRepos } =
    useRepoLoader();

  const {
    branchLoading,
    branchesLoaded,
    loadBranchList,
    refreshBranches,
    loadCurrentBranchFast,
    resetBranchTracking,
  } = useBranchLoader();

  const { checkoutLoading, selectBranch } = useBranchCheckout();

  // ============================================
  // Derived State
  // ============================================

  const isReady = repos.length > 0;

  // ============================================
  // Select Repo
  // ============================================

  const selectRepo = useCallback(
    (repoId: string) => {
      const isSameRepo = repoId === selectedRepoId;
      const repo = repoMap.get(repoId);

      // Branch reset is the only step we can safely skip on re-select; the
      // recent-docs and atom writes below must always run because callers
      // (e.g. SelectRepoPage) rely on this to reaffirm the selection after
      // `useRepoLoader` eagerly restored `lastUsedRepo` into the atom.
      if (!isSameRepo) {
        resetBranchTracking();
        setBranches([]);
        setCurrentBranch("");
      }

      // Update window-scoped atom (auto-persists to sessionStorage)
      setSelectedRepoId(repoId);

      // Also update global lastUsedRepo for new window initialization
      setLastUsedRepo(repoId);

      // Update cached repos
      if (repo) {
        setCachedRepos((prev) => updateCachedRepos(prev, repo));

        const repoPath = toRepoFileSystemPath(repo.path ?? repo.fs_uri);
        if (repoPath) {
          invoke("menu_add_recent", { path: repoPath }).catch((error) => {
            log.debug(
              "[useRepoSelection] Failed to add to menu recent:",
              error
            );
          });
        }
      } else {
        log.warn(
          `[useRepoSelection] WARNING: Repo not found in repoMap for id: ${repoId}`
        );
      }
    },
    [
      selectedRepoId,
      setSelectedRepoId,
      setLastUsedRepo,
      setBranches,
      setCurrentBranch,
      repoMap,
      setCachedRepos,
      resetBranchTracking,
    ]
  );

  // ============================================
  // Effects
  // ============================================

  // Auto-load repos on mount — load immediately. React effects already run
  // after paint, so the UI shell is visible. The previous requestIdleCallback
  // with a 500ms timeout added unnecessary delay to first-load.
  useEffect(() => {
    if (autoLoad) {
      loadRepos();
    }
  }, [autoLoad, loadRepos]);

  // Store Tauri window label for cross-window tracking (resolved once on mount)
  const windowLabelRef = useRef<string | null>(null);
  const windowLabelResolvedRef = useRef(false);

  // Resolve window label once on mount (static - never changes)
  useEffect(() => {
    if (windowLabelResolvedRef.current) return;
    windowLabelResolvedRef.current = true;

    const resolveLabel = async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        windowLabelRef.current = getCurrentWindow().label;
      } catch {
        windowLabelRef.current = getWindowId();
      }
      // Register with the current repo after resolving
      registerOpenedRepo(windowLabelRef.current, selectedRepoId);
    };
    resolveLabel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Register repo changes (after label is resolved)
  useEffect(() => {
    if (!windowLabelRef.current) return;
    registerOpenedRepo(windowLabelRef.current, selectedRepoId);
  }, [selectedRepoId]);

  // Unregister window on unmount (window close)
  useEffect(() => {
    return () => {
      if (windowLabelRef.current) {
        unregisterWindow(windowLabelRef.current);
      }
    };
  }, []);

  // Load current branch when the selected repo changes.
  // Only depend on selectedRepoId — repos.length and repoMap.size are
  // coarse counters that fire on every repo list refresh and cause an
  // extra IPC call even when the selected repo hasn't changed.
  // loadCurrentBranchFast already handles "repo not yet in repoMap" via
  // the Rust DB fallback, so we don't need those guards here.
  useEffect(() => {
    if (!selectedRepoId) return;
    loadCurrentBranchFast();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRepoId]);

  // Sync branch from the scoped current git status. The context only exposes a
  // status here after it has been confirmed to belong to the selected repo.
  useEffect(() => {
    if (isCheckingOut) return;

    const gitBranch = currentGitStatus?.current_branch;
    if (!gitBranch) return;

    if (gitBranch !== currentBranch) {
      setCurrentBranch(gitBranch);
    }
  }, [currentGitStatus?.current_branch, currentBranch, setCurrentBranch]);

  // ============================================
  // Return
  // ============================================

  return {
    // Repos
    repos,
    selectedRepoId,
    currentRepo,
    repoLoading,

    // Branches
    branches,
    currentBranch,
    branchLoading,
    branchesLoaded,
    checkoutLoading,

    // Actions
    selectRepo,
    selectBranch,
    loadRepos,
    forceRefreshRepos,
    refreshBranches,
    loadBranchList,
    isReady,
    reposLoaded,
  };
}

export default useRepoSelection;
