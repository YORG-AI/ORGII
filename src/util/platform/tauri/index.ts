import { createLogger } from "@src/hooks/logger";

const log = createLogger("Tauri");

declare global {
  interface Window {
    __TAURI_IPC__: unknown;
    __TAURI__?: {
      version: string;
    };
    __TAURI_INTERNALS__?: {
      unregisterCallback?: (id: unknown) => void;
    };
    __TAURI_EVENT_PLUGIN_INTERNALS__: {
      unregisterListener: (event: string, eventId: number) => void;
    };
    [key: string]: unknown; // Allow dynamic property access
  }
}

/**
 * Safely patch Tauri internals to prevent unregisterCallback errors
 */
const patchTauriInternals = () => {
  if (typeof window === "undefined" || !window.__TAURI_INTERNALS__) return;

  const internals = window.__TAURI_INTERNALS__;

  try {
    const originalUnregisterCallback = internals.unregisterCallback;

    const patchedUnregisterCallback =
      typeof originalUnregisterCallback === "function"
        ? function (this: unknown, id: unknown) {
            try {
              return originalUnregisterCallback.call(this, id);
            } catch (error) {
              log.warn("Tauri unregisterCallback error suppressed:", error);
            }
          }
        : function (id: unknown) {
            log.warn(
              "Tauri unregisterCallback called with id:",
              id,
              "- function not available, ignoring"
            );
          };

    const descriptor = Object.getOwnPropertyDescriptor(
      internals,
      "unregisterCallback"
    );

    // If the property is locked down (non-writable and non-configurable), do not attempt to patch.
    if (
      descriptor &&
      descriptor.writable === false &&
      descriptor.configurable === false
    ) {
      return;
    }

    // Prefer defineProperty when possible (works for configurable props and avoids setter oddities).
    if (descriptor?.configurable) {
      Object.defineProperty(internals, "unregisterCallback", {
        value: patchedUnregisterCallback,
        writable: true,
        configurable: true,
      });
      return;
    }

    // If the object is non-extensible and the property doesn't already exist, we can't add it.
    if (!descriptor && !Object.isExtensible(internals)) {
      return;
    }

    // Fallback to assignment (works when writable or when a setter exists).
    internals.unregisterCallback = patchedUnregisterCallback;
  } catch (error) {
    // Never let patching crash the app.
    log.warn("Failed to patch Tauri internals (safe to ignore):", error);
  }
};

/**
 * Safely patch Tauri event plugin internals to prevent unregisterListener errors
 * This fixes: "undefined is not an object (evaluating 'listeners[eventId].handlerId')"
 * which occurs during race conditions when event listeners are cleaned up
 */
const patchTauriEventPluginInternals = () => {
  if (typeof window === "undefined") return;

  // The event plugin internals may not be available immediately, so we set up a polling mechanism
  const tryPatch = () => {
    const eventInternals = window.__TAURI_EVENT_PLUGIN_INTERNALS__;
    if (!eventInternals) return false;

    try {
      const originalUnregisterListener = eventInternals.unregisterListener;

      // Skip if already patched
      if (
        originalUnregisterListener &&
        (originalUnregisterListener as { __patched?: boolean }).__patched
      ) {
        return true;
      }

      const patchedUnregisterListener =
        typeof originalUnregisterListener === "function"
          ? function (this: unknown, event: string, eventId: number): void {
              try {
                return originalUnregisterListener.call(this, event, eventId);
              } catch (error) {
                // Silently ignore - this happens when the listener was already cleaned up
                // Common during component unmounts or when watched folders are deleted
                if (
                  error instanceof Error &&
                  error.message.includes("handlerId")
                ) {
                  // Expected race condition, silently ignore
                  return;
                }
                log.warn("Tauri unregisterListener error suppressed:", error);
              }
            }
          : function (event: string, eventId: number) {
              log.warn(
                "Tauri unregisterListener called:",
                event,
                eventId,
                "- function not available, ignoring"
              );
            };

      // Mark as patched to avoid double-patching
      (patchedUnregisterListener as { __patched?: boolean }).__patched = true;

      const descriptor = Object.getOwnPropertyDescriptor(
        eventInternals,
        "unregisterListener"
      );

      // If the property is locked down, don't attempt to patch
      if (
        descriptor &&
        descriptor.writable === false &&
        descriptor.configurable === false
      ) {
        return true;
      }

      // Prefer defineProperty when possible
      if (descriptor?.configurable) {
        Object.defineProperty(eventInternals, "unregisterListener", {
          value: patchedUnregisterListener,
          writable: true,
          configurable: true,
        });
        return true;
      }

      // If the object is non-extensible and the property doesn't exist, we can't add it
      if (!descriptor && !Object.isExtensible(eventInternals)) {
        return true;
      }

      // Fallback to assignment
      eventInternals.unregisterListener = patchedUnregisterListener;
      return true;
    } catch (error) {
      log.warn(
        "Failed to patch Tauri event plugin internals (safe to ignore):",
        error
      );
      return true; // Return true to stop retrying on error
    }
  };

  // Try immediately
  if (tryPatch()) return;

  // Retry a few times with increasing delays, as the internals may not be ready immediately
  const retryDelays = [10, 50, 100, 500, 1000];
  let retryIndex = 0;

  const retry = () => {
    if (retryIndex >= retryDelays.length) return;
    setTimeout(() => {
      if (!tryPatch()) {
        retryIndex++;
        retry();
      }
    }, retryDelays[retryIndex]);
  };

  retry();
};

