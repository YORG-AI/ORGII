import { useCallback, useEffect, useSyncExternalStore } from "react";

import {
  readCachedSnapshot,
  subscribeCachedSnapshot,
} from "@src/api/http/project/cache";

const NOOP_UNSUBSCRIBE = () => undefined;

/** React projection of the project API cache, the single server-state owner. */
export function useProjectCachedResource<T>(options: {
  cacheKey: string | null;
  read: () => Promise<T>;
  empty: T;
  enabled?: boolean;
  refreshToken?: unknown;
}): { data: T; loading: boolean; refresh: () => Promise<T | undefined> } {
  const { cacheKey, read, empty, enabled = true, refreshToken } = options;
  const subscribe = useCallback(
    (listener: () => void) =>
      cacheKey ? subscribeCachedSnapshot(cacheKey, listener) : NOOP_UNSUBSCRIBE,
    [cacheKey]
  );
  const getSnapshot = useCallback(
    () => (cacheKey ? readCachedSnapshot<T>(cacheKey) : undefined),
    [cacheKey]
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const missing = snapshot === undefined;
  const refresh = useCallback(async (): Promise<T | undefined> => {
    if (!cacheKey) return undefined;
    return read();
  }, [cacheKey, read]);

  useEffect(() => {
    if (!enabled || !cacheKey) return;
    void refresh().catch(() => undefined);
  }, [cacheKey, enabled, missing, refresh, refreshToken]);

  return {
    data: snapshot ?? empty,
    loading: Boolean(enabled && cacheKey && missing),
    refresh,
  };
}
