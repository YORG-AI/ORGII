/**
 * Browser-mode shim (local dev tooling — do not ship without review).
 *
 * Lets the frontend boot in a plain browser tab (e.g. http://localhost:1998)
 * where Tauri never injected `window.__TAURI_INTERNALS__`. Without it,
 * `@tauri-apps/api` throws at module-evaluation time
 * ("Cannot read properties of undefined (reading 'metadata')") and the app
 * dies before React mounts.
 *
 * The shim provides the minimal v2 internals contract:
 * - `metadata.currentWindow/currentWebview` so `getCurrentWindow()` works
 * - `invoke` that REJECTS, so every IPC call flows into the caller's existing
 *   error path instead of silently returning wrong shapes
 * - callback plumbing (`transformCallback` etc.) so `Channel`/event setup
 *   doesn't crash before its `invoke` rejects
 *
 * MUST be imported before any module that transitively imports
 * `@tauri-apps/api` — keep it as the first import of src/index.tsx.
 * No-op inside the real Tauri webview.
 */

const w = window as unknown as Record<string, unknown>;

const BROWSER_MODE_ERROR_NAME = "BrowserModeIpcError";

if (typeof window !== "undefined" && !("__TAURI_INTERNALS__" in window)) {
  let nextCallbackId = 1;
  const callbacks = new Map<number, (response: unknown) => void>();

  // The app's GlobalErrorHandler promotes ANY unhandled rejection to a
  // full-screen error page. Fire-and-forget `void invoke(...)` calls are
  // everywhere, so shim rejections must never reach it. This listener is
  // registered at first-import time — before the ErrorBoundary mounts — so
  // stopImmediatePropagation reliably shields later listeners.
  const isBrowserModeError = (reason: unknown): boolean => {
    let current = reason as { name?: string; cause?: unknown } | undefined;
    for (let depth = 0; current && depth < 8; depth++) {
      if (current.name === BROWSER_MODE_ERROR_NAME) return true;
      current = current.cause as typeof current;
    }
    return false;
  };

  window.addEventListener("unhandledrejection", (event) => {
    if (isBrowserModeError(event.reason)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  });

  w.__ORGII_BROWSER_MODE__ = true;
  w.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { label: "main" },
    },
    plugins: {},
    callbacks,
    invoke: (cmd: string) => {
      const error = new Error(`[browser-mode] Tauri IPC unavailable: ${cmd}`);
      error.name = BROWSER_MODE_ERROR_NAME;
      return Promise.reject(error);
    },
    transformCallback: (cb?: (response: unknown) => void) => {
      const id = nextCallbackId++;
      if (cb) callbacks.set(id, cb);
      return id;
    },
    unregisterCallback: (id: number) => {
      callbacks.delete(id);
    },
    runCallback: (id: number, response: unknown) => {
      callbacks.get(id)?.(response);
    },
    convertFileSrc: (filePath: string) => filePath,
  };
}

export {};