// Apply all patches immediately
patchTauriInternals();
patchTauriEventPluginInternals();

/**
 * Check if running in Tauri desktop client
 * @returns {boolean} Whether in Tauri environment
 */
export const isTauriDesktop = () => {
  // Always return true for Tauri dev mode testing
  return true;
};

// Cache platform signals once -- platform never changes at runtime
const userAgent =
  typeof navigator !== "undefined" ? navigator.userAgent.toLowerCase() : "";
const processPlatform =
  typeof process !== "undefined" ? process.platform : undefined;

/**
 * Check if running on macOS
 * @returns {boolean} Whether the app is running on macOS
 */
export const isMacOS = (): boolean =>
  processPlatform === "darwin" ||
  userAgent.includes("macintosh") ||
  userAgent.includes("mac os");

/**
 * Check if running on Windows
 * @returns {boolean} Whether the app is running on Windows
 */
export const isWindows = (): boolean =>
  processPlatform === "win32" || userAgent.includes("windows");

/**
 * Check if running on Linux
 * @returns {boolean} Whether the app is running on Linux
 */
export const isLinux = (): boolean =>
  processPlatform === "linux" ||
  (userAgent.includes("linux") && !userAgent.includes("android"));

/**
 * Get Tauri version information
 * @returns {string | null} Tauri version number, returns null if not in Tauri environment
 */
export const getTauriVersion = (): string | null => {
  try {
    return window.__TAURI__?.version || null;
  } catch {
    return null;
  }
};

/**
 * Safely call an unlisten function to prevent race condition errors
 * Use this when cleaning up Tauri event listeners in useEffect cleanup functions
 *
 * @param unlistenFn - The unlisten function returned by listen() or watch()
 * @param options - Optional configuration
 * @param options.defer - If true, defers cleanup to next tick (default: true)
 * @param options.silent - If true, doesn't log warnings (default: true)
 *
 * @example
 * ```ts
 * useEffect(() => {
 *   let unlisten: UnlistenFn | null = null;
 *   listen("my-event", handler).then(fn => { unlisten = fn; });
 *   return () => safeUnlisten(unlisten);
 * }, []);
 * ```
 */
export function safeUnlisten(
  unlistenFn: (() => void) | null | undefined,
  options?: { defer?: boolean; silent?: boolean }
): void {
  if (!unlistenFn) return;

  const { defer = true, silent = true } = options ?? {};

  const doUnlisten = () => {
    try {
      unlistenFn();
    } catch (error) {
      if (!silent) {
        log.warn("safeUnlisten: Error during cleanup (safe to ignore):", error);
      }
      // Error is swallowed - this is expected during race conditions
    }
  };

  if (defer) {
    // Defer to next tick to avoid race conditions with Tauri internals
    setTimeout(doUnlisten, 0);
  } else {
    doUnlisten();
  }
}

// Re-export file search utilities
export * from "./fileSearch";

// Re-export folder archive utilities
export * from "./folderArchive";

// Re-export file utilities (binary detection, ignore filtering)
export * from "./fileUtils";

// Re-export Tauri initialization and utilities
export {
  isTauri,
  ensureTauriReady,
  initializeTauriAPIs,
  isTauriReady,
  invokeTauri,
  listenTauri,
  base64ToFile,
} from "./init";
