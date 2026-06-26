/**
 * useWorktreeMap Hook
 *
 * Fetches the git worktree list for a repository and exposes a
 * `branchName -> worktreePath` map. Used by both `BranchPalette`
 * (Spotlight) and `BranchDropdown` to surface a "Worktrees" section in
 * the branch selector.
 *
 * Worktree enumeration is local-only — GitHub remote repos always
 * return an empty map.
 *
 * Caching strategy: a module-scoped LRU keyed by `repoId`. Each map
 * lives for ~5 min before the next call refreshes it on next open.
 * This is intentionally lightweight — worktrees change rarely and the
 * branch list itself is already cached separately.
 *
 * The hook subscribes to the cache via `useSyncExternalStore` so React
 * never sees a `setState` inside an effect — the only place state
 * mutates is `writeCache()` followed by a listener fan-out, which is
 * the canonical external-store pattern.
 */
import { useEffect, useSyncExternalStore } from "react";

import { gitApi } from "@src/api/http/git";

const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 16;
const EMPTY_MAP: ReadonlyMap<string, string> = new Map();

interface CacheEntry {
  map: Map<string, string>;
  fetchedAt: number;
}

const worktreeCache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<Map<string, string>>>();
const subscribers = new Set<() => void>();

function notifySubscribers(): void {
  for (const cb of subscribers) cb();
}

function readCache(repoId: string): Map<string, string> | null {
  const entry = worktreeCache.get(repoId);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
    worktreeCache.delete(repoId);
    return null;
  }
  return entry.map;
}

function writeCache(repoId: string, map: Map<string, string>): void {
  if (worktreeCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = worktreeCache.keys().next().value;
    if (oldestKey !== undefined) worktreeCache.delete(oldestKey);
  }
  worktreeCache.set(repoId, { map, fetchedAt: Date.now() });
  notifySubscribers();
}

export function invalidateWorktreeMap(repoId: string): void {
  worktreeCache.delete(repoId);
  notifySubscribers();
}

export function refreshWorktreeMap(
  repoId: string,
  repoPath: string | undefined
): Promise<Map<string, string>> {
  invalidateWorktreeMap(repoId);
  return fetchWorktreeMap(repoId, repoPath);
}

async function fetchWorktreeMap(
  repoId: string,
  repoPath: string | undefined
): Promise<Map<string, string>> {
  const existing = inflight.get(repoId);
  if (existing) return existing;

  const promise = (async () => {
    const entries = await gitApi.getGitWorktrees({
      repo_id: repoId,
      ...(repoPath ? { repo_path: repoPath } : {}),
    });
    const map = new Map<string, string>();
    for (const entry of entries) {
      // Skip the main worktree — the current repo IS that worktree, so
      // its checked-out branch is already represented as "current".
      if (entry.is_main) continue;
      if (!entry.branch) continue;
      map.set(entry.branch, entry.path);
    }
    writeCache(repoId, map);
    return map;
  })();

  inflight.set(repoId, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(repoId);
  }
}

function subscribe(callback: () => void): () => void {
  subscribers.add(callback);
  return () => {
    subscribers.delete(callback);
  };
}

export interface UseWorktreeMapOptions {
  enabled: boolean;
  repoId: string;
  repoPath?: string;
  /** Local repos only — GitHub remote repos skip the fetch. */
  isLocalRepo: boolean;
}

/**
 * Returns a `branchName -> worktreePath` map for the given repo.
 * Returns an empty map until the first fetch resolves; subsequent
 * opens reuse the module-scoped LRU.
 */
export function useWorktreeMap(
  options: UseWorktreeMapOptions
): ReadonlyMap<string, string> {
  const { enabled, repoId, repoPath, isLocalRepo } = options;
  const active = enabled && isLocalRepo && Boolean(repoId);

  // Snapshot pulls from the module cache. Returning a stable EMPTY_MAP
  // when inactive keeps `useSyncExternalStore`'s identity check happy
  // across renders — it only re-renders when a different Map instance
  // shows up in the cache.
  const getSnapshot = (): ReadonlyMap<string, string> => {
    if (!active) return EMPTY_MAP;
    return readCache(repoId) ?? EMPTY_MAP;
  };

  const map = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  // Kick off the fetch when active and no fresh cache exists. The
  // fetch writes into the module cache and fans out to subscribers,
  // so we never call `setState` from inside this effect.
  useEffect(() => {
    if (!active) return;
    if (readCache(repoId)) return;
    void fetchWorktreeMap(repoId, repoPath).catch(() => {
      // Worktree enumeration is best-effort. If the Rust call fails
      // (non-git repo, permission, etc.) leave the map empty — the
      // branch list still renders fine, just without a Worktrees
      // section.
    });
  }, [active, repoId, repoPath]);

  return map;
}
