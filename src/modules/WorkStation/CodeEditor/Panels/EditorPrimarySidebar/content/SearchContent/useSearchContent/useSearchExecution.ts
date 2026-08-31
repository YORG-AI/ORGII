/**
 * useSearchExecution Hook
 *
 * Handles regex search execution.
 * Manages streaming listeners, debounced triggering, and cleanup.
 */
import { type UnlistenFn, listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef } from "react";

import {
  type SearchCompleteEvent,
  type SearchResultEvent,
  cancelSearch,
  searchCodeFast,
  searchCodeRegex,
  searchCodeStreaming,
} from "@src/api/tauri/search";
import { createLogger } from "@src/hooks/logger";
import { useDebouncedCallback } from "@src/hooks/perf/useDebouncedCallback";
import type {
  SearchOptions as StoreSearchOptions,
  SearchResultFile as StoreSearchResultFile,
} from "@src/store/workstation/codeEditor/search";

import { SEARCH_CONSTANTS } from "../config";
import type { SearchMode } from "../types";
import {
  buildSearchFilters,
  filterResultsByGlob,
  parseFilePatterns,
} from "./transformers";
import type { SearchResultActions } from "./types";

const log = createLogger("useSearchExecution");

// Module-level constants for search mode flags
const USE_FAST_SEARCH = true;
const USE_STREAMING_SEARCH = true;
const FLUSH_INTERVAL_MS = 100;

interface UseSearchExecutionParams {
  query: string;
  searchMode: SearchMode;
  repoPath: string;
  openFiles?: string[];
  storeOptions: StoreSearchOptions;
  resultActions: SearchResultActions;
}

export interface UseSearchExecutionReturn {
  /** Execute search */
  search: () => Promise<void>;
}

