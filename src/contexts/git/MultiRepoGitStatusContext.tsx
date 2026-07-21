/**
 * MultiRepoGitStatusContext - SINGLETON
 *
 * Single source of truth for multi-repo git status fetching.
 * Replaces multiple useMultiRepoGitStatus instances with one centralized provider.
 *
 * Architecture:
 * - One provider handles all git status fetching for repo lists
 * - Components use useMultiRepoGitStatusContext() to read from cache
 * - Requests to fetch are debounced and deduplicated
 * - Prevents file descriptor exhaustion from concurrent git operations
 *
 * Usage:
 * - Wrap app with <MultiRepoGitStatusProvider>
 * - Components call useMultiRepoGitStatusContext() to get:
 *   - gitStatusMap: Map of repoId -> status
 *   - requestRefresh(repoIds, selectedRepoId): Request status fetch
 *   - isLoading: Whether any fetches are in progress
 */
import {
  RepoGitStatusSummary,
  computeGitStatusRetryDelay,
  gitStatusFetchingReposAtom,
  isRepoGitStatusStale,
  pruneGitStatusCacheAtom,
  repoGitStatusCacheAtom,
} from "@/src/store/git";
import { useAtomValue, useSetAtom } from "jotai";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from "react";

import { gitApi } from "@src/api/http/git";
import { createLogger } from "@src/hooks/logger";
import { repoMapAtom } from "@src/store/repo";
import { gitStatusBatchManager } from "@src/util/api/batchRequest";

const log = createLogger("MultiRepoGitStatusContext");

// ============================================
// Types
// ============================================

interface MultiRepoGitStatusContextValue {
  /** Git status map (repoId -> status summary) */
  gitStatusMap: Map<string, RepoGitStatusSummary>;
  /** Request a refresh for specific repos */
  requestRefresh: (repoIds: string[], selectedRepoId?: string) => void;
  /** Whether any repos are currently being fetched */
  isLoading: boolean;
  /** Attach git status to repo objects */
  attachGitStatus: <T extends { id: string }>(
    repos: T[]
  ) => (T & { gitStatus?: RepoGitStatusSummary })[];
}

// ============================================
// Context
// ============================================

const MultiRepoGitStatusContext =
  createContext<MultiRepoGitStatusContextValue | null>(null);

// ============================================
// Provider
// ============================================

