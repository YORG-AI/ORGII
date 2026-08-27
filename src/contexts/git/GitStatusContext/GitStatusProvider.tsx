/**
 * GitStatusProvider - SINGLE SOURCE OF TRUTH
 *
 * Provides git status for the currently selected repo.
 *
 * This is the ONLY component that should:
 * - Listen to repo:status_updated and file:changed events from Rust
 * - Register repos with the file watcher via invoke("watch_repos")
 * - Update gitStatusAtom and gitSuggestedActionAtom
 *
 * All other components must:
 * - Use useGitStatus() hook for already-scoped current repo status
 * - Call forceRefresh() after mutations (save, stage, commit)
 * - NEVER create their own event listeners
 */
import {
  gitStatusAtom,
  gitSuggestedActionAtom,
  scopedGitStatusAtom,
} from "@/src/store/git";
import { useAtomValue, useSetAtom } from "jotai";
import React, {
  createContext,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { setGitOperationAtom } from "@src/store/git";
import {
  repoMapAtom,
  selectedRepoAtom,
  selectedRepoIdAtom,
} from "@src/store/repo";
import {
  isMultiRootWorkspaceAtom,
  workspaceFoldersAtom,
} from "@src/store/ui/workspaceFoldersAtom";
import type {
  GitRepositoryStatus,
  GitSuggestedAction,
} from "@src/types/session/steps";

import { REPO_SWITCH_DEBOUNCE_MS } from "./constants";
import { useGitEventListeners } from "./hooks/useGitEventListeners";
import { useGitStatusFetch } from "./hooks/useGitStatusFetch";
import { useWatcherRegistration } from "./hooks/useWatcherRegistration";
import type {
  GitStatusContextValue,
  GitStatusRefs,
  StartupState,
} from "./types";

// ============================================
// Context
// ============================================

export const GitStatusContext = createContext<GitStatusContextValue | null>(
  null
);

// ============================================
// Provider
// ============================================

export const GitStatusProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  // Atoms
  const selectedRepoId = useAtomValue(selectedRepoIdAtom);
  const currentRepo = useAtomValue(selectedRepoAtom);
  const repoMap = useAtomValue(repoMapAtom);
  const isMultiRootWorkspace = useAtomValue(isMultiRootWorkspaceAtom);
  const workspaceFolders = useAtomValue(workspaceFoldersAtom);

  // Sync to global atoms
  const setGitStatusAtom = useSetAtom(gitStatusAtom);
  const setScopedGitStatusAtom = useSetAtom(scopedGitStatusAtom);
  const setGitSuggestedActionAtom = useSetAtom(gitSuggestedActionAtom);

  // Git operation broadcasting (for Output panel)
  const setGitOperation = useSetAtom(setGitOperationAtom);

  // Check if repos are loaded OR we have cached repo data
  const reposLoaded = repoMap.size > 0 || !!currentRepo;

  // State
  const [gitStatus, setGitStatus] = useState<GitRepositoryStatus | null>(null);
  const [gitSuggestedAction, setGitSuggestedAction] =
    useState<GitSuggestedAction | null>(null);
  const [statusRepoId, setStatusRepoId] = useState<string | null>(null);
  const [statusRepoPath, setStatusRepoPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ============================================
  // Refs (shared across hooks)
  // ============================================

  const currentRepoIdRef = useRef<string | null>(null);
  const gitStatusRef = useRef<GitRepositoryStatus | null>(null);
  // WebSocket callbacks need the latest committed selection/status without
  // forcing a listener teardown on every status write. A layout effect closes
  // the render-to-external-event gap while keeping render itself pure.
  useLayoutEffect(() => {
    currentRepoIdRef.current = selectedRepoId;
    gitStatusRef.current = gitStatus;
  }, [gitStatus, selectedRepoId]);

  const registeredReposRef = useRef<Set<string>>(new Set());
  const pendingWatcherTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const abortControllerRef = useRef<AbortController | null>(null);
  const intendedRepoIdRef = useRef<string | null>(null);
  const pendingFetchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const startupStateRef = useRef<StartupState>("initializing");
  const fetchInProgressRef = useRef<boolean>(false);

  // Refs collection for passing to hooks (prefixed with _ as some hooks inline these)
  const _refs: GitStatusRefs = {
    currentRepoIdRef,
    gitStatusRef,
    registeredReposRef,
    pendingWatcherTimeoutRef,
    abortControllerRef,
    intendedRepoIdRef,
    pendingFetchTimeoutRef,
    startupStateRef,
    fetchInProgressRef,
  };
  void _refs; // Reserved for future use

  // ============================================
  // Get Repo Path
  // ============================================

  const getRepoPath = useCallback((): string | undefined => {
    return currentRepo?.path || currentRepo?.fs_uri;
  }, [currentRepo]);

  // ============================================
  // Watcher Registration Hook
  // ============================================

  const { scheduleWatcherRegistration, unwatchRegisteredReposExcept } =
    useWatcherRegistration({
      refs: {
        registeredReposRef,
        pendingWatcherTimeoutRef,
      },
    });

  const scheduleActiveWatcherRegistration = useCallback(
    (repoId: string, repoPath: string, repoName?: string) => {
      if (isMultiRootWorkspace) return;
      scheduleWatcherRegistration(repoId, repoPath, repoName);
    },
    [isMultiRootWorkspace, scheduleWatcherRegistration]
  );

  useEffect(() => {
    if (isMultiRootWorkspace) {
      unwatchRegisteredReposExcept(
        new Set(workspaceFolders.map((folder) => folder.id))
      );
      return;
    }

    if (!selectedRepoId) {
      unwatchRegisteredReposExcept(new Set());
      return;
    }

    unwatchRegisteredReposExcept(new Set([selectedRepoId]));
  }, [
    isMultiRootWorkspace,
    selectedRepoId,
    unwatchRegisteredReposExcept,
    workspaceFolders,
  ]);

  // ============================================
  // Fetch Status Hook
  // ============================================

  const { fetchStatus, executeGitOperation } = useGitStatusFetch({
    selectedRepoId,
    getRepoPath,
    repoName: currentRepo?.name,
    refs: {
      abortControllerRef,
      intendedRepoIdRef,
      fetchInProgressRef,
      startupStateRef,
    },
    scheduleWatcherRegistration: scheduleActiveWatcherRegistration,
    setGitStatus,
    setGitSuggestedAction,
    setStatusRepoId,
    setStatusRepoPath,
    setGitStatusAtom,
    setGitSuggestedActionAtom,
    setLoading,
    setError,
  });

  // Mirror fetchStatus and executeGitOperation into refs so the repo-change
  // effect always calls the current version without adding them to deps
  // (they change on every render due to useGitStatusFetch internal memos).
  const fetchStatusRef = useRef(fetchStatus);
  const executeGitOperationRef = useRef(executeGitOperation);

  useEffect(() => {
    fetchStatusRef.current = fetchStatus;
    executeGitOperationRef.current = executeGitOperation;
  });

  // ============================================
  // Event Listeners Hook
  // ============================================

  useGitEventListeners({
    selectedRepoId,
    refs: {
      currentRepoIdRef,
      gitStatusRef,
    },
    setGitStatus,
    setGitSuggestedAction,
    setGitStatusAtom,
    setGitSuggestedActionAtom,
    setGitOperation,
  });

  // ============================================
  // Effect: Fetch when repo changes
  // ============================================

  useEffect(() => {
    // Cancel pending operations from previous repo
    if (pendingWatcherTimeoutRef.current) {
      clearTimeout(pendingWatcherTimeoutRef.current);
      pendingWatcherTimeoutRef.current = null;
    }
    if (pendingFetchTimeoutRef.current) {
      clearTimeout(pendingFetchTimeoutRef.current);
      pendingFetchTimeoutRef.current = null;
    }
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }

    if (!selectedRepoId) {
      intendedRepoIdRef.current = null;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- a committed repo-scope transition must invalidate all repo-owned UI state before the external fetch lifecycle can continue
      setGitStatus(null);
      setGitSuggestedAction(null);
      setStatusRepoId(null);
      setStatusRepoPath(null);
      setGitStatusAtom(null);
      setScopedGitStatusAtom(null);
      setGitSuggestedActionAtom(null);
      setLoading(false);
      return;
    }

    // Wait for repos to load
    if (!reposLoaded) {
      setLoading(true);
      return;
    }

    const repoPath = currentRepo?.path || currentRepo?.fs_uri;
    if (!repoPath) {
      setGitStatus(null);
      setGitSuggestedAction(null);
      setStatusRepoId(null);
      setStatusRepoPath(null);
      setGitStatusAtom(null);
      setScopedGitStatusAtom(null);
      setGitSuggestedActionAtom(null);
      setLoading(false);
      return;
    }

    intendedRepoIdRef.current = selectedRepoId;

    // Clear old status immediately
    setGitStatus(null);
    setGitSuggestedAction(null);
    setStatusRepoId(null);
    setStatusRepoPath(null);
    setGitStatusAtom(null);
    setScopedGitStatusAtom(null);
    setGitSuggestedActionAtom(null);
    setLoading(true);

    if (startupStateRef.current === "initializing") {
      startupStateRef.current = "loading";
    }

    // Debounce fetch — read current versions via refs to avoid stale closures
    // without making fetchStatus/executeGitOperation part of the trigger deps.
    pendingFetchTimeoutRef.current = setTimeout(() => {
      pendingFetchTimeoutRef.current = null;
      executeGitOperationRef.current(fetchStatusRef.current, "critical");
    }, REPO_SWITCH_DEBOUNCE_MS);
  }, [
    selectedRepoId,
    currentRepo?.id,
    currentRepo?.fs_uri,
    currentRepo?.path,
    repoMap.size,
    reposLoaded,
    setGitStatusAtom,
    setScopedGitStatusAtom,
    setGitSuggestedActionAtom,
  ]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (pendingWatcherTimeoutRef.current) {
        clearTimeout(pendingWatcherTimeoutRef.current);
      }
      if (pendingFetchTimeoutRef.current) {
        clearTimeout(pendingFetchTimeoutRef.current);
      }
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  // ============================================
  // Force Refresh
  // ============================================

  const forceRefresh = useCallback(async () => {
    await executeGitOperationRef.current(
      () => fetchStatusRef.current({ silent: true }),
      "critical"
    );
  }, []);

  const currentRepoPath = currentRepo?.path || currentRepo?.fs_uri || null;

  useEffect(() => {
    if (!gitStatus || statusRepoId || statusRepoPath) return;
    if (!selectedRepoId || !currentRepoPath) return;

    // eslint-disable-next-line react-hooks/set-state-in-effect -- a push event can bootstrap status before fetch metadata; attach the already-committed repo identity in the follow-up synchronization pass
    setStatusRepoId(selectedRepoId);
    setStatusRepoPath(currentRepoPath);
  }, [
    gitStatus,
    statusRepoId,
    statusRepoPath,
    selectedRepoId,
    currentRepoPath,
  ]);

  // ============================================
  // Scoped status atom mirror
  // ============================================

  useEffect(() => {
    if (gitStatus && statusRepoId && statusRepoPath) {
      setScopedGitStatusAtom({
        repoId: statusRepoId,
        repoPath: statusRepoPath,
        status: gitStatus,
      });
      return;
    }

    setScopedGitStatusAtom(null);
  }, [gitStatus, statusRepoId, statusRepoPath, setScopedGitStatusAtom]);

  // ============================================
  // Context Value
  // ============================================

  const hasActiveRepo = !!selectedRepoId && reposLoaded && !!currentRepo;
  // Memoize the derived status objects so their references only change when the
  // underlying git data does — otherwise the fresh object literals would defeat
  // the `value` memo below and re-render every `useGitStatus()` consumer on each
  // loading toggle / background ping.
  const scopedGitStatus = useMemo(
    () =>
      gitStatus && statusRepoId && statusRepoPath
        ? { repoId: statusRepoId, repoPath: statusRepoPath, status: gitStatus }
        : null,
    [gitStatus, statusRepoId, statusRepoPath]
  );
  const currentGitStatus =
    scopedGitStatus?.repoId === selectedRepoId &&
    scopedGitStatus.repoPath === currentRepoPath
      ? scopedGitStatus.status
      : null;

  const value = useMemo<GitStatusContextValue>(
    () => ({
      currentGitStatus,
      scopedGitStatus,
      gitSuggestedAction,
      loading,
      error,
      forceRefresh,
      hasActiveRepo,
    }),
    [
      currentGitStatus,
      scopedGitStatus,
      gitSuggestedAction,
      loading,
      error,
      forceRefresh,
      hasActiveRepo,
    ]
  );

  return (
    <GitStatusContext.Provider value={value}>
      {children}
    </GitStatusContext.Provider>
  );
};
