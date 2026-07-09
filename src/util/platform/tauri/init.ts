/**
 * Global Tauri API initialization
 *
 * IMPORTANT: We only ship as Tauri app - no browser/web mode.
 * This means:
 * - isTauri() always returns true
 * - initializeTauriAPIs() is called in index.tsx BEFORE React mounts
 * - isTauriReady() returns true from the first component render
 * - No polling/waiting for Tauri availability is needed in components
 *
 * Benefits:
 * - Faster terminal loading (no repeated async imports)
 * - Single source of truth for Tauri availability
 * - Better error handling and debugging
 * - Window preloading for instant window creation
 *
 * Multiple Terminal Support:
 * - Each terminal creates its own PTY session with unique session ID
 * - Event listeners are scoped per session ID (e.g., 'pty-output-{sessionId}')
 * - Multiple terminals can coexist without conflicts
 */
import { createLogger } from "@src/hooks/logger";

const log = createLogger("Tauri");

type TauriInvoke = (
  cmd: string,
  args?: Record<string, unknown>
) => Promise<unknown>;
type TauriListen = <T>(
  event: string,
  handler: (event: { payload: T }) => void
) => Promise<() => void>;

interface TauriAPIs {
  invoke: TauriInvoke | null;
  listen: TauriListen | null;
  isAvailable: boolean;
  isTauriEnvironment: boolean;
}

// Global state for Tauri APIs
let tauriState: TauriAPIs = {
  invoke: null,
  listen: null,
  isAvailable: false,
  isTauriEnvironment: false,
};

// Initialization promise to prevent multiple concurrent initializations
let initPromise: Promise<boolean> | null = null;

/**
 * Check if running in Tauri environment
 * Always returns true - we only ship as Tauri app
 */
export const isTauri = (): boolean => {
  return true;
};

/**
 * Initialize Tauri APIs (call once at app startup)
 * Returns true if successfully loaded, false otherwise
 *
 * This function is idempotent - multiple calls will return the same result
 * without re-initializing.
 */
export const initializeTauriAPIs = async (): Promise<boolean> => {
  // Return cached result if already initialized
  if (tauriState.isAvailable) {
    return true;
  }

  // Return existing promise if initialization is in progress
  if (initPromise) {
    return initPromise;
  }

  // Create new initialization promise
  initPromise = (async () => {
    const inTauriEnv = isTauri();
    tauriState.isTauriEnvironment = inTauriEnv;

    if (!inTauriEnv) {
      return false;
    }

    try {
      const [core, event] = await Promise.all([
        import("@tauri-apps/api/core"),
        import("@tauri-apps/api/event"),
      ]);

      tauriState.invoke = core.invoke;
      tauriState.listen = event.listen as TauriListen;
      tauriState.isAvailable = true;

      return true;
    } catch (error) {
      log.error("[Tauri] Failed to load Tauri APIs:", error);
      tauriState.isAvailable = false;
      return false;
    }
  })();

  return initPromise;
};

/**
 * Get the current Tauri API state
 * Safe to call anytime - returns current state without initializing
 */
export const getTauriAPIs = (): TauriAPIs => {
  return { ...tauriState };
};

// Lazily cached tracker module to avoid dynamic import on every call
let trackerModule: typeof import("@src/util/monitoring/apiTracker") | null =
  null;
let trackerLoadPromise: Promise<
  typeof import("@src/util/monitoring/apiTracker")
> | null = null;

function getTracker(): typeof import("@src/util/monitoring/apiTracker") | null {
  if (trackerModule) return trackerModule;
  if (!trackerLoadPromise) {
    trackerLoadPromise = import("@src/util/monitoring/apiTracker").then(
      (mod) => {
        trackerModule = mod;
        return mod;
      }
    );
  }
  return null;
}

/**
 * Convenience function to invoke Tauri commands
 * Throws if Tauri is not available
 */
export async function invokeTauri<T = unknown>(
  cmd: string,
  args?: Record<string, unknown>
): Promise<T> {
  if (!tauriState.invoke) {
    throw new Error(
      "Tauri invoke is not available. Make sure to call initializeTauriAPIs() first."
    );
  }

  const tracker = getTracker();
  const activeTracker = tracker?.isApiTrackingEnabled() ? tracker : null;
  let requestId = "";

  if (activeTracker) {
    requestId = `tauri-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
    activeTracker.trackTauriInvoke(cmd, args, requestId);
  }

  try {
    const invokeOperation = () => tauriState.invoke!(cmd, args) as Promise<T>;
    const result = activeTracker
      ? await activeTracker.withDirectTauriInvokeTrackingSuppressed(
          invokeOperation
        )
      : await invokeOperation();
    if (activeTracker) {
      activeTracker.trackTauriInvokeResult(requestId, result);
    }
    return result;
  } catch (error) {
    if (activeTracker) {
      activeTracker.trackTauriInvokeResult(requestId, undefined, error);
    }
    throw error;
  }
}

/**
 * Convenience function to listen to Tauri events
 * Throws if Tauri is not available
 */
export async function listenTauri<T = unknown>(
  event: string,
  handler: (event: { payload: T }) => void
): Promise<() => void> {
  if (!tauriState.listen) {
    throw new Error(
      "Tauri listen is not available. Make sure to call initializeTauriAPIs() first."
    );
  }
  return tauriState.listen(event, handler);
}

/**
 * Check if Tauri APIs are ready to use
 */
export const isTauriReady = (): boolean => {
  return tauriState.isAvailable;
};

/**
 * Assert that Tauri APIs are initialized and ready.
 * Throws if APIs are not yet available.
 * Use as a guard at the top of functions that require Tauri.
 */
export function ensureTauriReady(): void {
  if (!tauriState.isAvailable) {
    throw new Error(
      "Tauri APIs not available. Ensure initializeTauriAPIs() was called at startup."
    );
  }
}

/**
 * Convert base64-encoded data to a File object.
 * Shared utility for git bundles and folder archives.
 *
 * @param base64Data - Base64-encoded binary data
 * @param fileName - Desired file name
 * @param mimeType - MIME type for the file
 * @returns File object ready for upload
 */
export function base64ToFile(
  base64Data: string,
  fileName: string,
  mimeType: string
): File {
  const binaryString = atob(base64Data);
  const bytes = new Uint8Array(binaryString.length);
  for (let idx = 0; idx < binaryString.length; idx++) {
    bytes[idx] = binaryString.charCodeAt(idx);
  }
  return new File([bytes], fileName, { type: mimeType });
}

/**
 * Reset Tauri state (mainly for testing)
 */
export const resetTauriState = (): void => {
  tauriState = {
    invoke: null,
    listen: null,
    isAvailable: false,
    isTauriEnvironment: false,
  };
  initPromise = null;
};