export const MultiRepoGitStatusProvider: React.FC<{
  children: React.ReactNode;
}> = ({ children }) => {
  // Atoms
  const cache = useAtomValue(repoGitStatusCacheAtom);
  const setCache = useSetAtom(repoGitStatusCacheAtom);
  const fetchingRepos = useAtomValue(gitStatusFetchingReposAtom);
  const setFetchingRepos = useSetAtom(gitStatusFetchingReposAtom);
  const pruneCache = useSetAtom(pruneGitStatusCacheAtom);
  const repoMap = useAtomValue(repoMapAtom);

  // Refs for debouncing and request management
  const pendingRequestRef = useRef<{
    repoIds: Set<string>;
    selectedRepoId?: string;
    timeoutId: ReturnType<typeof setTimeout> | null;
  }>({
    repoIds: new Set(),
    selectedRepoId: undefined,
    timeoutId: null,
  });

  // Track if a fetch is currently in progress to prevent overlap
  const isFetchingRef = useRef(false);
  // Concurrency limit for parallel fetches
  const MAX_CONCURRENT_FETCHES = 2;

  // Latest-value refs for atom state read inside callbacks.
  //
  // These exist so `needsRefresh` / `fetchRepoStatus` / `executeFetch` /
  // `requestRefresh` can all be `[]`-dep and therefore STABLE across renders.
  // Reading `cache` / `fetchingRepos` / `repoMap` directly in a dep array
  // rebuilt the whole callback chain on every status write (each write
  // replaces the Map/Set), which handed consumers a new `requestRefresh` on
  // every response.  Consumers that call it from an effect keyed on
  // `requestRefresh` then re-entered the 800ms debounce after each fetch —
  // an accidental TTL-paced poll driven by render churn rather than a timer.
  const cacheRef = useRef(cache);
  cacheRef.current = cache;
  const fetchingReposRef = useRef(fetchingRepos);
  fetchingReposRef.current = fetchingRepos;
  const repoMapRef = useRef(repoMap);
  repoMapRef.current = repoMap;

  // STARTUP OPTIMIZATION (Jan 24, 2026):
  // Track if initial startup is complete. During startup, only fetch selected repo
  // to prevent "bad file descriptor" errors from too many concurrent git processes.
  // Other repos are lazily loaded when user opens components that need them.
  // See: docs/development/bad-file-descriptor-root-cause-0124.md
  const startupCompleteRef = useRef(false);

  // ============================================
  // Derived: Git Status Map
  // ============================================

  const gitStatusMap = useMemo(() => {
    const map = new Map<string, RepoGitStatusSummary>();
    cache.forEach((cached, repoId) => {
      map.set(repoId, cached.status);
    });
    return map;
  }, [cache]);

  // ============================================
  // Check if repo needs refresh
  // ============================================

  const needsRefresh = useCallback(
    (repoId: string, isPriority: boolean): boolean => {
      return isRepoGitStatusStale(cacheRef.current.get(repoId), isPriority);
    },
    []
  );

  // ============================================
  // Fetch single repo status
  // ============================================

  const fetchRepoStatus = useCallback(
    async (repoId: string, priority: number = 0) => {
      // Write a negative cache entry with exponential retry backoff so a
      // failing repo (e.g. deleted path) stops being refetched on every
      // requestRefresh. Consumers can detect `status.error` to render an
      // unavailable state.
      const writeErrorEntry = () => {
        setCache((prev) => {
          const updated = new Map(prev);
          const previous = prev.get(repoId);
          const errorCount = (previous?.errorCount ?? 0) + 1;
          const now = Date.now();
          updated.set(repoId, {
            status: {
              ...(previous?.status ?? {
                uncommittedFiles: 0,
                ahead: 0,
                behind: 0,
              }),
              error: true,
            },
            fetchedAt: now,
            lastAccessed: previous?.lastAccessed ?? now,
            errorCount,
            retryAt: now + computeGitStatusRetryDelay(errorCount),
          });
          return updated;
        });
      };

      try {
        const repo = repoMapRef.current.get(repoId);
        const repoPath = repo?.path || repo?.fs_uri;

        if (!repoPath) {
          log.warn(
            `[MultiRepoGitStatusContext] No path found for repo ${repoId}`
          );
          writeErrorEntry();
          return;
        }
        const statusResponse = await gitStatusBatchManager.add(
          repoId,
          () =>
            gitApi.getGitStatus({
              repo_id: repoId,
              repo_path: repoPath,
              include_untracked: true,
            }),
          { priority }
        );

        const statusData =
          (statusResponse as unknown as { data?: unknown })?.data ||
          statusResponse;

        if (!statusData) {
          log.warn(
            `[MultiRepoGitStatusContext] ❌ No status data for ${repoId}`
          );
          writeErrorEntry();
          return;
        }

        // Type the git status response from Rust backend
        const typedStatus = statusData as {
          working_directory?: { files?: unknown[] };
          branch_ahead_behind?: { ahead?: number; behind?: number };
          do_conflicted_files_exist?: boolean;
          current_upstream_branch?: string;
          exists?: boolean;
        };

        // The backend returns a benign `exists: false` (HTTP 200) for tracked
        // folders that are not git repositories. Write a TERMINAL cache entry
        // with no `retryAt` so it is never refetched — this breaks the infinite
        // error-retry loop that previously surfaced recurring git error popups.
        if (typedStatus.exists === false) {
          setCache((prev) => {
            const updated = new Map(prev);
            updated.set(repoId, {
              status: {
                uncommittedFiles: 0,
                ahead: 0,
                behind: 0,
                notGit: true,
              },
              fetchedAt: Date.now(),
              lastAccessed: Date.now(),
            });
            return updated;
          });
          return;
        }

        const uncommittedFiles =
          typedStatus.working_directory?.files?.length || 0;
        const ahead = typedStatus.branch_ahead_behind?.ahead || 0;
        const behind = typedStatus.branch_ahead_behind?.behind || 0;
        const hasConflicts = typedStatus.do_conflicted_files_exist || false;
        const needsPublish = !typedStatus.current_upstream_branch;
        setCache((prev) => {
          const updated = new Map(prev);
          updated.set(repoId, {
            status: {
              uncommittedFiles,
              ahead,
              behind,
              hasConflicts,
              needsPublish,
            },
            fetchedAt: Date.now(),
            lastAccessed: Date.now(),
          });
          return updated;
        });
      } catch (error) {
        log.error(
          `[MultiRepoGitStatusContext] ❌ Error fetching ${repoId}:`,
          error
        );
        writeErrorEntry();
      }
    },
    [setCache]
  );

  // ============================================
  // Execute batch fetch
  // ============================================

  // Declared before `executeFetch` so the batch-chain recursion below can
  // reach it without a use-before-define.
  const executeFetchRef = useRef<(() => Promise<void>) | null>(null);

  const executeFetch = useCallback(async () => {
    // Prevent overlapping fetches
    if (isFetchingRef.current) {
      return;
    }

    const pending = pendingRequestRef.current;
    const repoIds = Array.from(pending.repoIds);
    const selectedRepoId = pending.selectedRepoId;

    // Clear pending
    pending.repoIds.clear();
    pending.selectedRepoId = undefined;
    pending.timeoutId = null;

    if (repoIds.length === 0) return;

    // Filter repos that actually need refresh
    const reposToFetch = repoIds.filter((repoId) => {
      if (fetchingReposRef.current.has(repoId)) return false;
      const isPriority = repoId === selectedRepoId;
      return needsRefresh(repoId, isPriority);
    });

    if (reposToFetch.length === 0) {
      return;
    }

    // Sort: priority repo first, then limit to MAX_CONCURRENT_FETCHES
    const sortedRepos = [...reposToFetch].sort((a, b) => {
      if (a === selectedRepoId) return -1;
      if (b === selectedRepoId) return 1;
      return 0;
    });

    // Limit concurrent fetches to prevent file descriptor exhaustion
    const limitedRepos = sortedRepos.slice(0, MAX_CONCURRENT_FETCHES);

    isFetchingRef.current = true;

    // Mark as fetching
    setFetchingRepos((prev) => {
      const updated = new Set(prev);
      limitedRepos.forEach((id) => updated.add(id));
      return updated;
    });

    try {
      // Fetch limited repos (priority repo gets higher priority)
      await Promise.allSettled(
        limitedRepos.map(async (repoId) => {
          const priority = repoId === selectedRepoId ? 10 : 0;
          await fetchRepoStatus(repoId, priority);
        })
      );

      // Mark startup as complete after first successful batch
      // Future requests can now lazily load uncached repos
      if (!startupCompleteRef.current) {
        startupCompleteRef.current = true;
      }
    } finally {
      isFetchingRef.current = false;

      // Clear fetching state
      setFetchingRepos((prev) => {
        const updated = new Set(prev);
        limitedRepos.forEach((id) => updated.delete(id));
        return updated;
      });

      // If there are remaining repos to fetch, queue another batch
      const remainingRepos = sortedRepos.slice(MAX_CONCURRENT_FETCHES);
      if (remainingRepos.length > 0) {
        // Queue remaining repos for next batch (with longer delay)
        remainingRepos.forEach((id) =>
          pendingRequestRef.current.repoIds.add(id)
        );
        pendingRequestRef.current.timeoutId = setTimeout(() => {
          // Self-reference through a ref: `executeFetch` is `[]`-dep, so it
          // cannot name itself in its own dep array without churning.
          void executeFetchRef.current?.();
        }, 1000); // Longer delay between batches
      } else {
        // Batch chain finished: evict stale/excess cache entries
        pruneCache();
      }
    }
  }, [needsRefresh, fetchRepoStatus, setFetchingRepos, pruneCache]);

  executeFetchRef.current = executeFetch;

  // ============================================
  // Request refresh (optimized - priority repo only by default)
  // STARTUP OPTIMIZATION: Only fetch selected repo on startup
  // ============================================

  const requestRefresh = useCallback(
    (repoIds: string[], selectedRepoId?: string) => {
      const pending = pendingRequestRef.current;

      // OPTIMIZATION: Only check priority repo on repeated opens
      // Other repos use cached values - refreshed on first load or when explicitly stale
      if (selectedRepoId) {
        // Check if priority repo needs refresh (30s TTL)
        if (needsRefresh(selectedRepoId, true)) {
          pending.repoIds.add(selectedRepoId);
          pending.selectedRepoId = selectedRepoId;
        }
      }

      // STARTUP OPTIMIZATION (Jan 24, 2026):
      // During startup, ONLY fetch the selected repo to prevent file descriptor exhaustion
      // from too many concurrent git processes. Other repos are lazily loaded when user
      // explicitly opens components that need them (e.g., Spotlight dropdown).
      // See: docs/development/bad-file-descriptor-root-cause-0124.md
      if (startupCompleteRef.current) {
        // After startup: queue uncached repos AND cached repos whose TTL
        // (or error-retry backoff) has elapsed, so badges don't go permanently stale.
        for (const repoId of repoIds) {
          if (needsRefresh(repoId, repoId === selectedRepoId)) {
            pending.repoIds.add(repoId);
          }
        }
      }
      // During startup: only the selected repo (already added above if needed).
      // Other repos are fetched when the user opens relevant UI.

      // Nothing to fetch? Skip the debounce machinery
      if (pending.repoIds.size === 0) {
        return;
      }

      // Cancel existing timeout
      if (pending.timeoutId) {
        clearTimeout(pending.timeoutId);
      }

      // Debounce: wait 800ms before executing to let rapid switching stabilize
      pending.timeoutId = setTimeout(() => {
        executeFetch();
      }, 800);
    },
    [executeFetch, needsRefresh]
  );

  // ============================================
  // Attach git status helper
  // ============================================

  const attachGitStatus = useMemo(
    () =>
      <T extends { id: string }>(
        repos: T[]
      ): (T & { gitStatus?: RepoGitStatusSummary })[] => {
        return repos.map((repo) => ({
          ...repo,
          gitStatus: gitStatusMap.get(repo.id),
        }));
      },
    [gitStatusMap]
  );

  // ============================================
  // Cleanup on unmount
  // ============================================

  useEffect(() => {
    // Capture ref to a local variable for cleanup
    const pendingRequest = pendingRequestRef.current;

    return () => {
      if (pendingRequest.timeoutId) {
        clearTimeout(pendingRequest.timeoutId);
      }
    };
  }, []);

  // ============================================
  // Context Value
  // ============================================

  const isLoading = fetchingRepos.size > 0;

  // Memoized: this provider sits at the app root, so an unmemoized object
  // literal re-rendered every consumer on each fetch start/end — `fetchingRepos`
  // is replaced as a new Set even when `isLoading` (a boolean) is unchanged.
  const value = useMemo<MultiRepoGitStatusContextValue>(
    () => ({
      gitStatusMap,
      requestRefresh,
      isLoading,
      attachGitStatus,
    }),
    [gitStatusMap, requestRefresh, isLoading, attachGitStatus]
  );

  return (
    <MultiRepoGitStatusContext.Provider value={value}>
      {children}
    </MultiRepoGitStatusContext.Provider>
  );
};

// ============================================
// Hook
// ============================================

export function useMultiRepoGitStatusContext(): MultiRepoGitStatusContextValue {
  const context = useContext(MultiRepoGitStatusContext);
  if (!context) {
    throw new Error(
      "useMultiRepoGitStatusContext must be used within MultiRepoGitStatusProvider"
    );
  }
  return context;
}

export default MultiRepoGitStatusContext;
