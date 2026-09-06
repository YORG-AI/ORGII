/**
 * Typed keyed async query with latest-generation-wins semantics.
 *
 * A stable key controls automatic querying, while refresh starts a new
 * generation for that same key. Disabled queries stay at initial data.
 *
 * @example
 * const { data, loading, error, refresh } = useAsyncData({
 *   key: repoPath,
 *   query: detectRepo,
 *   initialData: EMPTY_RESULT,
 *   enabled: Boolean(repoPath),
 * });
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { useMounted } from "@src/hooks/lifecycle/useMounted";

export type AsyncDataErrorMapper = (error: unknown) => string | null;

export interface UseAsyncDataOptions<TData, TKey> {
  key: TKey;
  query: (key: TKey) => Promise<TData>;
  initialData: TData;
  enabled?: boolean;
  fallbackData?: TData | ((error: unknown) => TData);
  mapError?: AsyncDataErrorMapper;
}

export interface UseAsyncDataReturn<TData> {
  data: TData;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

interface AsyncDataSnapshot<TData, TKey> {
  key: TKey;
  generation: number;
  data: TData;
  error: string | null;
}

function defaultMapError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs one async query per stable key/generation. A refresh starts a new
 * generation for the same key, and only the latest generation may commit.
 */
export function useAsyncData<TData, TKey>({
  key,
  query,
  initialData,
  enabled = true,
  fallbackData = initialData,
  mapError = defaultMapError,
}: UseAsyncDataOptions<TData, TKey>): UseAsyncDataReturn<TData> {
  const [generation, setGeneration] = useState(0);
  const [snapshot, setSnapshot] = useState<AsyncDataSnapshot<
    TData,
    TKey
  > | null>(null);
  const latestGenerationRef = useRef(0);
  const queryRef = useRef(query);
  const fallbackDataRef = useRef(fallbackData);
  const mapErrorRef = useRef(mapError);
  const mountedRef = useMounted();

  useEffect(() => {
    queryRef.current = query;
    fallbackDataRef.current = fallbackData;
    mapErrorRef.current = mapError;
  }, [fallbackData, mapError, query]);

  const refresh = useCallback(() => {
    if (mountedRef.current) {
      setGeneration((current) => current + 1);
    }
  }, [mountedRef]);

  useEffect(() => {
    const requestGeneration = ++latestGenerationRef.current;

    if (!enabled) return;

    void queryRef
      .current(key)
      .then((data) => {
        if (
          mountedRef.current &&
          latestGenerationRef.current === requestGeneration
        ) {
          setSnapshot({ key, generation, data, error: null });
        }
      })
      .catch((error: unknown) => {
        if (
          !mountedRef.current ||
          latestGenerationRef.current !== requestGeneration
        ) {
          return;
        }

        const fallback = fallbackDataRef.current;
        const data =
          typeof fallback === "function"
            ? (fallback as (failure: unknown) => TData)(error)
            : fallback;
        setSnapshot({
          key,
          generation,
          data,
          error: mapErrorRef.current(error),
        });
      });

    return () => {
      if (latestGenerationRef.current === requestGeneration) {
        latestGenerationRef.current += 1;
      }
    };
  }, [enabled, generation, key, mountedRef]);

  const current =
    enabled &&
    snapshot?.generation === generation &&
    Object.is(snapshot.key, key)
      ? snapshot
      : null;

  return {
    data: current?.data ?? initialData,
    loading: enabled && current === null,
    error: current?.error ?? null,
    refresh,
  };
}

// ============================================
// Utility: useAsyncAction (for mutations)
// ============================================

export default useAsyncData;
