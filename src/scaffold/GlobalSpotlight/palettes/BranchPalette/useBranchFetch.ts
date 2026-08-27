/**
 * useBranchFetch Hook
 *
 * Handles fetching branches from both Rust/Python backends and GitHub API.
 * Implements caching strategy: show cached data immediately, refresh in background.
 */
import { useAtom, useAtomValue, useStore } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { gitApi } from "@src/api/http/git";
import { useGitHubConnections } from "@src/hooks/git";
import { createLogger } from "@src/hooks/logger";
import {
  branchCacheAtom,
  branchLoadingRepoIdsAtom,
  getBranchesFromCache,
  isBranchCacheFresh,
  repoMapAtom,
  selectedRepoAtom,
  setBranchCacheWithLRU,
} from "@src/store/repo";

import type { BranchItem } from "../../types";
import type { UseBranchFetchOptions } from "./types";

const log = createLogger("useBranchFetch");

export function useBranchFetch(options: UseBranchFetchOptions) {
  const store = useStore();
  const {
    isOpen,
    repoId,
    repoPath: repoPathProp,
    isGitHubRepo,
    githubConnectionId,
    githubRepoFullName,
  } = options;

  // ============ ATOMS ============
  const [branchCache, setBranchCacheAtom] = useAtom(branchCacheAtom);
  const [loadingRepoIds, setLoadingRepoIds] = useAtom(branchLoadingRepoIdsAtom);
  const repoMap = useAtomValue(repoMapAtom);
  const selectedRepo = useAtomValue(selectedRepoAtom);

  // ============ STATE ============
  // Initialize branches directly from cache so first render is never blank.
  const [branches, setBranches] = useState<BranchItem[]>(() => {
    if (isGitHubRepo) return [];
    const cached = getBranchesFromCache(branchCache, repoId);
    return cached && cached.branches.length > 0
      ? (cached.branches as BranchItem[])
      : [];
  });
  const [isFetching, setIsFetching] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const hasFetchedRef = useRef<string | null>(null);
  const intendedRepoIdRef = useRef<string | null>(null);

  // ============ GITHUB CONNECTIONS ============
  const {
    getBranchesForRepo: getGitHubBranches,
    branchesCache: githubBranchesCache,
  } = useGitHubConnections({ autoFetch: false });

  // Get repo path from multiple sources (with fallbacks)
  const repoPath = useMemo(() => {
    if (repoPathProp) return repoPathProp;

    const repo = repoMap.get(repoId);
    if (repo?.path || repo?.fs_uri) {
      return repo.path || repo.fs_uri || "";
    }

    if (selectedRepo && selectedRepo.id === repoId) {
      return selectedRepo.path || selectedRepo.fs_uri || "";
    }

    return "";
  }, [repoPathProp, repoMap, repoId, selectedRepo]);

  // Derive isLoading from both local fetching and global loading state
  const isLoading = isFetching || loadingRepoIds.has(repoId);

  // Effective repo identifier for caching
  const effectiveRepoIdentifier = isGitHubRepo
    ? `${githubConnectionId}:${githubRepoFullName}`
    : repoId;

  // ============ RESET ON REPO CHANGE ============
  useEffect(() => {
    if (hasFetchedRef.current !== effectiveRepoIdentifier) {
      hasFetchedRef.current = null;
      setBranches([]);
    }
    intendedRepoIdRef.current = repoId;
  }, [effectiveRepoIdentifier, repoId]);

  // ============ RESET ON OPEN ============
  useEffect(() => {
    if (isOpen) {
      hasFetchedRef.current = null;
    }
  }, [isOpen]);

  // ============ FETCH GITHUB BRANCHES ============
  useEffect(() => {
    if (
      !isOpen ||
      !isGitHubRepo ||
      !githubConnectionId ||
      !githubRepoFullName
    ) {
      return;
    }

    const cacheKey = `${githubConnectionId}:${githubRepoFullName}`;

    // Check cache first
    const cached = githubBranchesCache.get(cacheKey);
    if (cached && cached.length > 0) {
      const branchItems: BranchItem[] = cached.map((branch) => ({
        name: branch.name,
        lastCommitDate: new Date().toISOString(),
        isCurrent: branch.is_default,
        isDefault: branch.is_default,
        isRemote: true,
        protected: branch.protected,
      }));
      setBranches(branchItems);
      setIsFetching(false);
      return;
    }

    // Fetch from GitHub
    if (hasFetchedRef.current !== cacheKey) {
      hasFetchedRef.current = cacheKey;
      setIsFetching(true);
      getGitHubBranches(githubConnectionId, githubRepoFullName)
        .then((githubBranches) => {
          const branchItems: BranchItem[] = githubBranches.map((branch) => ({
            name: branch.name,
            lastCommitDate: new Date().toISOString(),
            isCurrent: branch.is_default,
            isDefault: branch.is_default,
            isRemote: true,
            protected: branch.protected,
          }));
          setBranches(branchItems);
        })
        .catch((error) => {
          log.error("[useBranchFetch] Error fetching GitHub branches:", error);
        })
        .finally(() => {
          setIsFetching(false);
        });
    }
  }, [
    isOpen,
    isGitHubRepo,
    githubConnectionId,
    githubRepoFullName,
    githubBranchesCache,
    getGitHubBranches,
  ]);

  // ============ SYNC FROM CACHE ============
  useEffect(() => {
    if (!repoId || isGitHubRepo) return;

    const cached = getBranchesFromCache(branchCache, repoId);
    if (cached && cached.branches.length > 0) {
      setBranches(cached.branches as BranchItem[]);
    }
  }, [repoId, branchCache, isGitHubRepo]);

  // ============ FETCH BRANCHES ============
  useEffect(() => {
    if (!isOpen || !repoId || isGitHubRepo) return;

    const loadingRepoIds = store.get(branchLoadingRepoIdsAtom);
    if (loadingRepoIds.has(repoId)) return;

    const branchCache = store.get(branchCacheAtom);
    const cached = getBranchesFromCache(branchCache, repoId);
    const hasCachedData = cached && cached.branches.length > 0;

    if (hasCachedData && isBranchCacheFresh(branchCache, repoId)) {
      hasFetchedRef.current = repoId;
      return;
    }

    if (hasFetchedRef.current === repoId) return;
    hasFetchedRef.current = repoId;
    const fetchRepoId = repoId;
    intendedRepoIdRef.current = fetchRepoId;

    let cancelled = false;

    async function fetchBranches() {
      if (!hasCachedData) {
        setLoadingRepoIds((prev) => new Set(prev).add(fetchRepoId));
        setIsFetching(true);
      }

      try {
        const response = await gitApi.getGitBranches({
          repo_id: fetchRepoId,
          ...(repoPath ? { repo_path: repoPath } : {}),
          include_remote: true,
        });

        // Only skip the cache write if we've since moved to a different repo.
        // A torn-down/superseded effect for the *same* repo id should still
        // populate the repo-keyed cache — otherwise a re-run that early-returns
        // (because this fetch already marked the repo as loading) would leave
        // the repo with no data and no scheduled retry.
        if (intendedRepoIdRef.current !== fetchRepoId) return;

        if (response?.branches) {
          const branchList = (response.branches || []).map(
            (branch: unknown) => {
              const branchData = branch as {
                name: string;
                is_current: boolean;
                branch_type: string;
                last_commit_date?: string;
              };
              return {
                name: branchData.name,
                isCurrent: branchData.is_current,
                isRemote: branchData.branch_type === "remote",
                lastCommitDate: branchData.last_commit_date,
              };
            }
          );

          setBranchCacheAtom((prev) =>
            setBranchCacheWithLRU(prev, fetchRepoId, {
              branches: branchList,
              currentBranch: response.current_branch || "",
              fetchedAt: Date.now(),
            })
          );
        }
      } catch (error) {
        if (cancelled || intendedRepoIdRef.current !== fetchRepoId) return;
        log.error("[useBranchFetch] Failed to fetch branches:", error);
      } finally {
        // Always release the loading flag for this repo once the request
        // settles — even when the effect was torn down or superseded. Gating
        // this on `!cancelled` leaked the repo id into the global
        // `branchLoadingRepoIdsAtom`, which permanently pinned the palette to
        // the "loading" state and blocked all future fetches (via the
        // `loadingRepoIds.has(repoId)` guard in the fetch effect above).
        setIsFetching(false);
        setLoadingRepoIds((prev) => {
          if (!prev.has(fetchRepoId)) return prev;
          const next = new Set(prev);
          next.delete(fetchRepoId);
          return next;
        });
      }
    }

    fetchBranches();

    return () => {
      cancelled = true;
    };
  }, [
    isOpen,
    repoId,
    repoPath,
    isGitHubRepo,
    refreshNonce,
    setBranchCacheAtom,
    setLoadingRepoIds,
    store,
  ]);

  const refresh = useCallback(() => {
    hasFetchedRef.current = null;
    if (repoId) {
      setBranchCacheAtom((prev) => {
        if (!prev.has(repoId)) return prev;
        const next = new Map(prev);
        next.delete(repoId);
        return next;
      });
    }
    setRefreshNonce((n) => n + 1);
  }, [repoId, setBranchCacheAtom]);

  return {
    branches,
    isLoading,
    repoPath,
    refresh,
  };
}
