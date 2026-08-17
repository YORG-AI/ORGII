/**
 * useSearchResults Hook
 *
 * Manages search results state via Jotai atoms.
 * Handles result memoization, load more (progressive loading),
 * and result clearing.
 */
import { type UnlistenFn, listen } from "@tauri-apps/api/event";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useCallback, useMemo } from "react";

import {
  type SearchCompleteEvent,
  type SearchResultEvent,
  searchCodeStreaming,
} from "@src/api/tauri/search";
import { createLogger } from "@src/hooks/logger";
import type {
  SearchOptions as StoreSearchOptions,
  SearchResultFile as StoreSearchResultFile,
} from "@src/store/workstation/codeEditor/search";
import {
  searchActualTotalFilesAtom,
  searchActualTotalMatchesAtom,
  searchAppendResultsAtom,
  searchClearAtom,
  searchErrorAtom,
  searchHasMoreAtom,
  searchLoadingAtom,
  searchLoadingMoreAtom,
  searchResultsAtom,
  searchTotalFilesAtom,
  searchTotalMatchesAtom,
} from "@src/store/workstation/codeEditor/search";

import { SEARCH_CONSTANTS } from "../config";
import type { SearchResultFile } from "../types";
import {
  buildSearchFilters,
  parseFilePatterns,
  toUIResult,
} from "./transformers";
import type { SearchResultActions } from "./types";

const log = createLogger("useSearchResults");

export interface UseSearchResultsReturn {
  /** Search results (UI format) */
  results: SearchResultFile[];
  /** Loading state */
  loading: boolean;
  /** Loading more results */
  loadingMore: boolean;
  /** Error message */
  error: string | null;
  /** Whether more results are available */
  hasMore: boolean;
  /** Total matches (loaded) */
  totalMatches: number;
  /** Total files (loaded) */
  totalFiles: number;
  /** Actual total matches (may be more than loaded) */
  actualTotalMatches: number;
  /** Actual total files (may be more than loaded) */
  actualTotalFiles: number;
  /** Whether results were truncated at max limit */
  isTruncated: boolean;
  /** Clear all results and reset state */
  clearResults: () => void;
  /** Load more results via streaming */
  loadMore: (
    query: string,
    repoPath: string,
    storeOptions: StoreSearchOptions
  ) => Promise<void>;
  /** Actions for useSearchExecution to manage state */
  actions: SearchResultActions;
}

