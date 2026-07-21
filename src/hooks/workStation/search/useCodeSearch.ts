/**
 * useCodeSearch Hook
 *
 * Manages regex code search state with query debouncing, repository filtering,
 * pagination, history, and result caching.
 */
import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";

import { type CodeSearchResult, searchCodeRegex } from "@src/api/tauri/search";
import { useDebouncedCallback } from "@src/hooks/perf/useDebouncedCallback";
import {
  addToCacheAtom,
  getCachedResultAtom,
  recordCacheHitAtom,
  recordCacheMissAtom,
} from "@src/store/workstation/codeEditor/search/cacheAtom";

import { LatestRequestGuard } from "./latestRequestGuard";

export type { CodeSearchResult } from "@src/api/tauri/search";

export type CodeSearchMode = "regex" | "semantic" | "hybrid";

export interface UseCodeSearchOptions {
  /** Auto-execute search on query change */
  autoSearch?: boolean;
  /** Debounce delay in ms */
  debounceMs?: number;
  /** Maximum number of results */
  maxResults?: number;
  /** Initial search mode */
  initialMode?: CodeSearchMode;
}

export interface UseCodeSearchReturn {
  query: string;
  setQuery: (query: string) => void;
  searchMode: CodeSearchMode;
  toggleSearchMode: () => void;
  setSearchMode: (mode: CodeSearchMode) => void;
  results: CodeSearchResult[];
  loading: boolean;
  error: string | null;
  totalResults: number;
  fromCache: boolean;
  currentPage: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
  goToNextPage: () => void;
  goToPrevPage: () => void;
  goToPage: (page: number) => void;
  fileTypes: string[];
  setFileTypes: (types: string[]) => void;
  repoFilter: string;
  setRepoFilter: (repo: string) => void;
  search: () => Promise<void>;
  clearResults: () => void;
  clearError: () => void;
  searchHistory: string[];
  clearHistory: () => void;
}

const DEFAULT_OPTIONS: Required<UseCodeSearchOptions> = {
  autoSearch: false,
  debounceMs: 300,
  maxResults: 50,
  initialMode: "regex",
};

