/**
 * useSystemDependencies
 *
 * Fetches system dependency data from the Tauri backend.
 * Returns the full list plus helpers for filtering by category.
 */
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useMemo } from "react";

import {
  type AsyncResourceFetchContext,
  useAsyncResource,
} from "@src/hooks/async";
import { createLogger } from "@src/hooks/logger";

const log = createLogger("Dependencies");

export const DEP_CATEGORIES = [
  "package-manager",
  "runtime",
  "version-control",
  "toolchain",
  "shell-utility",
  "database",
] as const;

export type DepCategoryId = (typeof DEP_CATEGORIES)[number];

export interface DependencyStatus {
  name: string;
  binary: string;
  installed: boolean;
  version: string | null;
  category: DepCategoryId;
  lastUsed?: string | null;
  /** Suggested install command for the user's platform; absent when no hint exists. */
  installHint?: string | null;
}

interface SystemDependencies {
  dependencies: DependencyStatus[];
  scanDurationMs: number;
  scannedAt: string;
  fromCache: boolean;
}

export const NON_DB_CATEGORIES: DepCategoryId[] = [
  "package-manager",
  "runtime",
  "version-control",
  "toolchain",
  "shell-utility",
];

export function useSystemDependencies() {
  const fetchDependencies = useCallback(
    async (
      _scopeKey: string,
      context: AsyncResourceFetchContext<SystemDependencies | null>
    ) => {
      if (context.cause !== "load") {
        return invoke<SystemDependencies>("detect_system_dependencies");
      }

      let liveSettled = false;
      const cachedPromise = invoke<SystemDependencies>(
        "get_cached_dependencies"
      )
        .then((cached) => {
          if (!liveSettled) context.publish(cached);
          return cached;
        })
        .catch((error: unknown) => {
          log.warn("[Dependencies] cache load failed:", error);
          throw error;
        });
      const livePromise = invoke<SystemDependencies>(
        "detect_system_dependencies"
      ).then(
        (result) => {
          liveSettled = true;
          return result;
        },
        (error: unknown) => {
          liveSettled = true;
          throw error;
        }
      );

      const [cachedResult, liveResult] = await Promise.allSettled([
        cachedPromise,
        livePromise,
      ]);
      if (liveResult.status === "fulfilled") return liveResult.value;
      log.error("[Dependencies] scan failed:", liveResult.reason);
      if (cachedResult.status === "fulfilled") return cachedResult.value;
      throw liveResult.reason;
    },
    []
  );

  const resource = useAsyncResource<SystemDependencies | null>({
    fetcher: fetchDependencies,
    initialData: null,
    scopeKey: "system-dependencies",
  });
  const { data, refresh, refreshing, status } = resource;

  const dependencies = useMemo(() => data?.dependencies ?? [], [data]);

  const byCategory = useCallback(
    (categories: DepCategoryId[]) => {
      const set = new Set<string>(categories);
      return dependencies.filter((dep) => set.has(dep.category));
    },
    [dependencies]
  );

  return {
    dependencies,
    isLoading: status === "loading",
    isRefreshing: refreshing,
    refresh,
    byCategory,
  };
}
