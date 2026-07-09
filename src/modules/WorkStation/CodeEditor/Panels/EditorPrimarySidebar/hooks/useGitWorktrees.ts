/**
 * useGitWorktrees
 *
 * Fetches the list of git worktrees for a repository.
 * Returns linked (non-main) worktrees only — the main worktree
 * is already displayed by the primary Source Control section.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import type {
  GitWorktreeDiffSummary,
  GitWorktreeEntry,
} from "@src/api/http/git/types";
import { getGitWorktrees } from "@src/api/http/git/worktrees";
import { getCodeEditorWebSocket } from "@src/api/realtime/codeEditorWebSocket";
import { useMountedCleanup } from "@src/hooks/lifecycle/useMounted";
import { createLogger } from "@src/hooks/logger";
import {
  DEBOUNCE_DELAYS,
  useDebouncedCallback,
} from "@src/hooks/perf/useDebouncedCallback";

import { extractMainWorktreeDiffSummary } from "../tabs/sourceControlScopePickerHelpers";

const logger = createLogger("useGitWorktrees");

export interface UseGitWorktreesOptions {
  repoId: string;
  repoPath: string;
  enabled?: boolean;
}

export interface UseGitWorktreesResult {
  worktrees: GitWorktreeEntry[];
  /** Uncommitted diff stats for the host repo (main worktree). */
  mainDiffSummary: GitWorktreeDiffSummary | null;
  hasWorktrees: boolean;
  loading: boolean;
  refresh: () => Promise<void>;
}

export function useGitWorktrees({
  repoId,
  repoPath,
  enabled = true,
}: UseGitWorktreesOptions): UseGitWorktreesResult {
  const [worktrees, setWorktrees] = useState<GitWorktreeEntry[]>([]);
  const [mainDiffSummary, setMainDiffSummary] =
    useState<GitWorktreeDiffSummary | null>(null);
  const [loading, setLoading] = useState(enabled);
  const loadedRef = useRef(false);
  const mountedRef = useRef(true);
  useMountedCleanup(mountedRef);

  const fetchWorktrees = useCallback(async () => {
    if (!enabled) return;

    if (!loadedRef.current) setLoading(true);
    try {
      const entries = await getGitWorktrees({
        repo_id: repoId,
        repo_path: repoPath,
      });
      if (!mountedRef.current) return;
      setWorktrees(entries.filter((entry) => !entry.is_main));
      setMainDiffSummary(extractMainWorktreeDiffSummary(entries));
    } catch (error) {
      logger.warn("Failed to fetch git worktrees", error);
    } finally {
      if (mountedRef.current) {
        loadedRef.current = true;
        setLoading(false);
      }
    }
  }, [enabled, repoId, repoPath, mountedRef]);

  const debouncedFetch = useDebouncedCallback(
    () => fetchWorktrees(),
    DEBOUNCE_DELAYS.API
  );

  useEffect(() => {
    loadedRef.current = false;
    setLoading(enabled);
    if (!enabled) {
      setWorktrees([]);
      setMainDiffSummary(null);
      return;
    }

    void fetchWorktrees();
  }, [enabled, fetchWorktrees]);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    const websocket = getCodeEditorWebSocket();
    if (!websocket) return;

    const unsubscribe = websocket.on("repo:status_updated", (data: unknown) => {
      if (cancelled) return;
      if (document.hidden) return;
      const payload = data as { repo_id?: string };
      if (payload.repo_id === repoId) {
        debouncedFetch();
      }
    });

    return () => {
      cancelled = true;
      debouncedFetch.cancel();
      unsubscribe();
    };
  }, [enabled, repoId, debouncedFetch]);

  const visibleWorktrees = enabled ? worktrees : [];

  return {
    worktrees: visibleWorktrees,
    mainDiffSummary: enabled ? mainDiffSummary : null,
    hasWorktrees: visibleWorktrees.length > 0,
    loading,
    refresh: fetchWorktrees,
  };
}
