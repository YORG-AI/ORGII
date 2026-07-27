import { useEffect } from "react";

import { startVisibilityAwarePoll } from "@src/util/core/visibilityAwarePoll";

import { useAsyncResource } from "./useAsyncResource";

export interface UseVisibilityPolledDataOptions<T> {
  enabled: boolean;
  fetcher: (scopeKey: string) => Promise<T>;
  initialData: T;
  intervalMs: number;
  scopeKey: string | null;
}

export interface UseVisibilityPolledDataResult<T> {
  data: T;
  error: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

/**
 * Own one visibility-aware, scope-fenced polling resource.
 *
 * The first load and manual refresh expose loading state. Background ticks
 * retain the current data without flashing the loading indicator.
 */
export function useVisibilityPolledData<T>({
  enabled,
  fetcher,
  initialData,
  intervalMs,
  scopeKey,
}: UseVisibilityPolledDataOptions<T>): UseVisibilityPolledDataResult<T> {
  const resource = useAsyncResource({
    autoLoad: false,
    enabled,
    fetcher,
    initialData,
    scopeKey,
  });
  const { reload } = resource;

  useEffect(() => {
    if (!enabled || !scopeKey) return undefined;

    let initialLoad = true;
    const poll = startVisibilityAwarePoll({
      intervalMs,
      runImmediately: true,
      task: () => {
        const background = !initialLoad;
        initialLoad = false;
        return reload({ background });
      },
    });
    return () => {
      poll.stop();
    };
  }, [enabled, intervalMs, reload, scopeKey]);

  return {
    data: resource.data,
    error: resource.error,
    loading: resource.loading,
    refresh: resource.refresh,
  };
}