export function useSearchResults(): UseSearchResultsReturn {
  // Read from Jotai atoms
  const [storeResults, setResults] = useAtom(searchResultsAtom);
  const [loading, setLoading] = useAtom(searchLoadingAtom);
  const [loadingMore, setLoadingMore] = useAtom(searchLoadingMoreAtom);
  const [error, setError] = useAtom(searchErrorAtom);
  const [hasMore, setHasMore] = useAtom(searchHasMoreAtom);
  const [actualTotalMatches, setActualTotalMatches] = useAtom(
    searchActualTotalMatchesAtom
  );
  const [actualTotalFiles, setActualTotalFiles] = useAtom(
    searchActualTotalFilesAtom
  );
  const totalMatches = useAtomValue(searchTotalMatchesAtom);
  const totalFiles = useAtomValue(searchTotalFilesAtom);
  const appendResults = useSetAtom(searchAppendResultsAtom);
  const clearAtom = useSetAtom(searchClearAtom);

  // PERFORMANCE: Memoize results array to prevent recreation on every render.
  // Critical for scroll preservation — VirtualizedSearchResults uses
  // arePropsEqual which compares results by reference.
  const results = useMemo(() => storeResults.map(toUIResult), [storeResults]);

  const clearResults = useCallback(() => {
    clearAtom();
  }, [clearAtom]);

  // PHASE 11: Progressive loading — load more results when scrolling to end
  const loadMore = useCallback(
    async (
      query: string,
      repoPath: string,
      storeOptions: StoreSearchOptions
    ) => {
      if (!hasMore || loadingMore || !query.trim()) return;

      setLoadingMore(true);
      // Hoisted so `finally` can always drop both Tauri listeners. They used
      // to be unlistened only on the success path; a rejected
      // `searchCodeStreaming` (invalid regex, repo unmounted, …) left both
      // handlers — each closing over the whole current result set —
      // registered for the process lifetime and running on every later
      // `search-result` event.
      let resultUnlisten: UnlistenFn | null = null;
      let completeUnlisten: UnlistenFn | null = null;
      try {
        const currentMatchCount = totalMatches;
        // Request a larger batch to get more results
        const newLimit = currentMatchCount + SEARCH_CONSTANTS.BATCH_SIZE * 20; // 1000 more matches

        const loadMoreSearchId = `loadmore-${Date.now()}-${Math.random().toString(36).slice(2)}`;

        // Setup temporary listeners for this load more operation
        const loadMoreResults: StoreSearchResultFile[] = [];
        let loadMoreComplete = false;

        resultUnlisten = await listen<SearchResultEvent>(
          "search-result",
          (event) => {
            if (event.payload.search_id !== loadMoreSearchId) return;
            // Only append results we don't already have
            const result = event.payload.result;
            const exists = storeResults.some(
              (existingResult) => existingResult.file_path === result.file_path
            );
            if (!exists) {
              loadMoreResults.push(result);
            }
          }
        );

        completeUnlisten = await listen<SearchCompleteEvent>(
          "search-complete",
          (event) => {
            if (event.payload.search_id !== loadMoreSearchId) return;
            loadMoreComplete = true;
            // Only update hasMore — don't overwrite actualTotals since they
            // reflect the original search limit, not the cumulative loaded count
            setHasMore(event.payload.has_more);
          }
        );

        // Parse file patterns from options
        const includePatterns = parseFilePatterns(storeOptions.filesToInclude);
        const excludePatterns = parseFilePatterns(storeOptions.filesToExclude);
        const filters = buildSearchFilters(
          storeOptions,
          includePatterns,
          excludePatterns
        );

        // Start streaming search with higher limit
        await searchCodeStreaming(loadMoreSearchId, query.trim(), repoPath, {
          ...filters,
          max_results: newLimit,
        });

        // Wait for completion (with timeout)
        const startTime = Date.now();
        while (!loadMoreComplete && Date.now() - startTime < 30000) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }

        // Append new results
        if (loadMoreResults.length > 0) {
          appendResults(loadMoreResults);
        }
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : "Failed to load more";
        log.error("[useSearchResults] Load more error:", errorMessage);
        setError(errorMessage);
      } finally {
        // Always release the per-request listeners (success, error, timeout).
        resultUnlisten?.();
        completeUnlisten?.();
        setLoadingMore(false);
      }
    },
    [
      hasMore,
      loadingMore,
      totalMatches,
      storeResults,
      appendResults,
      setHasMore,
      setError,
      setLoadingMore,
    ]
  );

  const isTruncated = actualTotalMatches >= SEARCH_CONSTANTS.MAX_TOTAL_RESULTS;

  // Actions interface for useSearchExecution
  const actions: SearchResultActions = useMemo(
    () => ({
      setResults,
      setLoading,
      setError,
      setHasMore,
      setActualTotalMatches,
      setActualTotalFiles,
      appendResults,
      clearAtom,
    }),
    [
      setResults,
      setLoading,
      setError,
      setHasMore,
      setActualTotalMatches,
      setActualTotalFiles,
      appendResults,
      clearAtom,
    ]
  );

  return {
    results,
    loading,
    loadingMore,
    error,
    hasMore,
    totalMatches,
    totalFiles,
    actualTotalMatches,
    actualTotalFiles,
    isTruncated,
    clearResults,
    loadMore,
    actions,
  };
}
