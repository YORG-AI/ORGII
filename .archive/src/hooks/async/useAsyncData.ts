/**
 * useAsyncData Hook
 *
 * Generic hook for async data fetching with loading/error state management.
 * Consolidates the common pattern found across 60+ hooks in the codebase.
 *
 * Features:
 * - Unified loading/error/data state management
 * - Auto-load on mount with dependency tracking
 * - Success/error callbacks
 * - Manual refresh capability
 * - Type-safe with generics
 *
 * @example
 * const { data, loading, error, refresh } = useAsyncData({
 *   fetcher: () => api.fetchItems(),
 *   initialData: [],
 *   errorPrefix: "Failed to load items",
 * });
 */
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useState,
} from "react";

import { useMounted } from "@src/hooks/lifecycle/useMounted";

// ============================================
// Type Definitions
// ============================================

export interface UseAsyncDataOptions<T> {
  /** Async function to fetch data */
  fetcher: () => Promise<T>;
  /** Auto-load on mount (default: true) */
  autoLoad?: boolean;
  /** Dependencies that trigger refetch when changed */
  deps?: unknown[];
  /** Success callback */
  onSuccess?: (data: T) => void;
  /** Error callback */
  onError?: (error: Error) => void;
  /** Initial data value */
  initialData?: T;
  /** Error message prefix for generic errors */
  errorPrefix?: string;
  /** Skip fetch if condition is false */
  enabled?: boolean;
}

export interface UseAsyncDataReturn<T> {
  /** The fetched data */
  data: T;
  /** Loading state */
  loading: boolean;
  /** Error message (null if no error) */
  error: string | null;
  /** Manually trigger a refresh */
  refresh: () => Promise<void>;
  /** Directly update the data state */
  setData: Dispatch<SetStateAction<T>>;
  /** Clear the error state */
  clearError: () => void;
}

// ============================================
// Hook Implementation
// ============================================

export function useAsyncData<T>(
  options: UseAsyncDataOptions<T>
): UseAsyncDataReturn<T> {
  const {
    fetcher,
    autoLoad = true,
    deps = [],
    onSuccess,
    onError,
    initialData,
    errorPrefix = "Failed to load data",
    enabled = true,
  } = options;

  // State
  const [data, setData] = useState<T>(initialData as T);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mountedRef = useMounted();

  // Refresh function
  const refresh = useCallback(async () => {
    if (!enabled) {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const result = await fetcher();

      if (mountedRef.current) {
        setData(result);
        onSuccess?.(result);
      }
    } catch (err) {
      if (mountedRef.current) {
        const message =
          err instanceof Error ? err.message : `${errorPrefix}: ${String(err)}`;
        setError(message);
        onError?.(err instanceof Error ? err : new Error(message));
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, [fetcher, enabled, errorPrefix, onSuccess, onError, mountedRef]);

  // Clear error helper
  const clearError = useCallback(() => {
    setError(null);
  }, []);

  // Auto-load on mount and when deps change
  useEffect(() => {
    if (autoLoad && enabled) {
      refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- callers explicitly own the refetch clock through deps; refresh stays current for manual calls without making fetcher identity an implicit trigger
  }, [autoLoad, enabled, ...deps]);

  return {
    data,
    loading,
    error,
    refresh,
    setData,
    clearError,
  };
}

// ============================================
// Utility: useAsyncAction (for mutations)
// ============================================

export interface UseAsyncActionOptions {
  /** Success callback */
  onSuccess?: () => void;
  /** Error callback */
  onError?: (error: Error) => void;
  /** Error message prefix */
  errorPrefix?: string;
}

export interface UseAsyncActionReturn<TArgs extends unknown[], TResult> {
  /** Execute the action */
  execute: (...args: TArgs) => Promise<TResult | null>;
  /** Loading state */
  loading: boolean;
  /** Error message */
  error: string | null;
  /** Clear error */
  clearError: () => void;
}

/**
 * Hook for async actions/mutations (create, update, delete operations)
 *
 * @example
 * const { execute: createItem, loading } = useAsyncAction(
 *   async (name: string) => {
 *     return await api.createItem({ name });
 *   },
 *   { onSuccess: refresh }
 * );
 */
export function useAsyncAction<TArgs extends unknown[], TResult>(
  action: (...args: TArgs) => Promise<TResult>,
  options: UseAsyncActionOptions = {}
): UseAsyncActionReturn<TArgs, TResult> {
  const { onSuccess, onError, errorPrefix = "Action failed" } = options;

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mountedRef = useMounted();

  const execute = useCallback(
    async (...args: TArgs): Promise<TResult | null> => {
      setLoading(true);
      setError(null);

      try {
        const result = await action(...args);

        if (mountedRef.current) {
          onSuccess?.();
        }

        return result;
      } catch (err) {
        if (mountedRef.current) {
          const message =
            err instanceof Error
              ? err.message
              : `${errorPrefix}: ${String(err)}`;
          setError(message);
          onError?.(err instanceof Error ? err : new Error(message));
        }
        return null;
      } finally {
        if (mountedRef.current) {
          setLoading(false);
        }
      }
    },
    [action, errorPrefix, onSuccess, onError, mountedRef]
  );

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  return {
    execute,
    loading,
    error,
    clearError,
  };
}

export default useAsyncData;
