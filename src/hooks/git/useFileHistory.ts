/**
 * useFileHistory Hook
 *
 * Fetches Git commit history for a specific file using the Rust Git API.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { type GitCommitInfo, getGitCommits } from "@src/api/http/git";

export interface UseFileHistoryOptions {
  /** Repository ID */
  repoId: string;
  /** File path to get history for */
  filePath: string | null;
  /** Maximum number of commits to fetch */
  limit?: number;
  /** Auto-load on mount */
  autoLoad?: boolean;
  /** Callback when history loads successfully */
  onSuccess?: (commits: GitCommitInfo[]) => void;
  /** Callback when history load fails */
  onError?: (error: string) => void;
}

export interface UseFileHistoryResult {
  /** Commit history for the file */
  commits: GitCommitInfo[];
  /** Loading state */
  loading: boolean;
  /** Error message */
  error: string | null;
  /** Refresh history */
  refresh: () => Promise<void>;
  /** Total count of commits */
  totalCount: number | null;
}

/**
 * Hook to fetch and manage file commit history
 */
export function useFileHistory({
  repoId,
  filePath,
  limit = 50,
  autoLoad = true,
  onSuccess,
  onError,
}: UseFileHistoryOptions): UseFileHistoryResult {
  const [commits, setCommits] = useState<GitCommitInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [totalCount, setTotalCount] = useState<number | null>(null);

  // Callback props are mirrored into refs so `refresh` stays stable. Keeping
  // them in the dep array meant any caller passing an inline arrow rebuilt
  // `refresh` every render, and the autoLoad effect below — keyed on
  // `refresh` — would then re-issue GET /commits on every render.
  const onSuccessRef = useRef(onSuccess);
  onSuccessRef.current = onSuccess;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const refresh = useCallback(async () => {
    // Don't fetch if no file is selected
    if (!filePath) {
      setCommits([]);
      setTotalCount(null);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const result = await getGitCommits({
        repo_id: repoId,
        file_path: filePath,
        limit,
      });

      if (result) {
        setCommits(result.commits);
        setTotalCount(result.total_count);
        onSuccessRef.current?.(result.commits);
      } else {
        setCommits([]);
        setTotalCount(null);
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(errorMessage);
      setCommits([]);
      setTotalCount(null);
      onErrorRef.current?.(errorMessage);
    } finally {
      setLoading(false);
    }
  }, [repoId, filePath, limit]);

  // Auto-load on mount or when dependencies change
  useEffect(() => {
    if (autoLoad) {
      refresh();
    }
  }, [autoLoad, refresh]);

  return {
    commits,
    loading,
    error,
    refresh,
    totalCount,
  };
}
