/**
 * useGitWorktrees
 *
 * Fetches the list of git worktrees for a repository.
 * Returns linked (non-main) worktrees only — the main worktree
 * is already displayed by the primary Source Control section.
 */
import { useCallback, useEffect } from "react";

import type {
  GitWorktreeDiffSummary,
  GitWorktreeEntry,
} from "@src/api/http/git/types";
import { getGitWorktrees } from "@src/api/http/git/worktrees";
import { getCodeEditorWebSocket } from "@src/api/realtime/codeEditorWebSocket";
import { useAsyncResource } from "@src/hooks/async";
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

interface GitWorktreesData {
  worktrees: GitWorktreeEntry[];
  mainDiffSummary: GitWorktreeDiffSummary | null;
}

const EMPTY_WORKTREES: GitWorktreesData = {
  worktrees: [],
  mainDiffSummary: null,
};

export function useGitWorktrees({
  repoId,
  repoPath,
  enabled = true,
}: UseGitWorktreesOptions): UseGitWorktreesResult {
  const fetchWorktrees = useCallback(async (serializedScope: string) => {
    const scope = JSON.parse(serializedScope) as {
      repoId: string;
      repoPath: string;
    };
    try {
      const entries = await getGitWorktrees({
        repo_id: scope.repoId,
        repo_path: scope.repoPath,
      });
      return {
        worktrees: entries.filter((entry) => !entry.is_main),
        mainDiffSummary: extractMainWorktreeDiffSummary(entries),
      };
    } catch (error) {
      logger.warn("Failed to fetch git worktrees", error);
      throw error;
    }
  }, []);
  const scopeKey =
    enabled && repoId ? JSON.stringify({ repoId, repoPath }) : null;
  const resource = useAsyncResource({
    enabled: Boolean(scopeKey),
    fetcher: fetchWorktrees,
    initialData: EMPTY_WORKTREES,
    scopeKey,
  });
  const reloadWorktrees = resource.reload;
  const resourceStatus = resource.status;
  const refresh = useCallback(
    () => reloadWorktrees({ background: resourceStatus === "ready" }),
    [reloadWorktrees, resourceStatus]
  );

  const debouncedFetch = useDebouncedCallback(
    () => reloadWorktrees({ background: true }),
    DEBOUNCE_DELAYS.API
  );

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

  const visibleWorktrees = resource.data.worktrees;

  return {
    worktrees: visibleWorktrees,
    mainDiffSummary: resource.data.mainDiffSummary,
    hasWorktrees: visibleWorktrees.length > 0,
    loading: resource.loading,
    refresh,
  };
}
