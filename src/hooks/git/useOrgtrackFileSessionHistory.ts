import { useCallback, useEffect, useRef, useState } from "react";

import {
  type OrgtrackFileSessionHistory,
  getOrgtrackFileSessionHistory,
} from "@src/api/tauri/lineage";

const FILE_SESSION_HISTORY_PAGE_SIZE = 30;

export interface UseOrgtrackFileSessionHistoryOptions {
  repoPath: string;
  filePath: string | null;
  autoLoad?: boolean;
}

export interface UseOrgtrackFileSessionHistoryResult {
  history: OrgtrackFileSessionHistory | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  loadMore: () => Promise<void>;
  loadingMore: boolean;
  hasMore: boolean;
}

export function useOrgtrackFileSessionHistory({
  repoPath,
  filePath,
  autoLoad = true,
}: UseOrgtrackFileSessionHistoryOptions): UseOrgtrackFileSessionHistoryResult {
  const [history, setHistory] = useState<OrgtrackFileSessionHistory | null>(
    null
  );
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const loadMoreRequestIdRef = useRef(0);
  const queryKey = `${repoPath}\u0000${filePath ?? ""}`;
  const queryKeyRef = useRef(queryKey);
  queryKeyRef.current = queryKey;

  const refresh = useCallback(async () => {
    const requestQueryKey = `${repoPath}\u0000${filePath ?? ""}`;
    const requestId = ++requestIdRef.current;
    loadMoreRequestIdRef.current += 1;
    setLoadingMore(false);
    if (!filePath || !repoPath) {
      setHistory(null);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const nextHistory = await getOrgtrackFileSessionHistory({
        repoPath,
        filePath,
        limit: FILE_SESSION_HISTORY_PAGE_SIZE,
        offset: 0,
      });
      if (
        requestId === requestIdRef.current &&
        requestQueryKey === queryKeyRef.current
      ) {
        setHistory(nextHistory);
      }
    } catch (err) {
      if (
        requestId === requestIdRef.current &&
        requestQueryKey === queryKeyRef.current
      ) {
        setError(err instanceof Error ? err.message : String(err));
        setHistory(null);
      }
    } finally {
      if (
        requestId === requestIdRef.current &&
        requestQueryKey === queryKeyRef.current
      ) {
        setLoading(false);
      }
    }
  }, [filePath, repoPath]);

  const loadMore = useCallback(async () => {
    if (!filePath || !repoPath || !history?.page.hasMore || loadingMore) return;
    const baseRequestId = requestIdRef.current;
    const loadMoreRequestId = ++loadMoreRequestIdRef.current;
    const requestQueryKey = `${repoPath}\u0000${filePath}`;
    setLoadingMore(true);
    setError(null);
    try {
      const nextPage = await getOrgtrackFileSessionHistory({
        repoPath,
        filePath,
        limit: history.page.limit,
        offset: history.page.offset + history.page.limit,
      });
      if (
        baseRequestId !== requestIdRef.current ||
        loadMoreRequestId !== loadMoreRequestIdRef.current ||
        requestQueryKey !== queryKeyRef.current
      ) {
        return;
      }
      // A concurrent hook/backfill changed ordering while the next page was
      // loading. Restart from page zero instead of merging an unstable page.
      if (nextPage.revision !== history.revision) {
        await refresh();
        return;
      }
      setHistory({
        ...nextPage,
        sessions: [...history.sessions, ...nextPage.sessions],
      });
    } catch (err) {
      if (
        baseRequestId === requestIdRef.current &&
        loadMoreRequestId === loadMoreRequestIdRef.current &&
        requestQueryKey === queryKeyRef.current
      ) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (
        loadMoreRequestId === loadMoreRequestIdRef.current &&
        requestQueryKey === queryKeyRef.current
      ) {
        setLoadingMore(false);
      }
    }
  }, [filePath, history, loadingMore, refresh, repoPath]);

  useEffect(() => {
    if (autoLoad) {
      setHistory(null);
      void refresh();
    }
  }, [autoLoad, refresh]);

  useEffect(() => {
    if (
      !autoLoad ||
      !history ||
      !["queued", "discovering", "indexing"].includes(history.backfill.status)
    ) {
      return;
    }
    const timeout = window.setTimeout(() => {
      void refresh();
    }, 1_000);
    return () => window.clearTimeout(timeout);
  }, [autoLoad, history, refresh]);

  return {
    history,
    loading,
    error,
    refresh,
    loadMore,
    loadingMore,
    hasMore: history?.page.hasMore ?? false,
  };
}
