/**
 * Deferred Initialization Utilities
 *
 * Provides a system for deferring API calls and heavy initialization
 * until after the first UI paint is complete.
 *
 * Usage:
 * - Call `signalFirstPaintComplete()` after first meaningful paint
 * - Use `waitForFirstPaint()` in hooks to defer API calls
 * - Use `deferAfterPaint()` for one-time deferred operations
 */
import { createLogger } from "@src/hooks/logger";
import { syncMacosRootTint } from "@src/util/platform/macosRootTint";

const log = createLogger("DeferredInit");

// ============================================
// State
// ============================================

let firstPaintComplete = false;
let firstPaintPromise: Promise<void> | null = null;
let firstPaintResolver: (() => void) | null = null;

// Queue for callbacks waiting for first paint
const waitingCallbacks: Array<() => void> = [];

// ============================================
// Core API
// ============================================

/**
 * Signal that first paint is complete.
 * Call this from App.tsx after the initial skeleton/UI is rendered.
 */
export function signalFirstPaintComplete(): void {
  if (firstPaintComplete) return;

  firstPaintComplete = true;

  // Remove the native startup cover once the React CSS surface is painted.
  import("@tauri-apps/api/core")
    .then(({ invoke }) => invoke("remove_window_background"))
    .catch(() => {
      // Non-Tauri env or unimportant failure — ignore.
    })
    // macOS: move the CSS root tint into a native layer under the webview so
    // the strip exposed by a live resize matches the page.
    .then(() => syncMacosRootTint());

  // Resolve the promise
  if (firstPaintResolver) {
    firstPaintResolver();
  }

  // Execute all waiting callbacks
  waitingCallbacks.forEach((callback) => {
    try {
      callback();
    } catch (error) {
      log.error("[DeferredInit] Error in deferred callback:", error);
    }
  });

  // Clear the queue
  waitingCallbacks.length = 0;
}

/**
 * Returns a promise that resolves after first paint is complete.
 * Use this in async functions to wait for first paint.
 *
 * @example
 * async function loadData() {
 *   await waitForFirstPaint();
 *   // Now safe to make API calls
 *   const data = await fetchData();
 * }
 */
export function waitForFirstPaint(): Promise<void> {
  if (firstPaintComplete) {
    return Promise.resolve();
  }

  if (!firstPaintPromise) {
    firstPaintPromise = new Promise((resolve) => {
      firstPaintResolver = resolve;
    });
  }

  return firstPaintPromise;
}
