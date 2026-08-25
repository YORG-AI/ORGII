/**
 * Git Output Integration Constants
 *
 * Global state and constants for git output integration.
 */

/**
 * Global set to track logged operation IDs across all hook instances.
 * This prevents duplicate logs when multiple editor tabs are open.
 * Each tab has its own useGitOutputIntegration instance, but they all
 * share this global deduplication set.
 */
export const loggedOperationIds = new Set<string>();

/**
 * Maximum number of operation IDs to keep in the deduplication set.
 * Prevents unbounded memory growth over long sessions.
 */
export const MAX_LOGGED_IDS = 100;

/**
 * Prune the logged operation IDs set to prevent unbounded memory growth.
 * Keeps only the most recent half of IDs.
 */
export function pruneLoggedOperationIds(): void {
  if (loggedOperationIds.size > MAX_LOGGED_IDS) {
    const idsArray = Array.from(loggedOperationIds);
    loggedOperationIds.clear();
    idsArray
      .slice(-MAX_LOGGED_IDS / 2)
      .forEach((id) => loggedOperationIds.add(id));
  }
}
