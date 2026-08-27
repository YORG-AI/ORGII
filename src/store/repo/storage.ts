/**
 * Repo Store Storage
 *
 * Storage keys, persistence helpers, and store reset functionality.
 *
 * ARCHITECTURE (Feb 2, 2026):
 * Window-scoped vs Global storage:
 * - selectedRepo/selectedBranch: sessionStorage (window-scoped)
 *   Each window has its own selected repo, enabling true multi-window isolation.
 * - lastUsedRepo/cachedRepos: localStorage (global)
 *   Shared across windows for new window initialization and recent repos.
 */
import { createLogger } from "@src/hooks/logger";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";

const log = createLogger("RepoStorage");

// ============================================
// Storage Keys
// ============================================

export const REPO_STORAGE_KEYS = {
  // Window-scoped keys (stored in sessionStorage with window ID suffix)
  // Each window maintains its own selection independently
  selectedRepo: "selected_repo",
  selectedBranch: "selected_branch",

  // Global keys (stored in localStorage, shared across all windows)
  // Used for new window initialization and cross-window coordination
  lastUsedRepo: "orgii_last_used_repo",
  cachedRepos: "orgii_cached_repos",

  // Cross-window tracking of opened repos
  // Maps windowId -> repoId for all active windows
  openedRepos: "orgii_opened_repos",
} as const;

// ============================================
// Cache Invalidation
// ============================================

/**
 * Key for cache invalidation timestamp in localStorage.
 *
 * Written by `resetRepoStore` so cross-tab consumers can poll the key
 * for changes. No DOM event is dispatched; subscribe via
 * `window.addEventListener("storage", …)` if cross-window freshness
 * is required.
 */
export const CACHE_INVALIDATION_KEY = "orgii_repo_cache_invalidated_at";

/**
 * Get the last cache invalidation timestamp
 */
export function getCacheInvalidationTimestamp(): number {
  try {
    const stored = localStorage.getItem(CACHE_INVALIDATION_KEY);
    return stored ? parseInt(stored, 10) : 0;
  } catch {
    return 0;
  }
}

// ============================================
// Storage Helpers
// ============================================

/**
 * Clear all repo-related storage entries
 *
 * Handles both:
 * - sessionStorage: window-scoped keys (selectedRepo, selectedBranch)
 * - localStorage: global keys (lastUsedRepo, cachedRepos)
 */
