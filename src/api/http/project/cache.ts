/**
 * Short-lived read cache for `project_*` Tauri calls.
 *
 * Cache keys are slug-scoped (the project store is global, so there's
 * no `repoPath` namespace to worry about). The cache exists to
 * deduplicate the burst of reads that fire when multiple hooks mount
 * on the same tick (e.g. `useProjectData` + `useWorkItemsSource` both
 * pulling labels and members for the same project) — anything past
 * the 2s TTL goes back over IPC.
 *
 * - Entries expire after `CACHE_TTL_MS` (2 seconds).
 * - In-flight promises are shared (request deduplication).
 * - `invalidateCache(slug)` drops every key starting with `${slug}:`;
 *   `invalidateCache()` flushes the whole cache for legacy/unscoped
 *   `orgii-data-changed` events.
 * - Max 50 entries with FIFO eviction.
 */

const CACHE_TTL_MS = 2_000;
const MAX_ENTRIES = 50;

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

const cache = new Map<string, CacheEntry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();
/**
 * Fences reads that were already in flight when any mutation invalidated the
 * cache. Clearing `inflight` alone is insufficient: the detached Promise can
 * still resolve later, repopulate the cache with its pre-mutation snapshot,
 * and hand that stale snapshot to an open Work Item detail.
 */
let globalInvalidationGeneration = 0;
const scopedInvalidationGenerations = new Map<string, number>();
const activeReadsByScope = new Map<string, number>();

function cacheScope(cacheKey: string): string {
  const separatorIndex = cacheKey.indexOf(":");
  return separatorIndex >= 0 ? cacheKey.slice(0, separatorIndex) : cacheKey;
}

function beginScopedRead(scope: string): void {
  activeReadsByScope.set(scope, (activeReadsByScope.get(scope) ?? 0) + 1);
}

function endScopedRead(scope: string): void {
  const remaining = (activeReadsByScope.get(scope) ?? 1) - 1;
  if (remaining > 0) {
    activeReadsByScope.set(scope, remaining);
    return;
  }
  activeReadsByScope.delete(scope);
  // A scoped generation only fences requests that crossed its mutation.
  // Once all requests in that scope have settled, retaining it has no value
  // and would turn project slugs into an unbounded registry.
  scopedInvalidationGenerations.delete(scope);
}

function evictIfNeeded(): void {
  if (cache.size < MAX_ENTRIES) return;
  const firstKey = cache.keys().next().value;
  if (firstKey) cache.delete(firstKey);
}

export async function cachedRead<T>(
  cacheKey: string,
  fetcher: () => Promise<T>
): Promise<T> {
  const now = Date.now();
  const existing = cache.get(cacheKey);
  if (existing && now - existing.timestamp < CACHE_TTL_MS) {
    return existing.data as T;
  }

  const pending = inflight.get(cacheKey);
  if (pending) {
    return pending as Promise<T>;
  }

  const scope = cacheScope(cacheKey);
  const requestGlobalGeneration = globalInvalidationGeneration;
  const requestScopedGeneration = scopedInvalidationGenerations.get(scope) ?? 0;
  beginScopedRead(scope);
  let fetchPromise: Promise<T>;
  try {
    fetchPromise = fetcher();
  } catch (error) {
    endScopedRead(scope);
    throw error;
  }
  const promise = fetchPromise
    .then(async (result): Promise<T> => {
      if (
        requestGlobalGeneration !== globalInvalidationGeneration ||
        requestScopedGeneration !==
          (scopedInvalidationGenerations.get(scope) ?? 0)
      ) {
        // This request crossed a mutation boundary. Never expose/cache its
        // stale snapshot; converge the original waiter onto the post-change
        // read (or its already-running shared Promise) instead.
        if (inflight.get(cacheKey) === promise) inflight.delete(cacheKey);
        return cachedRead(cacheKey, fetcher);
      }
      evictIfNeeded();
      cache.set(cacheKey, { data: result, timestamp: Date.now() });
      if (inflight.get(cacheKey) === promise) inflight.delete(cacheKey);
      return result;
    })
    .catch((err: unknown) => {
      // Do not let an obsolete request remove the newer request installed
      // under the same key after invalidation.
      if (inflight.get(cacheKey) === promise) inflight.delete(cacheKey);
      throw err;
    })
    .finally(() => {
      endScopedRead(scope);
    });

  inflight.set(cacheKey, promise);
  return promise;
}

/**
 * Drop cached entries scoped to `slug`. Pass no argument to flush the
 * whole cache when a project-data-changed event has no safe scope.
 */
export function invalidateCache(slug?: string): void {
  if (!slug) {
    globalInvalidationGeneration += 1;
    scopedInvalidationGenerations.clear();
    cache.clear();
    inflight.clear();
    return;
  }
  if ((activeReadsByScope.get(slug) ?? 0) > 0) {
    scopedInvalidationGenerations.set(
      slug,
      (scopedInvalidationGenerations.get(slug) ?? 0) + 1
    );
  }
  const prefix = `${slug}:`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) {
      cache.delete(key);
    }
  }
  for (const key of inflight.keys()) {
    if (key.startsWith(prefix)) {
      inflight.delete(key);
    }
  }
}
