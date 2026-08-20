/**
 * useSystemDependencies
 *
 * Fetches system dependency data from the Tauri backend.
 * Returns the full list plus helpers for filtering by category.
 */
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useState } from "react";

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
  const [data, setData] = useState<SystemDependencies | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);

  useEffect(() => {
    let cancelled = false;

    invoke<SystemDependencies>("get_cached_dependencies")
      .then((result) => {
        if (!cancelled) {
          setData(result);
          setIsLoading(false);
        }
      })
      .catch((err: unknown) => {
        // Cache miss is non-fatal — `detect_system_dependencies` below
        // performs the live scan. Surface the failure for debugging.
        log.warn("[Dependencies] cache load failed:", err);
      });

    invoke<SystemDependencies>("detect_system_dependencies")
      .then((result) => {
        if (!cancelled) {
          setData(result);
          setIsLoading(false);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          log.error("[Dependencies] scan failed:", error);
          setIsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const refresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      const result = await invoke<SystemDependencies>(
        "detect_system_dependencies"
      );
      setData(result);
    } catch (error) {
      log.error("[Dependencies] refresh failed:", error);
    } finally {
      setIsRefreshing(false);
    }
  }, []);

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
    isLoading,
    isRefreshing,
    refresh,
    byCategory,
  };
}
