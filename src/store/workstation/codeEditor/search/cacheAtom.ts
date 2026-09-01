/**
 * Search Result Cache
 *
 * LRU cache for search results to avoid redundant searches.
 * Invalidates on file changes.
 */
import { atom } from "jotai";

import type { CodeSearchResult } from "@src/api/tauri/search/types";

// ============================================
// Types
// ============================================

export type SearchMode = "regex";

export interface CachedSearch {
  /** Search query */
  query: string;
  /** Search mode used */
  mode: SearchMode;
  /** Repository filter (empty = all repos) */
  repoFilter: string;
  /** Cached results */
  results: CodeSearchResult[];
  /** When the search was executed */
  timestamp: number;
  /** Total result count (before pagination) */
  totalCount: number;
}

export interface SearchCacheStats {
  /** Number of cached searches */
  size: number;
  /** Number of cache hits */
  hits: number;
  /** Number of cache misses */
  misses: number;
  /** Hit rate percentage */
  hitRate: number;
}

// ============================================
// Constants
// ============================================

/** Maximum number of cached searches */
const MAX_CACHE_SIZE = 50;

/** Cache entry TTL in milliseconds (5 minutes) */
const CACHE_TTL_MS = 5 * 60 * 1000;

// ============================================
// Helpers
// ============================================

/**
 * Generate cache key from search parameters
 */
export function generateCacheKey(
  query: string,
  mode: SearchMode,
  repoFilter: string
): string {
  return `${mode}:${repoFilter || "*"}:${query}`;
}

/**
 * Check if a cache entry is still valid
 */
function isEntryValid(entry: CachedSearch): boolean {
  return Date.now() - entry.timestamp < CACHE_TTL_MS;
}

// ============================================
// Atoms
// ============================================

/**
 * Main cache store - Map of cache key to cached search
 */
export const searchCacheAtom = atom<Map<string, CachedSearch>>(new Map());
searchCacheAtom.debugLabel = "searchCacheAtom";

/**
 * Cache statistics
 */
export const cacheStatsAtom = atom<{ hits: number; misses: number }>({
  hits: 0,
  misses: 0,
});
cacheStatsAtom.debugLabel = "cacheStatsAtom";

/**
 * Timestamp of last cache invalidation
 */
export const cacheInvalidatedAtAtom = atom<number>(0);
cacheInvalidatedAtAtom.debugLabel = "cacheInvalidatedAtAtom";

// ============================================
// Derived Atoms
// ============================================

/**
 * Get cache statistics
 */
export const searchCacheStatsAtom = atom((get): SearchCacheStats => {
  const cache = get(searchCacheAtom);
  const stats = get(cacheStatsAtom);
  const total = stats.hits + stats.misses;

  return {
    size: cache.size,
    hits: stats.hits,
    misses: stats.misses,
    hitRate: total > 0 ? (stats.hits / total) * 100 : 0,
  };
});
searchCacheStatsAtom.debugLabel = "searchCacheStatsAtom";

/**
 * Check if cache has a valid entry for given parameters
 */
export const hasCachedResultAtom = atom(
  (get) => (query: string, mode: SearchMode, repoFilter: string) => {
    const cache = get(searchCacheAtom);
    const key = generateCacheKey(query, mode, repoFilter);
    const entry = cache.get(key);

    if (!entry) return false;
    return isEntryValid(entry);
  }
);

/**
 * Get cached result if valid
 */
export const getCachedResultAtom = atom(
  (get) => (query: string, mode: SearchMode, repoFilter: string) => {
    const cache = get(searchCacheAtom);
    const key = generateCacheKey(query, mode, repoFilter);
    const entry = cache.get(key);

    if (!entry || !isEntryValid(entry)) {
      return null;
    }

    return entry;
  }
);

// ============================================
// Actions
// ============================================

/**
 * Add a search result to cache
 */
export const addToCacheAtom = atom(
  null,
  (get, set, params: Omit<CachedSearch, "timestamp">) => {
    const cache = get(searchCacheAtom);
    const updated = new Map(cache);
    const key = generateCacheKey(params.query, params.mode, params.repoFilter);

    // Enforce LRU eviction if at capacity
    if (updated.size >= MAX_CACHE_SIZE && !updated.has(key)) {
      // Find oldest entry
      let oldestKey: string | null = null;
      let oldestTime = Infinity;

      for (const [entryKey, entry] of updated) {
        if (entry.timestamp < oldestTime) {
          oldestTime = entry.timestamp;
          oldestKey = entryKey;
        }
      }

      if (oldestKey) {
        updated.delete(oldestKey);
      }
    }

    // Add new entry
    updated.set(key, {
      ...params,
      timestamp: Date.now(),
    });

    set(searchCacheAtom, updated);
  }
);

/**
 * Record a cache hit
 */
export const recordCacheHitAtom = atom(null, (get, set) => {
  const stats = get(cacheStatsAtom);
  set(cacheStatsAtom, { ...stats, hits: stats.hits + 1 });
});

/**
 * Record a cache miss
 */
export const recordCacheMissAtom = atom(null, (get, set) => {
  const stats = get(cacheStatsAtom);
  set(cacheStatsAtom, { ...stats, misses: stats.misses + 1 });
});

/**
 * Invalidate cache for a specific repo
 */
export const invalidateRepoCacheAtom = atom(
  null,
  (get, set, repoPath: string) => {
    const cache = get(searchCacheAtom);
    const updated = new Map(cache);

    // Remove entries that match this repo
    for (const [key, _entry] of updated) {
      // Key format: mode:repoFilter:query
      const [, repoFilter] = key.split(":");
      if (repoFilter === repoPath || repoFilter === "*") {
        updated.delete(key);
      }
    }

    set(searchCacheAtom, updated);
    set(cacheInvalidatedAtAtom, Date.now());
  }
);

/**
 * Clear all cached results
 */
export const clearSearchCacheAtom = atom(null, (_get, set) => {
  set(searchCacheAtom, new Map());
  set(cacheStatsAtom, { hits: 0, misses: 0 });
  set(cacheInvalidatedAtAtom, Date.now());
});

/**
 * Remove expired entries from cache
 */
export const pruneExpiredCacheAtom = atom(null, (get, set) => {
  const cache = get(searchCacheAtom);
  const updated = new Map(cache);
  let pruned = 0;

  for (const [key, entry] of updated) {
    if (!isEntryValid(entry)) {
      updated.delete(key);
      pruned++;
    }
  }

  if (pruned > 0) {
    set(searchCacheAtom, updated);
  }

  return pruned;
});