export function useSearchExecution(
  params: UseSearchExecutionParams
): UseSearchExecutionReturn {
  const {
    query,
    searchMode,
    repoPath,
    openFiles,
    storeOptions,
    resultActions,
  } = params;

  const {
    setResults,
    setLoading,
    setError,
    setHasMore,
    setActualTotalMatches,
    setActualTotalFiles,
    appendResults,
    clearAtom,
  } = resultActions;

  // Refs for managing search lifecycle
  const abortControllerRef = useRef<AbortController | null>(null);
  const searchIdRef = useRef<string>("");
  // Track the last executed search query+options to avoid re-searching on remount
  // Format: "query|caseSensitive|wholeWord|useRegex|filesToInclude|filesToExclude"
  const lastSearchKeyRef = useRef<string>("");

  // Streaming infrastructure
  const streamingUnlistenRef = useRef<UnlistenFn[]>([]);
  // PERFORMANCE: Batch streaming results before updating atom
  // This prevents excessive re-renders from rapid streaming events
  const pendingResultsRef = useRef<StoreSearchResultFile[]>([]);
  const flushTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Cleanup streaming listeners
  const cleanupStreamingListeners = useCallback(async () => {
    for (const unlisten of streamingUnlistenRef.current) {
      await unlisten();
    }
    streamingUnlistenRef.current = [];
    // Also cleanup pending results
    if (flushTimeoutRef.current) {
      clearTimeout(flushTimeoutRef.current);
      flushTimeoutRef.current = null;
    }
    pendingResultsRef.current = [];
  }, []);

  // PERFORMANCE: Flush pending results to atom
  const flushPendingResults = useCallback(() => {
    if (pendingResultsRef.current.length > 0) {
      appendResults(pendingResultsRef.current);
      pendingResultsRef.current = [];
    }
    flushTimeoutRef.current = null;
  }, [appendResults]);

  const search = useCallback(async () => {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      clearAtom();
      lastSearchKeyRef.current = "";
      return;
    }

    // Build a key that includes query, mode, AND relevant options
    // This ensures we re-search when options or mode change, but not on remount
    const searchKey = [
      trimmedQuery,
      searchMode,
      storeOptions.caseSensitive,
      storeOptions.wholeWord,
      storeOptions.useRegex,
      storeOptions.filesToInclude || "",
      storeOptions.filesToExclude || "",
      storeOptions.onlyOpenFiles,
    ].join("|");

    // IMPORTANT: Skip if this exact query+options was already searched
    // This prevents re-searching on component remount (e.g., when clicking a result)
    if (searchKey === lastSearchKeyRef.current) {
      return;
    }

    // Track the search we're about to execute
    lastSearchKeyRef.current = searchKey;

    // Cancel previous search in backend before starting new one
    if (searchIdRef.current) {
      cancelSearch(searchIdRef.current).catch(() => {
        // Ignore errors - previous search may have already completed
      });
    }

    // Cancel previous request and cleanup listeners
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();
    await cleanupStreamingListeners();

    // Generate unique search ID for this search
    const searchId = `search-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    searchIdRef.current = searchId;

    setLoading(true);
    setError(null);
    setResults([]);
    setHasMore(false);

    // Parse file patterns from options
    const includePatterns = parseFilePatterns(storeOptions.filesToInclude);
    const excludePatterns = parseFilePatterns(storeOptions.filesToExclude);
    const filters = buildSearchFilters(
      storeOptions,
      includePatterns,
      excludePatterns
    );
    // ============================================
    // REGEX MODE: Fast ripgrep-based text search
    // ============================================

    // Use streaming search for single repo (main use case)
    const shouldUseStreaming =
      (USE_FAST_SEARCH || USE_STREAMING_SEARCH) &&
      !storeOptions.onlyOpenFiles &&
      openFiles?.length === 0;

    if (shouldUseStreaming) {
      // STREAMING SEARCH - results arrive progressively
      try {
        // Setup event listeners before starting search
        const resultUnlisten = await listen<SearchResultEvent>(
          "search-result",
          (event) => {
            // Only process events for current search
            if (event.payload.search_id !== searchIdRef.current) return;

            const result = event.payload.result;

            // PERFORMANCE: Batch results instead of appending immediately
            // Queue result for batched update
            pendingResultsRef.current.push(result);

            // Schedule flush if not already scheduled
            if (!flushTimeoutRef.current) {
              flushTimeoutRef.current = setTimeout(() => {
                flushPendingResults();
              }, FLUSH_INTERVAL_MS);
            }

            // Use actual (real) totals for display
            setActualTotalMatches(event.payload.actual_matches);
            setActualTotalFiles(event.payload.actual_files);
          }
        );

        const completeUnlisten = await listen<SearchCompleteEvent>(
          "search-complete",
          (event) => {
            if (event.payload.search_id !== searchIdRef.current) return;

            // PERFORMANCE: Flush any remaining pending results immediately
            if (flushTimeoutRef.current) {
              clearTimeout(flushTimeoutRef.current);
              flushTimeoutRef.current = null;
            }
            flushPendingResults();

            setLoading(false);
            // Use actual totals from complete event
            setActualTotalMatches(event.payload.total_matches);
            setActualTotalFiles(event.payload.total_files);
            setHasMore(event.payload.has_more);
          }
        );

        streamingUnlistenRef.current = [resultUnlisten, completeUnlisten];

        // Use fast search (grep-searcher) if enabled
        const searchFn = USE_FAST_SEARCH ? searchCodeFast : searchCodeStreaming;
        await searchFn(searchId, trimmedQuery, repoPath, {
          ...filters,
          max_results: SEARCH_CONSTANTS.INITIAL_MAX_RESULTS,
        });
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : "Search failed";
        log.error("[useSearchExecution] Streaming search error:", errorMessage);
        setError(errorMessage);
        setLoading(false);
      }
      return;
    }

    // FALLBACK: Non-streaming search for open files mode
    try {
      const searchPaths =
        storeOptions.onlyOpenFiles && openFiles && openFiles.length > 0
          ? openFiles
          : [repoPath];

      const searchResults = await searchCodeRegex(trimmedQuery, searchPaths, {
        ...filters,
        max_results: SEARCH_CONSTANTS.INITIAL_MAX_RESULTS,
      });

      // Filter results based on include/exclude glob patterns (client-side)
      const filteredResults = filterResultsByGlob(
        searchResults,
        repoPath,
        includePatterns,
        excludePatterns
      );

      // Take first batch of files, not first batch of matches
      const firstBatchFiles = filteredResults.slice(
        0,
        SEARCH_CONSTANTS.BATCH_SIZE
      );
      const hasMoreResults =
        filteredResults.length > SEARCH_CONSTANTS.BATCH_SIZE;

      setResults(firstBatchFiles);
      setHasMore(hasMoreResults);

      // Calculate actual totals from all results (not just first batch)
      const allMatches = filteredResults.reduce(
        (sum, file) => sum + file.matches.length,
        0
      );
      setActualTotalMatches(allMatches);
      setActualTotalFiles(filteredResults.length);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Search failed";
      log.error("[useSearchExecution] Fallback search error:", errorMessage);
      setError(errorMessage);
      setResults([]);
      setHasMore(false);
    } finally {
      setLoading(false);
    }
  }, [
    query,
    searchMode,
    repoPath,
    openFiles,
    storeOptions,
    clearAtom,
    cleanupStreamingListeners,
    flushPendingResults,
    setLoading,
    setError,
    setResults,
    setHasMore,
    setActualTotalMatches,
    setActualTotalFiles,
  ]);

  // Debounced search — keeps callback fresh via ref to avoid
  // re-triggering when other search dependencies change
  const debouncedSearch = useDebouncedCallback(() => {
    search();
  }, SEARCH_CONSTANTS.DEBOUNCE_MS);

  // Trigger debounced search when query or mode changes
  useEffect(() => {
    if (query.trim()) {
      debouncedSearch();
    } else {
      debouncedSearch.cancel();
      clearAtom();
    }
  }, [query, searchMode, debouncedSearch, clearAtom]); // searchMode triggers re-search when changed

  // Cleanup streaming listeners on unmount
  useEffect(() => {
    return () => {
      cleanupStreamingListeners();
    };
  }, [cleanupStreamingListeners]);

  return { search };
}
