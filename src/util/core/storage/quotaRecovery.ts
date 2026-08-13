/**
 * Browser localStorage quota policy.
 *
 * localStorage is reserved for small synchronous state. When WebKit rejects a
 * write, release only allowlisted, regenerable caches and retry once per
 * eviction tier. Auth, sync cursors, settings, navigation state, and unsent
 * drafts are intentionally absent from every cleanup list.
 */

export const BROWSER_CACHE_STORAGE_KEYS = {
  githubIssues: "orgii.ghcache.issues.v2",
  githubPullRequests: "orgii.ghcache.prs.v4",
  sessionList: "orgii:sessionsAtom:v1",
} as const;

const OBSOLETE_BROWSER_CACHE_KEYS = new Set([
  "orgii.ghcache.issues.v1",
  "orgii.ghcache.prs.v1",
  "orgii.ghcache.prs.v2",
  "orgii.ghcache.prs.v3",
]);

const GITHUB_CACHE_PREFIX = "orgii.ghcache.";
const DEV_RECORD_CACHE_PREFIX = "orgii:devRecord:cache:v1:";

export type BrowserStorageCleanupMode =
  | "obsolete"
  | "quota-recovery"
  | "all-disposable";

export interface BrowserStorageUsage {
  usedBytes: number;
  cleanableBytes: number;
  keyCount: number;
  cleanableKeyCount: number;
}

export interface BrowserStorageCleanupResult extends BrowserStorageUsage {
  freedBytes: number;
  removedKeys: string[];
  failedKeys: string[];
}

export interface BrowserStorageWriteResult {
  persisted: boolean;
  recovered: boolean;
  cleanup: BrowserStorageCleanupResult | null;
  error?: unknown;
}

function resolveLocalStorage(storage?: Storage): Storage | null {
  if (storage) return storage;
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** WebKit stores DOM strings as UTF-16; this is a useful quota approximation. */
export function estimateBrowserStorageEntryBytes(
  key: string,
  value: string
): number {
  return (key.length + value.length) * 2;
}

function storageKeys(storage: Storage): string[] {
  const keys: string[] = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key) keys.push(key);
    }
  } catch {
    return keys;
  }
  return keys;
}

function isRegenerableGitHubCache(key: string): boolean {
  return key.startsWith(GITHUB_CACHE_PREFIX);
}

function isRegenerableDevRecordCache(key: string): boolean {
  return key.startsWith(DEV_RECORD_CACHE_PREFIX);
}

function isDisposableBrowserCacheKey(key: string): boolean {
  return (
    isRegenerableGitHubCache(key) ||
    isRegenerableDevRecordCache(key) ||
    key === BROWSER_CACHE_STORAGE_KEYS.sessionList
  );
}

function matchesCleanupMode(
  key: string,
  mode: BrowserStorageCleanupMode
): boolean {
  if (mode === "obsolete") return OBSOLETE_BROWSER_CACHE_KEYS.has(key);
  if (mode === "quota-recovery") {
    return (
      OBSOLETE_BROWSER_CACHE_KEYS.has(key) ||
      isRegenerableGitHubCache(key) ||
      isRegenerableDevRecordCache(key)
    );
  }
  return isDisposableBrowserCacheKey(key);
}

export function inspectBrowserStorage(storage?: Storage): BrowserStorageUsage {
  const target = resolveLocalStorage(storage);
  if (!target) {
    return {
      usedBytes: 0,
      cleanableBytes: 0,
      keyCount: 0,
      cleanableKeyCount: 0,
    };
  }

  let usedBytes = 0;
  let cleanableBytes = 0;
  let cleanableKeyCount = 0;
  const keys = storageKeys(target);
  for (const key of keys) {
    try {
      const value = target.getItem(key);
      if (value === null) continue;
      const bytes = estimateBrowserStorageEntryBytes(key, value);
      usedBytes += bytes;
      if (isDisposableBrowserCacheKey(key)) {
        cleanableBytes += bytes;
        cleanableKeyCount += 1;
      }
    } catch {
      // A storage implementation can deny individual reads. Keep inspecting
      // the remaining keys instead of turning diagnostics into another crash.
    }
  }

  return {
    usedBytes,
    cleanableBytes,
    keyCount: keys.length,
    cleanableKeyCount,
  };
}

