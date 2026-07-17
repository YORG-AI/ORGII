/**
 * useSessionAutoRefresh — periodic + manual refresh for session panels.
 *
 * Stale-while-revalidate semantics:
 * - On mount, hydrate `data` synchronously from an in-memory cache (shared
 *   across hook instances) or, failing that, from `localStorage`. The user
 *   sees the previous results instantly — no spinner — even after restarting
 *   the app.
 * - In parallel, kick off a fresh `fetcher()` call. When it resolves, swap
 *   the new data in and persist it back to the cache.
 * - If the background fetch fails, keep the stale data and surface only the
 *   error. We never blank the list on a transient failure.
 *
 * - Auto-refreshes every `intervalMs` (default 3 min) in the background.
 * - Manual refresh (via `triggerRefresh`) bypasses the interval timer.
 */
import { useCallback, useEffect, useState } from "react";

import { Message } from "@src/components/Message";
import { useVisiblePolling } from "@src/hooks/async";

const DEFAULT_INTERVAL_MS = 3 * 60 * 1000;

const STORAGE_PREFIX = "orgii:devRecord:cache";
const CACHE_VERSION = 1;

interface CacheEntry<T> {
  data: T;
  ts: number;
}

const memoryCache = new Map<string, CacheEntry<unknown>>();

export function __resetSessionCacheForTests(): void {
  memoryCache.clear();
}

export function storageKeyFor(cacheKey: string): string {
  return `${STORAGE_PREFIX}:v${CACHE_VERSION}:${cacheKey}`;
}

export function readPersisted<T>(cacheKey: string): CacheEntry<T> | null {
  const mem = memoryCache.get(cacheKey);
  if (mem) return mem as CacheEntry<T>;

  if (typeof localStorage === "undefined") return null;

  try {
    const raw = localStorage.getItem(storageKeyFor(cacheKey));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CacheEntry<T> | null;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.ts !== "number" ||
      !("data" in parsed)
    ) {
      return null;
    }
    memoryCache.set(cacheKey, parsed as CacheEntry<unknown>);
    return parsed;
  } catch {
    return null;
  }
}

export function writePersisted<T>(cacheKey: string, data: T): void {
  const entry: CacheEntry<T> = { data, ts: Date.now() };
  memoryCache.set(cacheKey, entry as CacheEntry<unknown>);

  if (typeof localStorage === "undefined") return;

  try {
    localStorage.setItem(storageKeyFor(cacheKey), JSON.stringify(entry));
  } catch {
    // Quota exceeded or serialization failed — in-memory cache is still good
    // for the rest of the session, just skip persistence.
  }
}

interface UseSessionAutoRefreshOptions<T> {
  fetcher: () => Promise<T>;
  countFromData: (data: T) => number;
  label: string;
  formatSuccess: (
    label: string,
    count: number
  ) => { title: string; description: string };
  formatError: (label: string) => { title: string; description: string };
  /**
   * Cache key — also used as the persistence key. Must be stable across
   * remounts for the same logical query (e.g. a fixed date range).
   */
  cacheKey: string;
  refreshKey?: number;
  intervalMs?: number;
}

interface UseSessionAutoRefreshResult<T> {
  data: T | null;
  error: string | null;
  isInitialLoad: boolean;
  triggerRefresh: () => void;
}

export function useSessionAutoRefresh<T>({
  fetcher,
  countFromData,
  label,
  formatSuccess,
  formatError,
  cacheKey,
  refreshKey = 0,
  intervalMs = DEFAULT_INTERVAL_MS,
}: UseSessionAutoRefreshOptions<T>): UseSessionAutoRefreshResult<T> {
  const [data, setData] = useState<T | null>(
    () => readPersisted<T>(cacheKey)?.data ?? null
  );
  const [error, setError] = useState<string | null>(null);

  // Re-hydrate local state from the persisted cache when `cacheKey` switches
  // (e.g. the user picked a different date range and an entry already exists
  // for it). React's recommended pattern for "state derived from props" is
  // to keep the previous value in `useState` and call `setState` during
  // render when the prop changes — that lands in the same render commit,
  // no flicker, and avoids both `set-state-in-effect` and
  // ref-during-render lints.
  const [lastCacheKey, setLastCacheKey] = useState(cacheKey);
  if (lastCacheKey !== cacheKey) {
    setLastCacheKey(cacheKey);
    const cached = readPersisted<T>(cacheKey);
    setData(cached?.data ?? null);
    setError(null);
  }

  const effectKey = `${cacheKey}:${refreshKey}`;

  // Spinner only when there's nothing to show at all — neither cached data
  // nor an error yet. Once cache is hydrated, this stays false forever.
  const isInitialLoad = data === null && error === null;

  useEffect(() => {
    let cancelled = false;

    fetcher()
      .then((result) => {
        if (cancelled) return;
        writePersisted(cacheKey, result);
        setData(result);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
    };
  }, [effectKey, fetcher, cacheKey]);

  const backgroundFetch = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const result = await fetcher();
        if (signal?.aborted) return;
        const count = countFromData(result);
        writePersisted(cacheKey, result);
        setData(result);
        setError(null);
        const { title, description } = formatSuccess(label, count);
        Message.success({ title, content: description });
      } catch {
        if (signal?.aborted) return;
        const { title, description } = formatError(label);
        Message.error({ title, content: description });
      }
    },
    [fetcher, countFromData, label, formatSuccess, formatError, cacheKey]
  );

  useVisiblePolling({
    enabled: true,
    intervalMs,
    poll: backgroundFetch,
    immediate: false,
  });

  return { data, error, isInitialLoad, triggerRefresh: backgroundFetch };
}
