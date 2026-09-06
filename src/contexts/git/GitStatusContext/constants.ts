/**
 * Constants for GitStatusContext
 */

// ============================================
// Concurrency Control
// ============================================

/**
 * Maximum concurrent git operations to prevent "bad file descriptor" errors.
 */
export const MAX_CONCURRENT_GIT_OPERATIONS = 2;

// ============================================
// Timing Constants
// ============================================

/**
 * Delay before fetching after repo switch to let rapid switching stabilize.
 */
export const REPO_SWITCH_DEBOUNCE_MS = 300;

/**
 * Delay before registering repo with Rust file watcher.
 */
export const WATCHER_REGISTRATION_DELAY_MS = 2000;

/**
 * Timeout for deferred provider mount via requestIdleCallback.
 */
export const DEFERRED_MOUNT_TIMEOUT_MS = 500;

/**
 * Fallback timeout for deferred provider mount.
 */
export const DEFERRED_MOUNT_FALLBACK_MS = 100;
