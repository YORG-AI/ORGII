/**
 * Pure cache primitives for the WorktreeSourceModal preload / cache layer.
 *
 * The worktree-source picker preloads GitHub (PR/issue) and branch data when
 * the modal opens so switching tabs never re-triggers a spinner. These helpers
 * hold the framework-agnostic freshness / eviction / isolation / in-flight
 * de-dup logic so it stays unit-testable without React or jotai.
 *
 * Design notes:
 * - **Branch data** reuses the existing app-wide `branchCacheAtom`
 *   (`@src/store/repo`, 5-min TTL, shared with `BranchPalette`) — these helpers
 *   are only the backing store for the **GitHub** cache that had no equivalent.
 * - Maps are treated immutably (`write*` returns a new Map) so they can live in
 *   a jotai atom and trigger re-renders on change.
 */

/** Freshness classification of a cache entry against a TTL window. */
export type WorktreeCacheFreshness = "fresh" | "stale" | "missing";

/** Minimal shape every cache entry must carry (wall-clock fetch time). */
export interface WorktreeCacheEntryBase {
  fetchedAt: number;
}

/**
 * Freshness window for GitHub PR/issue data. PRs/issues change often, so a
 * short 45s window (inside the 30–60s target) keeps the list current while
 * still eliminating the per-tab-switch and rapid-reopen refetch.
 */
export const WORKTREE_GITHUB_CACHE_TTL_MS = 45_000;

/**
 * Hard cap on cached repo keys. Bounds memory: switching between many repos
 * evicts the least-recently-written entry beyond this count (LRU).
 */
export const WORKTREE_SOURCE_CACHE_MAX_ENTRIES = 8;

/**
 * Build the per-repo cache key. Prefers the stable `repoId`; falls back to the
 * filesystem `repoPath` so path-only repos still cache in isolation. Returns
 * `null` when neither is available (nothing to key on → skip caching/fetching).
 */
export function resolveWorktreeRepoKey(
  repoId?: string,
  repoPath?: string
): string | null {
  const id = repoId?.trim();
  if (id) return `id:${id}`;
  const path = repoPath?.trim();
  if (path) return `path:${path}`;
  return null;
}

/**
 * GitHub cache identity includes endpoint + authenticated connection + repo.
 * This prevents private PR/issue rows from surviving an account switch under
 * the same local repository key.
 */
export function resolveWorktreeGithubCacheKey(
  repoKey: string,
  authScope: string
): string {
  return `${authScope}|${repoKey}`;
}

/**
 * Drop cached GitHub data for previous identities of the same repository.
 * Other repositories remain warm, while an account switch cannot retain the
 * previous account's private rows in memory under a sibling cache key.
 */
export function evictOtherWorktreeGithubIdentities<E>(
  map: Map<string, E>,
  repoKey: string,
  activeKey: string
): Map<string, E> {
  const suffix = `|${repoKey}`;
  const staleKeys = [...map.keys()].filter(
    (key) => key !== activeKey && key.endsWith(suffix)
  );
  if (staleKeys.length === 0) return map;

  const next = new Map(map);
  for (const key of staleKeys) next.delete(key);
  return next;
}

/** Classify an entry as fresh (within TTL), stale (past TTL), or missing. */
export function getWorktreeCacheFreshness(
  entry: WorktreeCacheEntryBase | undefined,
  now: number,
  ttlMs: number
): WorktreeCacheFreshness {
  if (!entry) return "missing";
  return now - entry.fetchedAt < ttlMs ? "fresh" : "stale";
}

/** Convenience predicate: is the entry present and within its TTL window? */
export function isWorktreeCacheFresh(
  entry: WorktreeCacheEntryBase | undefined,
  now: number,
  ttlMs: number
): boolean {
  return getWorktreeCacheFreshness(entry, now, ttlMs) === "fresh";
}

/** Safe read that tolerates a `null` key (returns `undefined`). */
export function readWorktreeCacheEntry<E>(
  map: ReadonlyMap<string, E>,
  key: string | null
): E | undefined {
  if (!key) return undefined;
  return map.get(key);
}

/**
 * Immutably write an entry, keeping the map bounded to `maxEntries`.
 *
 * Re-inserts the key at the tail so it counts as most-recently-used; when over
 * capacity, evicts from the head (least-recently-written) — a simple LRU that
 * relies on `Map` preserving insertion order.
 */
export function writeWorktreeCacheEntry<E>(
  map: ReadonlyMap<string, E>,
  key: string,
  entry: E,
  maxEntries: number = WORKTREE_SOURCE_CACHE_MAX_ENTRIES
): Map<string, E> {
  const next = new Map(map);
  // Delete-then-set moves the key to the tail (most-recent) on updates too.
  next.delete(key);
  next.set(key, entry);
  while (next.size > maxEntries) {
    const oldest = next.keys().next().value;
    if (oldest === undefined) break;
    next.delete(oldest);
  }
  return next;
}

/** Immutably drop every entry older than the TTL window. */
export function pruneWorktreeCache<E extends WorktreeCacheEntryBase>(
  map: ReadonlyMap<string, E>,
  now: number,
  ttlMs: number
): Map<string, E> {
  const next = new Map<string, E>();
  for (const [key, entry] of map) {
    if (now - entry.fetchedAt < ttlMs) next.set(key, entry);
  }
  return next;
}

/**
 * De-dup registry for concurrent async loads keyed by repo key. Two callers
 * that request the same key while a load is in flight share one promise; the
 * slot is cleared once it settles so the next call re-fetches (subject to the
 * caller's own freshness gate).
 */
export interface InflightRegistry<T> {
  /** Run `factory` for `key`, or join the in-flight promise if one exists. */
  run(key: string, factory: () => Promise<T>): Promise<T>;
  /** Whether a load for `key` is currently in flight. */
  has(key: string): boolean;
  /** Number of in-flight loads (test/inspection aid). */
  size(): number;
}

export function createInflightRegistry<T>(): InflightRegistry<T> {
  const inflight = new Map<string, Promise<T>>();
  return {
    run(key, factory) {
      const existing = inflight.get(key);
      if (existing) return existing;
      const promise = (async () => {
        try {
          return await factory();
        } finally {
          inflight.delete(key);
        }
      })();
      inflight.set(key, promise);
      return promise;
    },
    has(key) {
      return inflight.has(key);
    },
    size() {
      return inflight.size;
    },
  };
}
