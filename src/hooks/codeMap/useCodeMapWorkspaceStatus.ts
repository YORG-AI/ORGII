import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  CODE_MAP_EVENT,
  CODE_MAP_FRESHNESS,
  CODE_MAP_STATUS,
  type CodeMapIndexProgress,
  type CodeMapWorkspaceStatus,
  type CodeMapWorkspaceSummary,
  cancelCodeMapIndex,
  clearCodeMapIndex,
  getCodeMapStatus,
  getManyCodeMapStatuses,
  startCodeMapIndex,
} from "@src/api/tauri/codeMap";

interface UseCodeMapWorkspaceStatusOptions {
  workspacePath?: string | null;
  enabled?: boolean;
}

interface UseCodeMapManyWorkspaceStatusesOptions {
  workspacePaths: string[];
  enabled?: boolean;
}

interface UseCodeMapWorkspaceStatusResult {
  status: CodeMapWorkspaceStatus | null;
  loading: boolean;
  actionLoading: boolean;
  error: string | null;
  isIndexing: boolean;
  isStopping: boolean;
  refresh: () => Promise<void>;
  startIndex: (force?: boolean) => Promise<void>;
  cancelIndex: () => Promise<void>;
  clearIndex: () => Promise<void>;
}

interface UseCodeMapManyWorkspaceStatusesResult {
  statusMap: Record<string, CodeMapWorkspaceSummary>;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isSameWorkspace(
  eventWorkspacePath: string | undefined,
  workspacePath: string
): boolean {
  return eventWorkspacePath === workspacePath;
}

function mergeProgressIntoStatus(
  current: CodeMapWorkspaceStatus | null,
  progress: CodeMapIndexProgress
): CodeMapWorkspaceStatus {
  return {
    workspacePath: progress.workspacePath,
    status: CODE_MAP_STATUS.INDEXING,
    files: current?.files ?? 0,
    symbols: current?.symbols ?? 0,
    relationships: current?.relationships ?? 0,
    unresolved: current?.unresolved ?? 0,
    staleFiles: current?.staleFiles ?? 0,
    indexSizeBytes: current?.indexSizeBytes ?? 0,
    freshness: current?.freshness ?? CODE_MAP_FRESHNESS.UNKNOWN,
    lastIndexedAt: current?.lastIndexedAt ?? null,
    error: progress.error ?? current?.error ?? null,
    progress,
  };
}

export function useCodeMapWorkspaceStatus({
  workspacePath,
  enabled = true,
}: UseCodeMapWorkspaceStatusOptions): UseCodeMapWorkspaceStatusResult {
  const [status, setStatus] = useState<CodeMapWorkspaceStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stopRequested, setStopRequested] = useState(false);

  const canLoad = enabled && Boolean(workspacePath);

  const refresh = useCallback(async () => {
    if (!canLoad || !workspacePath) return;
    setLoading(true);
    setError(null);
    try {
      const nextStatus = await getCodeMapStatus(workspacePath);
      setStatus(nextStatus);
      if (nextStatus.status !== CODE_MAP_STATUS.INDEXING) {
        setStopRequested(false);
      }
    } catch (refreshError) {
      setError(errorToMessage(refreshError));
    } finally {
      setLoading(false);
    }
  }, [canLoad, workspacePath]);

  const runStatusAction = useCallback(
    async (action: () => Promise<CodeMapWorkspaceStatus>) => {
      if (!canLoad || !workspacePath) return;
      setActionLoading(true);
      setError(null);
      try {
        const nextStatus = await action();
        setStatus(nextStatus);
        if (nextStatus.status !== CODE_MAP_STATUS.INDEXING) {
          setStopRequested(false);
        }
      } catch (actionError) {
        setError(errorToMessage(actionError));
      } finally {
        setActionLoading(false);
      }
    },
    [canLoad, workspacePath]
  );

  const handleStartIndex = useCallback(
    async (force = false) => {
      if (!workspacePath) return;
      await runStatusAction(() => startCodeMapIndex(workspacePath, force));
    },
    [runStatusAction, workspacePath]
  );

  const handleCancelIndex = useCallback(async () => {
    if (!canLoad || !workspacePath) return;
    setActionLoading(true);
    setStopRequested(true);
    setError(null);
    try {
      await cancelCodeMapIndex(workspacePath);
      await refresh();
    } catch (cancelError) {
      setError(errorToMessage(cancelError));
    } finally {
      setActionLoading(false);
    }
  }, [canLoad, refresh, workspacePath]);

