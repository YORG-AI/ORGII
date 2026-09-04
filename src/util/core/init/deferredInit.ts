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

  // Remove the native startup background — the React CSS background
  // is now painted and we can restore transparent glass appearance.
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
 * Check if first paint is complete
 */
export function isFirstPaintComplete(): boolean {
  return firstPaintComplete;
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

/**
 * Execute a callback after first paint is complete.
 * If first paint is already complete, executes immediately via microtask.
 *
 * @param callback Function to execute after first paint
 * @param options Configuration options
 */
export function deferAfterPaint(
  callback: () => void,
  options: {
    /** Use requestIdleCallback for non-critical tasks */
    useIdleCallback?: boolean;
    /** Timeout for requestIdleCallback */
    idleTimeout?: number;
  } = {}
): void {
  const { useIdleCallback = false, idleTimeout = 1000 } = options;

  const executeCallback = () => {
    if (useIdleCallback && "requestIdleCallback" in window) {
      requestIdleCallback(callback, { timeout: idleTimeout });
    } else {
      // Use microtask to avoid blocking
      queueMicrotask(callback);
    }
  };

  if (firstPaintComplete) {
    executeCallback();
  } else {
    waitingCallbacks.push(executeCallback);
  }
}

/**
 * React hook helper - returns true after first paint is complete.
 * Useful for conditionally triggering effects.
 *
 * @example
 * const isReady = useIsFirstPaintComplete();
 * useEffect(() => {
 *   if (isReady) {
 *     loadData();
 *   }
 * }, [isReady]);
 */
export function getFirstPaintStatus(): boolean {
  return firstPaintComplete;
}

// ============================================
// Reset (for testing)
// ============================================

export function resetFirstPaintState(): void {
  firstPaintComplete = false;
  firstPaintPromise = null;
  firstPaintResolver = null;
  waitingCallbacks.length = 0;
}
