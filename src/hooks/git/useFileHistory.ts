/**
 * useFileHistory Hook
 *
 * Fetches Git commit history for a specific file using the Rust Git API.
 */
import { useCallback, useEffect, useRef } from "react";

import { type GitCommitInfo, getGitCommits } from "@src/api/http/git";
import {
  type AsyncResourceFetchContext,
  useAsyncResource,
} from "@src/hooks/async";

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

interface FileHistoryData {
  commits: GitCommitInfo[];
  totalCount: number | null;
}

const EMPTY_FILE_HISTORY: FileHistoryData = {
  commits: [],
  totalCount: null,
};

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
  const onSuccessRef = useRef(onSuccess);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onSuccessRef.current = onSuccess;
    onErrorRef.current = onError;
  }, [onError, onSuccess]);

  const fetchHistory = useCallback(
    async (
      serializedScope: string,
      context: AsyncResourceFetchContext<FileHistoryData>
    ): Promise<FileHistoryData> => {
      const scope = JSON.parse(serializedScope) as {
        filePath: string;
        limit: number;
        repoId: string;
      };
      try {
        const result = await getGitCommits({
          repo_id: scope.repoId,
          file_path: scope.filePath,
          limit: scope.limit,
        });
        const data = result
          ? { commits: result.commits, totalCount: result.total_count }
          : EMPTY_FILE_HISTORY;
        if (context.isCurrent()) {
          onSuccessRef.current?.(data.commits);
        }
        return data;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (context.isCurrent()) {
          context.publish(EMPTY_FILE_HISTORY);
          onErrorRef.current?.(message);
        }
        throw error;
      }
    },
    []
  );
  const scopeKey = filePath
    ? JSON.stringify({ filePath, limit, repoId })
    : null;
  const resource = useAsyncResource({
    autoLoad,
    enabled: Boolean(scopeKey),
    fetcher: fetchHistory,
    initialData: EMPTY_FILE_HISTORY,
    scopeKey,
  });

  return {
    commits: resource.data.commits,
    loading: resource.loading,
    error: resource.error,
    refresh: resource.refresh,
    totalCount: resource.data.totalCount,
  };
}
