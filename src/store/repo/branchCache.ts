/**
 * Branch Cache Helpers
 *
 * LRU cache utilities for branch data to prevent redundant API calls.
 */
import {
  BRANCH_CACHE_CONFIG,
  type BranchCacheEntry,
  type CachedRepo,
  MAX_CACHED_REPOS,
  type Repo,
} from "./types";

// ============================================
// Repo Cache Helpers
// ============================================

/**
 * Update cached repos with a new repo
 * Keeps the 3 most recently used repos
 */
export function updateCachedRepos(
  currentCache: CachedRepo[],
  repo: Repo
): CachedRepo[] {
  if (!repo.id || (!repo.path && !repo.fs_uri)) return currentCache;

  const newCached: CachedRepo = {
    id: repo.id,
    name: repo.name,
    path: repo.path || repo.fs_uri || "",
    repo_url: repo.repo_url,
  };

  // Remove if already exists (will be re-added at front)
  const filtered = currentCache.filter(
    (cachedRepo) => cachedRepo.id !== repo.id
  );

  // Add to front, limit to MAX_CACHED_REPOS
  return [newCached, ...filtered].slice(0, MAX_CACHED_REPOS);
}

// ============================================
// Branch Cache Helpers (with LRU eviction)
// ============================================

/**
 * Check if branch cache entry is fresh
 */
export function isBranchCacheFresh(
  cache: Map<string, BranchCacheEntry>,
  repoId: string
): boolean {
  const entry = cache.get(repoId);
  if (!entry) return false;
  return Date.now() - entry.fetchedAt < BRANCH_CACHE_CONFIG.TTL;
}

/**
 * Get branches from cache (without updating access time)
 */
export function getBranchesFromCache(
  cache: Map<string, BranchCacheEntry>,
  repoId: string
): BranchCacheEntry | null {
  return cache.get(repoId) || null;
}

/**
 * Set branch cache entry with LRU eviction
 *
 * When cache is at max size, evicts the oldest entry.
 * Moves accessed entry to the end (most recent).
 *
 * @param cache Current cache map
 * @param repoId Repo ID to cache
 * @param entry Branch cache entry
 * @returns Updated cache map
 */
export function setBranchCacheWithLRU(
  cache: Map<string, BranchCacheEntry>,
  repoId: string,
  entry: BranchCacheEntry
): Map<string, BranchCacheEntry> {
  const updated = new Map(cache);

  // If key exists, delete it first to re-insert at end (most recent)
  if (updated.has(repoId)) {
    updated.delete(repoId);
  }

  // If at capacity, evict least recently used (first entry)
  if (updated.size >= BRANCH_CACHE_CONFIG.MAX_SIZE) {
    const firstKey = updated.keys().next().value;
    if (firstKey !== undefined) {
      updated.delete(firstKey);
    }
  }

  // Add new entry at end (most recent)
  updated.set(repoId, entry);

  return updated;
}
