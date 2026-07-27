import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { LatestScopedTask } from "@src/util/core/latestScopedTask";

export type AsyncResourceStatus =
  | "idle"
  | "loading"
  | "ready"
  | "refreshing"
  | "error";

interface AsyncResourceState<T> {
  data: T;
  error: string | null;
  scopeKey: string | null;
  status: AsyncResourceStatus;
}

export interface UseAsyncResourceOptions<T> {
  autoLoad?: boolean;
  enabled?: boolean;
  fetcher: (
    scopeKey: string,
    context: AsyncResourceFetchContext<T>
  ) => Promise<T>;
  initialData: T;
  initialStatus?: "idle" | "ready";
  scopeKey: string | null;
}

export interface AsyncResourceFetchContext<T> {
  cause: "background" | "load" | "refresh";
  isCurrent(): boolean;
  /** Commit an intermediate cache/stale-while-revalidate value if still current. */
  publish(data: T, options?: { keepLoading?: boolean }): void;
}

export interface AsyncResourceReloadOptions {
  /** Keep the current loading indicator unchanged, for background revalidation. */
  background?: boolean;
  /** Start a new generation instead of joining an equal in-flight scope. */
  supersede?: boolean;
}

export interface UseAsyncResourceResult<T> {
  data: T;
  error: string | null;
  loading: boolean;
  refreshing: boolean;
  reload: (options?: AsyncResourceReloadOptions) => Promise<void>;
  refresh: () => Promise<void>;
  setData: Dispatch<SetStateAction<T>>;
  status: AsyncResourceStatus;
}

/**
 * Own one scope-fenced async resource.
 *
 * Equal automatic loads share an in-flight promise. Manual refreshes start a
 * new generation, and every completion verifies that its scope/generation is
 * still current before committing state.
 */
export function useAsyncResource<T>({
  autoLoad = true,
  enabled = true,
  fetcher,
  initialData,
  initialStatus = "idle",
  scopeKey,
}: UseAsyncResourceOptions<T>): UseAsyncResourceResult<T> {
  const coordinator = useMemo(() => new LatestScopedTask(), []);
  const initialDataRef = useRef(initialData);
  initialDataRef.current = initialData;
  const initialStatusRef = useRef(initialStatus);
  initialStatusRef.current = initialStatus;
  const [state, setState] = useState<AsyncResourceState<T>>({
    data: initialData,
    error: null,
    scopeKey: null,
    status: initialStatus,
  });

  const reload = useCallback(
    async ({
      background = false,
      supersede = false,
    }: AsyncResourceReloadOptions = {}) => {
      if (!enabled || !scopeKey) return;
      if (supersede) coordinator.supersede();

      setState((current) => {
        const isCurrentScope = current.scopeKey === scopeKey;
        const data = isCurrentScope ? current.data : initialDataRef.current;
        if (background && isCurrentScope && current.status === "ready") {
          return { ...current, error: null };
        }
        return {
          data,
          error: null,
          scopeKey,
          status:
            isCurrentScope && current.status !== "idle"
              ? "refreshing"
              : "loading",
        };
      });

      await coordinator.run(scopeKey, async (context) => {
        try {
          const publish = (data: T, options?: { keepLoading?: boolean }) => {
            if (context.isCurrent()) {
              setState((current) => ({
                data,
                error: null,
                scopeKey,
                status: options?.keepLoading ? current.status : "ready",
              }));
            }
          };
          const cause = background
            ? "background"
            : supersede
              ? "refresh"
              : "load";
          const data = await fetcher(scopeKey, {
            cause,
            isCurrent: context.isCurrent,
            publish,
          });
          if (context.isCurrent()) {
            setState({
              data,
              error: null,
              scopeKey,
              status: "ready",
            });
          }
        } catch (error) {
          if (context.isCurrent()) {
            setState((current) => ({
              data:
                current.scopeKey === scopeKey
                  ? current.data
                  : initialDataRef.current,
              error: error instanceof Error ? error.message : String(error),
              scopeKey,
              status: "error",
            }));
          }
        }
      });
    },
    [coordinator, enabled, fetcher, scopeKey]
  );

  useEffect(() => {
    coordinator.supersede();
    if (!enabled || !scopeKey) {
      setState({
        data: initialDataRef.current,
        error: null,
        scopeKey: null,
        status: initialStatusRef.current,
      });
      return undefined;
    }

    if (autoLoad) {
      void reload();
    } else {
      setState({
        data: initialDataRef.current,
        error: null,
        scopeKey,
        status: initialStatusRef.current,
      });
    }

    return () => {
      coordinator.supersede();
    };
  }, [autoLoad, coordinator, enabled, reload, scopeKey]);

  const visibleState =
    enabled && scopeKey && state.scopeKey === scopeKey
      ? state
      : {
          data: initialDataRef.current,
          error: null,
          scopeKey: null,
          status: initialStatusRef.current,
        };

  const setData = useCallback<Dispatch<SetStateAction<T>>>(
    (next) => {
      if (!enabled || !scopeKey) return;
      setState((current) => {
        const currentData =
          current.scopeKey === scopeKey ? current.data : initialDataRef.current;
        return {
          ...current,
          data:
            typeof next === "function"
              ? (next as (current: T) => T)(currentData)
              : next,
          scopeKey,
        };
      });
    },
    [enabled, scopeKey]
  );

  const refresh = useCallback(() => reload({ supersede: true }), [reload]);

  return {
    data: visibleState.data,
    error: visibleState.error,
    loading:
      visibleState.status === "loading" || visibleState.status === "refreshing",
    refreshing: visibleState.status === "refreshing",
    reload,
    refresh,
    setData,
    status: visibleState.status,
  };
}