export function cleanUpBrowserStorage(
  mode: BrowserStorageCleanupMode = "all-disposable",
  storage?: Storage
): BrowserStorageCleanupResult {
  const target = resolveLocalStorage(storage);
  const before = inspectBrowserStorage(target ?? undefined);
  if (!target) {
    return {
      ...before,
      freedBytes: 0,
      removedKeys: [],
      failedKeys: [],
    };
  }

  const removedKeys: string[] = [];
  const failedKeys: string[] = [];
  for (const key of storageKeys(target)) {
    if (!matchesCleanupMode(key, mode)) continue;
    try {
      target.removeItem(key);
      removedKeys.push(key);
    } catch {
      failedKeys.push(key);
    }
  }

  const after = inspectBrowserStorage(target);
  return {
    ...after,
    freedBytes: Math.max(0, before.usedBytes - after.usedBytes),
    removedKeys,
    failedKeys,
  };
}

export function isStorageQuotaError(error: unknown): boolean {
  if (!error) return false;
  const candidate = error as { name?: unknown; message?: unknown };
  const name = typeof candidate.name === "string" ? candidate.name : "";
  const message =
    typeof candidate.message === "string"
      ? candidate.message
      : typeof error === "string"
        ? error
        : "";
  return (
    name === "QuotaExceededError" ||
    name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    /quota.*exceed|exceed.*quota/i.test(message)
  );
}

function trySetItem(
  storage: Storage,
  key: string,
  value: string
): { persisted: true } | { persisted: false; error: unknown } {
  try {
    storage.setItem(key, value);
    return { persisted: true };
  } catch (error) {
    return { persisted: false, error };
  }
}

/**
 * Persist a value and recover from quota pressure by evicting only
 * regenerable caches. The session-list cache is the final tier so normal
 * GitHub cache pressure does not discard the sidebar's cold-start snapshot.
 */
export function setBrowserStorageItemWithRecovery(
  key: string,
  value: string,
  storage?: Storage
): BrowserStorageWriteResult {
  const target = resolveLocalStorage(storage);
  if (!target) {
    return {
      persisted: false,
      recovered: false,
      cleanup: null,
      error: new Error("localStorage is unavailable"),
    };
  }

  const initial = trySetItem(target, key, value);
  if (initial.persisted) {
    return { persisted: true, recovered: false, cleanup: null };
  }
  if (!isStorageQuotaError(initial.error)) {
    return {
      persisted: false,
      recovered: false,
      cleanup: null,
      error: initial.error,
    };
  }

  const cacheCleanup = cleanUpBrowserStorage("quota-recovery", target);
  const afterCacheCleanup = trySetItem(target, key, value);
  if (afterCacheCleanup.persisted) {
    return { persisted: true, recovered: true, cleanup: cacheCleanup };
  }
  if (!isStorageQuotaError(afterCacheCleanup.error)) {
    return {
      persisted: false,
      recovered: false,
      cleanup: cacheCleanup,
      error: afterCacheCleanup.error,
    };
  }

  // The bounded session list is also refetchable, but preserve it until the
  // cheaper cache-only tier proved insufficient.
  const sessionCleanup = cleanUpBrowserStorage("all-disposable", target);
  const finalAttempt = trySetItem(target, key, value);
  const combinedCleanup: BrowserStorageCleanupResult = {
    ...sessionCleanup,
    freedBytes: cacheCleanup.freedBytes + sessionCleanup.freedBytes,
    removedKeys: [
      ...new Set([...cacheCleanup.removedKeys, ...sessionCleanup.removedKeys]),
    ],
    failedKeys: [
      ...new Set([...cacheCleanup.failedKeys, ...sessionCleanup.failedKeys]),
    ],
  };
  if (finalAttempt.persisted) {
    return { persisted: true, recovered: true, cleanup: combinedCleanup };
  }
  return {
    persisted: false,
    recovered: false,
    cleanup: combinedCleanup,
    error: finalAttempt.error,
  };
}

export function removeBrowserStorageItemSafely(
  key: string,
  storage?: Storage
): boolean {
  const target = resolveLocalStorage(storage);
  if (!target) return false;
  try {
    target.removeItem(key);
    return true;
  } catch {
    return false;
  }
}