  const handleClearIndex = useCallback(async () => {
    if (!workspacePath) return;
    await runStatusAction(() => clearCodeMapIndex(workspacePath));
  }, [runStatusAction, workspacePath]);

  useEffect(() => {
    if (!canLoad) {
      setStatus(null);
      setLoading(false);
      setActionLoading(false);
      setError(null);
      setStopRequested(false);
      return;
    }
    void refresh();
  }, [canLoad, refresh]);

  useEffect(() => {
    if (!canLoad || !workspacePath) return;
    let cancelled = false;
    const unlistenStatusPromise = listen<CodeMapWorkspaceStatus>(
      CODE_MAP_EVENT.STATUS_CHANGED,
      (event) => {
        if (cancelled) return;
        if (isSameWorkspace(event.payload.workspacePath, workspacePath)) {
          setStatus(event.payload);
          if (event.payload.status !== CODE_MAP_STATUS.INDEXING) {
            setStopRequested(false);
          }
        }
      }
    );
    const unlistenProgressPromise = listen<CodeMapIndexProgress>(
      CODE_MAP_EVENT.INDEX_PROGRESS,
      (event) => {
        if (cancelled) return;
        if (isSameWorkspace(event.payload.workspacePath, workspacePath)) {
          setStatus((current) =>
            mergeProgressIntoStatus(current, event.payload)
          );
        }
      }
    );

    return () => {
      cancelled = true;
      void unlistenStatusPromise.then((unlisten) => unlisten());
      void unlistenProgressPromise.then((unlisten) => unlisten());
    };
  }, [canLoad, workspacePath]);

  const isIndexing = status?.status === CODE_MAP_STATUS.INDEXING;

  return {
    status,
    loading,
    actionLoading,
    error,
    isIndexing,
    isStopping: stopRequested && isIndexing,
    refresh,
    startIndex: handleStartIndex,
    cancelIndex: handleCancelIndex,
    clearIndex: handleClearIndex,
  };
}

export function useCodeMapManyWorkspaceStatuses({
  workspacePaths,
  enabled = true,
}: UseCodeMapManyWorkspaceStatusesOptions): UseCodeMapManyWorkspaceStatusesResult {
  const normalizedPaths = useMemo(
    () => Array.from(new Set(workspacePaths.filter(Boolean))).sort(),
    [workspacePaths]
  );
  const pathsKey = normalizedPaths.join("\n");
  const [statusMap, setStatusMap] = useState<
    Record<string, CodeMapWorkspaceSummary>
  >({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canLoad = enabled && normalizedPaths.length > 0;

  const refresh = useCallback(async () => {
    if (!canLoad) return;
    setLoading(true);
    setError(null);
    try {
      const statuses = await getManyCodeMapStatuses(normalizedPaths);
      const nextMap = statuses.reduce<Record<string, CodeMapWorkspaceSummary>>(
        (accumulator, item) => {
          accumulator[item.workspacePath] = item;
          return accumulator;
        },
        {}
      );
      setStatusMap(nextMap);
    } catch (refreshError) {
      setError(errorToMessage(refreshError));
    } finally {
      setLoading(false);
    }
  }, [canLoad, normalizedPaths]);

  useEffect(() => {
    if (!canLoad) {
      setStatusMap({});
      setLoading(false);
      setError(null);
      return;
    }
    void refresh();
  }, [canLoad, pathsKey, refresh]);

  useEffect(() => {
    if (!canLoad) return;
    const pathSet = new Set(normalizedPaths);
    let cancelled = false;
    const unlistenStatusPromise = listen<CodeMapWorkspaceStatus>(
      CODE_MAP_EVENT.STATUS_CHANGED,
      (event) => {
        if (cancelled || !pathSet.has(event.payload.workspacePath)) return;
        setStatusMap((current) => ({
          ...current,
          [event.payload.workspacePath]: event.payload,
        }));
      }
    );
    const unlistenProgressPromise = listen<CodeMapIndexProgress>(
      CODE_MAP_EVENT.INDEX_PROGRESS,
      (event) => {
        if (cancelled || !pathSet.has(event.payload.workspacePath)) return;
        setStatusMap((current) => ({
          ...current,
          [event.payload.workspacePath]: mergeProgressIntoStatus(
            current[event.payload.workspacePath] ?? null,
            event.payload
          ),
        }));
      }
    );

    return () => {
      cancelled = true;
      void unlistenStatusPromise.then((unlisten) => unlisten());
      void unlistenProgressPromise.then((unlisten) => unlisten());
    };
  }, [canLoad, normalizedPaths, pathsKey]);

  return { statusMap, loading, error, refresh };
}
