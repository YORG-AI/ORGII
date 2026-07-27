/**
 * Shared backend metadata for the unified tools list (built-in + custom names).
 *
 * Uses module-level caching to prevent re-fetching on every component mount.
 * Similar to simulatorMap.ts caching pattern.
 */
import { useCallback } from "react";

import { useAsyncResource } from "@src/hooks/async";
import { createLogger } from "@src/hooks/logger";
import { invokeTauri } from "@src/util/platform/tauri/init";

import type { RawToolInfo } from "./types";

const log = createLogger("Tools");

// ============================================
// Module-level cache (prevents re-fetch on every mount)
// ============================================

/** Cached tools list (null = not fetched yet). */
let cachedTools: RawToolInfo[] | null = null;
const EMPTY_TOOLS: RawToolInfo[] = [];

/** In-flight fetch promise to prevent duplicate requests. */
let fetchPromise: Promise<RawToolInfo[]> | null = null;

/**
 * Fetch tools with deduplication.
 * Multiple concurrent calls share the same promise.
 */
async function fetchToolsOnce(): Promise<RawToolInfo[]> {
  if (cachedTools !== null) {
    return cachedTools;
  }

  if (fetchPromise !== null) {
    return fetchPromise;
  }

  fetchPromise = invokeTauri<RawToolInfo[]>("list_all_tools")
    .then((result) => {
      cachedTools = result;
      fetchPromise = null;
      return result;
    })
    .catch((err) => {
      fetchPromise = null;
      throw err;
    });

  return fetchPromise;
}

/**
 * Clear the module-level cache and force re-fetch.
 */
export function clearToolsCache(): void {
  cachedTools = null;
  fetchPromise = null;
}

// ============================================
// React hook
// ============================================

export function useUnifiedToolsMetadata() {
  const loadTools = useCallback(async () => {
    try {
      return await fetchToolsOnce();
    } catch (error) {
      log.error("[Tools] Failed to list tools:", error);
      throw error;
    }
  }, []);
  const resource = useAsyncResource({
    fetcher: loadTools,
    initialData: cachedTools ?? EMPTY_TOOLS,
    initialStatus: cachedTools ? "ready" : "idle",
    scopeKey: "unified-tools",
  });
  const refreshResource = resource.refresh;

  const refresh = useCallback(() => {
    clearToolsCache();
    void refreshResource();
  }, [refreshResource]);

  return {
    rawTools: resource.data,
    loading: resource.loading,
    error: resource.error,
    refresh,
  };
}