export function useCodeSearch(
  options: UseCodeSearchOptions = {}
): UseCodeSearchReturn {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  const [query, setQuery] = useState("");
  const [searchMode, setSearchMode] = useState<CodeSearchMode>(
    opts.initialMode
  );
  const [results, setResults] = useState<CodeSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileTypes, setFileTypes] = useState<string[]>([]);
  const [currentPage, setCurrentPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [repoFilter, setRepoFilter] = useState("");
  const [searchHistory, setSearchHistory] = useState<string[]>([]);
  const [fromCache, setFromCache] = useState(false);

  const getCachedResult = useAtomValue(getCachedResultAtom);
  const addToCache = useSetAtom(addToCacheAtom);
  const recordCacheHit = useSetAtom(recordCacheHitAtom);
  const recordCacheMiss = useSetAtom(recordCacheMissAtom);
  const abortControllerRef = useRef<AbortController | null>(null);
  // The Tauri search API does not currently accept an AbortSignal, so only the
  // latest request generation is allowed to commit results or loading state.
  const latestRequestGuardRef = useRef<LatestRequestGuard | null>(null);
  if (latestRequestGuardRef.current === null) {
    latestRequestGuardRef.current = new LatestRequestGuard();
  }

  const toggleSearchMode = useCallback(() => {
    setSearchMode((currentMode) => {
      if (currentMode === "regex") return "semantic";
      if (currentMode === "semantic") return "hybrid";
      return "regex";
    });
    setResults([]);
  }, []);

  const search = useCallback(async () => {
    const latestRequestGuard = latestRequestGuardRef.current!;
    const searchGeneration = latestRequestGuard.issue();
    const isLatestSearch = () => latestRequestGuard.isCurrent(searchGeneration);
    const trimmedQuery = query.trim();

    if (!trimmedQuery) {
      setResults([]);
      setFromCache(false);
      return;
    }

    if (currentPage === 1 && fileTypes.length === 0) {
      const cached = getCachedResult(trimmedQuery, searchMode, repoFilter);
      if (cached) {
        setResults(cached.results);
        setHasMore(cached.results.length >= opts.maxResults);
        setFromCache(true);
        recordCacheHit();

        if (!searchHistory.includes(trimmedQuery)) {
          setSearchHistory((prev) => [trimmedQuery, ...prev.slice(0, 9)]);
        }
        return;
      }
    }

    abortControllerRef.current?.abort();
    abortControllerRef.current = new AbortController();

    setLoading(true);
    setError(null);
    setFromCache(false);

    try {
      const regexResults = await searchCodeRegex(
        trimmedQuery,
        repoFilter ? [repoFilter] : [],
        { max_results: opts.maxResults + 1 }
      );
      if (!isLatestSearch()) return;

      const hasMoreResults = regexResults.length > opts.maxResults;
      let searchResults = hasMoreResults
        ? regexResults.slice(0, opts.maxResults)
        : regexResults;
      setHasMore(hasMoreResults);

      if (fileTypes.length > 0) {
        searchResults = searchResults.filter((result) => {
          const extension =
            result.file_path.split(".").pop()?.toLowerCase() || "";
          return fileTypes.some((type) => type.split(",").includes(extension));
        });
      }

      setResults(searchResults);

      if (currentPage === 1 && fileTypes.length === 0) {
        addToCache({
          query: trimmedQuery,
          mode: searchMode,
          repoFilter,
          results: searchResults,
          totalCount: searchResults.length,
        });
        recordCacheMiss();
      }

      if (!searchHistory.includes(trimmedQuery)) {
        setSearchHistory((prev) => [trimmedQuery, ...prev.slice(0, 9)]);
      }
    } catch (err: unknown) {
      if (!isLatestSearch()) return;
      if (err instanceof Error && err.name === "AbortError") return;
      const errorMsg =
        typeof err === "string"
          ? err
          : err instanceof Error
            ? err.message
            : "Failed to search code";
      setError(errorMsg);
      setResults([]);
    } finally {
      if (isLatestSearch()) {
        setLoading(false);
        abortControllerRef.current = null;
      }
    }
  }, [
    query,
    searchMode,
    repoFilter,
    fileTypes,
    opts.maxResults,
    searchHistory,
    currentPage,
    getCachedResult,
    addToCache,
    recordCacheHit,
    recordCacheMiss,
  ]);

  const clearResults = useCallback(() => {
    latestRequestGuardRef.current?.invalidate();
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setResults([]);
    setLoading(false);
    setError(null);
    setCurrentPage(1);
    setHasMore(false);
    setFromCache(false);
  }, []);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const clearHistory = useCallback(() => {
    setSearchHistory([]);
  }, []);

  const debouncedSearch = useDebouncedCallback(() => {
    search();
  }, opts.debounceMs);

  useEffect(() => {
    if (!opts.autoSearch) return;

    if (query.trim()) {
      debouncedSearch();
    } else {
      debouncedSearch.cancel();
      latestRequestGuardRef.current?.invalidate();
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
      setResults([]);
      setLoading(false);
    }
  }, [query, opts.autoSearch, debouncedSearch, search]);

  useEffect(() => {
    return () => {
      latestRequestGuardRef.current?.invalidate();
      abortControllerRef.current?.abort();
    };
  }, []);

  const goToNextPage = useCallback(() => {
    if (hasMore) setCurrentPage((prev) => prev + 1);
  }, [hasMore]);

  const goToPrevPage = useCallback(() => {
    if (currentPage > 1) setCurrentPage((prev) => prev - 1);
  }, [currentPage]);

  const goToPage = useCallback((page: number) => {
    if (page >= 1) setCurrentPage(page);
  }, []);

  useEffect(() => {
    if (currentPage > 1 && query.trim()) {
      search();
    }
  }, [currentPage, query, search]);

  return {
    query,
    setQuery,
    searchMode,
    toggleSearchMode,
    setSearchMode,
    results,
    loading,
    error,
    totalResults: results.length,
    fromCache,
    currentPage,
    hasNextPage: hasMore,
    hasPrevPage: currentPage > 1,
    goToNextPage,
    goToPrevPage,
    goToPage,
    fileTypes,
    setFileTypes,
    repoFilter,
    setRepoFilter,
    search,
    clearResults,
    clearError,
    searchHistory,
    clearHistory,
  };
}

export default useCodeSearch;