export function clearRepoStorage(): void {
  try {
    // Clear window-scoped keys from sessionStorage
    // These are stored with window ID suffix, so we need to find and remove them
    const sessionKeysToRemove: string[] = [];
    for (let index = 0; index < sessionStorage.length; index++) {
      const key = sessionStorage.key(index);
      if (
        key &&
        (key.startsWith(REPO_STORAGE_KEYS.selectedRepo) ||
          key.startsWith(REPO_STORAGE_KEYS.selectedBranch))
      ) {
        sessionKeysToRemove.push(key);
      }
    }
    sessionKeysToRemove.forEach((key) => sessionStorage.removeItem(key));

    // Clear global keys from localStorage
    localStorage.removeItem(REPO_STORAGE_KEYS.lastUsedRepo);
    localStorage.removeItem(REPO_STORAGE_KEYS.cachedRepos);
  } catch (error) {
    throw new Error(
      `[repoStorage] Failed to clear storage: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Validate UUID format
 */
export function isValidUUID(uuid: string | undefined | null): boolean {
  if (!uuid) return false;
  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

// ============================================
// Store Reset
// ============================================

/**
 * Reset the repo store by:
 * 1. Clearing all repo-related localStorage
 * 2. Directly resetting all Jotai atoms to their initial values
 * 3. Setting a cache invalidation timestamp for components that check it
 *
 * This directly resets atoms using Jotai's store API, ensuring the
 * reset works regardless of which subscriber hooks are mounted.
 *
 * Note: This function imports atoms dynamically to avoid circular dependencies.
 */
export function resetRepoStore(): void {
  // Dynamic import to avoid circular dependency
  // eslint-disable-next-line @typescript-eslint/no-var-requires -- Runtime require intentionally breaks the storage/atom import cycle.
  const atoms = require("./atoms");

  try {
    // 1. Clear localStorage
    clearRepoStorage();

    // 2. Directly reset all Jotai atoms using the instrumented store
    // This ensures components using useAtomValue will see the updates
    const store = getInstrumentedStore();
    store.set(atoms.reposAtom, []);
    store.set(atoms.validRepoIdsAtom, new Set<string>());
    store.set(atoms.selectedRepoIdAtom, "");
    store.set(atoms.selectedBranchAtom, "main");
    store.set(atoms.lastUsedRepoAtom, "");
    store.set(atoms.currentBranchAtom, "");
    store.set(atoms.branchesAtom, []);
    store.set(atoms.repoLoadingAtom, false);
    store.set(atoms.branchLoadingAtom, false);
    store.set(atoms.repoErrorAtom, null);
    store.set(atoms.repoLastLoadedAtom, null);
    store.set(atoms.repoFilterAtom, "");
    // Reset freshness tracking
    store.set(atoms.repoLastCheckAtom, null);
    store.set(atoms.repoIsFreshAtom, false);

    // Note: globalSelectedRepoIdAtom and globalSelectedBranchAtom in globalSelectorAtom.ts
    // are just re-exports of selectedRepoIdAtom and selectedBranchAtom, so they're
    // already reset above. No need to reset them separately.

    // 3. Set cache invalidation timestamp for components that check it on mount
    localStorage.setItem(CACHE_INVALIDATION_KEY, Date.now().toString());
  } catch (error) {
    throw new Error(
      `[repoStorage] Failed to reset store: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

// ============================================
// Cross-Window Opened Repos Tracking
// ============================================

/** Type for opened repos map: windowId -> repoId */
type OpenedReposMap = Record<string, string>;

let hasLoggedOpenedRepoStorageFailure = false;

/**
 * The opened-repo registry is a best-effort cross-window hint. Repository
 * selection remains authoritative in memory, so storage pressure must not
 * turn a failed hint write into a fatal application error.
 */
function persistOpenedReposMap(map: OpenedReposMap): void {
  try {
    localStorage.setItem(REPO_STORAGE_KEYS.openedRepos, JSON.stringify(map));
    hasLoggedOpenedRepoStorageFailure = false;
  } catch (error) {
    if (hasLoggedOpenedRepoStorageFailure) return;
    hasLoggedOpenedRepoStorageFailure = true;
    log.warn(
      "Cross-window repository tracking is unavailable; continuing without persisting the opened-repo registry.",
      error
    );
  }
}

/**
 * Get the map of all opened repos across windows. Cross-window
 * consumers can subscribe to the browser's native `storage` event on
 * `REPO_STORAGE_KEYS.openedRepos` to react to other windows' edits.
 */
export function getOpenedReposMap(): OpenedReposMap {
  try {
    const stored = localStorage.getItem(REPO_STORAGE_KEYS.openedRepos);
    return stored ? JSON.parse(stored) : {};
  } catch {
    return {};
  }
}

/**
 * Specialty Tauri windows (wingman panels, native bars, popouts, the
 * pre-warmed welcome window) are NOT valid focus targets for repo
 * selection: they live alongside main-app windows but the user never
 * "opens a repo" into them. They still mount React and run
 * `useRepoSelection`, so without filtering they would pollute the
 * cross-window registry and `getWindowIdsForRepo` would return them
 * as candidates for "focus existing window".
 *
 * Main-app windows are `"main"` and any timestamp-suffixed clones
 * (e.g. `main-1715648400000`). Anything else listed here is a
 * specialty window and must stay out of the registry.
 */
export function isMainAppWindowLabel(windowId: string): boolean {
  if (windowId === "main") return true;
  if (windowId === "wingman") return false;
  if (windowId.startsWith("wingman-")) return false;
  if (windowId === "tab") return false;
  if (windowId === "welcome") return false;
  return true;
}

/**
 * Get all main-app window IDs that have a specific repo open.
 *
 * Specialty windows (wingman, etc.) are filtered out — see
 * `isMainAppWindowLabel`.
 */
export function getWindowIdsForRepo(repoId: string): string[] {
  const map = getOpenedReposMap();
  const windowIds: string[] = [];
  for (const [windowId, openRepoId] of Object.entries(map)) {
    if (openRepoId === repoId && isMainAppWindowLabel(windowId)) {
      windowIds.push(windowId);
    }
  }
  return windowIds;
}

/**
 * Register a window's selected repo in the opened repos map.
 *
 * Specialty windows are skipped — they should never advertise a repo
 * to the cross-window focus logic.
 */
export function registerOpenedRepo(windowId: string, repoId: string): void {
  if (!isMainAppWindowLabel(windowId)) return;
  const map = getOpenedReposMap();
  if (repoId) {
    if (map[windowId] === repoId) return;
    map[windowId] = repoId;
  } else {
    if (!(windowId in map)) return;
    delete map[windowId];
  }
  persistOpenedReposMap(map);
}

/**
 * Unregister a window from the opened repos map (e.g., on window close)
 */
export function unregisterWindow(windowId: string): void {
  const map = getOpenedReposMap();
  if (!(windowId in map)) return;
  delete map[windowId];
  persistOpenedReposMap(map);
}

/**
 * Clear all opened repos - call on app startup to clean stale entries
 * from windows that didn't properly unregister (crash, force close, etc.)
 */
export function clearAllOpenedRepos(): void {
  try {
    localStorage.removeItem(REPO_STORAGE_KEYS.openedRepos);
    hasLoggedOpenedRepoStorageFailure = false;
  } catch (error) {
    if (hasLoggedOpenedRepoStorageFailure) return;
    hasLoggedOpenedRepoStorageFailure = true;
    log.warn(
      "Cross-window repository tracking could not be cleared; continuing with the in-memory repository selection.",
      error
    );
  }
}
