import { createRoot } from "react-dom/client";

import { initializeSharedServiceAuthStorage } from "@src/api/http/auth/sharedAuthStorage";
import { configureIdeServerForIdentifier } from "@src/config/ideServer";
import { applyHostDesktopWindowChromeRadius } from "@src/config/windowChromeRadius";
import { configureCloudAuthCallbackForIdentifier } from "@src/features/Org2Cloud/config";
import { installGlobalTauriSelectAllShortcut } from "@src/hooks/keyboard/useTauriSelectAllShortcut";
import { createLogger, initializeLogging } from "@src/hooks/logger/useLogger";
import { i18nReady } from "@src/i18n";
import "@src/util/core/storage/cleanup";
import "@src/util/platform/tauri";

import "./index.scss";
import { clearAllOpenedRepos } from "./store/repo";
import { initBackgroundImage } from "./util/core/init/backgroundInit";
import { reloadForChunkError as reloadChunk } from "./util/core/init/chunkReload";
import { initTheme } from "./util/core/init/themeInit";
import { initializeTauriAPIs, invokeTauri } from "./util/platform/tauri/init";

applyHostDesktopWindowChromeRadius();
initializeLogging();
installGlobalTauriSelectAllShortcut();

const log = createLogger("Init");

const isDev = process.env.NODE_ENV === "development";

// Disable browser's automatic scroll restoration
// This prevents the browser from restoring scroll positions from previous sessions
// which can cause unexpected layout shifts on app load
if ("scrollRestoration" in history) {
  history.scrollRestoration = "manual";
}

// ============================================================================
// ERROR HANDLERS
// ============================================================================
const isChunkError = (msg?: string) =>
  msg?.includes("ChunkLoadError") ||
  msg?.includes("Loading chunk") ||
  msg?.includes("dynamically imported module");

// Bounded reload on chunk failure (see chunkReload.ts). Falls back to the
// emergency error UI when the retry budget is exhausted and the inline
// startup-error panel is unavailable.
const reloadForChunkError = () =>
  reloadChunk(() =>
    showEmergencyError(
      "Failed to Load Application Assets",
      "An app asset could not be loaded after several attempts. Check your network connection, then retry. If this persists, reinstalling may help.",
      true
    )
  );

// Early chunk error handling (before React mounts)
window.onerror = (message) => {
  if (typeof message === "string" && isChunkError(message)) {
    reloadForChunkError();
    return true;
  }
  return false;
};

window.onunhandledrejection = (event) => {
  if (isChunkError(event.reason?.message)) {
    reloadForChunkError();
    event.preventDefault();
  }
};

// Resource loading errors (scripts/stylesheets)
window.addEventListener(
  "error",
  (event: Event) => {
    const target = event.target;
    if (target instanceof HTMLScriptElement) {
      const src = target.src || "";
      if (src.includes("chunk") || src.includes("vendor")) {
        reloadForChunkError();
      }
    }
    if (target instanceof HTMLLinkElement) {
      if (target.rel === "stylesheet" && target.href?.includes("chunk")) {
        reloadForChunkError();
      }
    }
  },
  true
);

// Emergency error UI helper
const showEmergencyError = (
  title: string,
  message: string,
  showClearData = false
) => {
  // CRITICAL: Hide splash screen first - it has z-index:99999 and would cover the error
  const splash = document.getElementById("splash");
  if (splash) {
    splash.style.display = "none";
  }

  const rootElement = document.getElementById("root");
  if (!rootElement) return;
  rootElement.innerHTML = `
    <div style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#f5f5f5;z-index:99999">
      <div style="display:flex;flex-direction:column;align-items:center;gap:24px;max-width:400px;text-align:center;padding:24px">
        <div style="font-size:48px">💥</div>
        <div style="color:#374151;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:18px;font-weight:500">${title}</div>
        <div style="color:#6b7280;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;line-height:1.5">${message}</div>
        <button onclick="${showClearData ? "localStorage.clear();sessionStorage.clear();" : ""}window.location.reload()" style="background:#3b82f6;color:white;border:none;padding:12px 24px;border-radius:8px;font-size:14px;font-weight:500;cursor:pointer">${showClearData ? "Clear Data & Restart" : "Restart"}</button>
      </div>
    </div>`;
};

// ============================================================================
// HOT MODULE REPLACEMENT: Cleanup webviews on hot reload
// ============================================================================
// Native Tauri webviews don't automatically clean up when React components
// unmount during HMR. Close all webviews when HMR applies updates.

if (isDev && module.hot) {
  module.hot.addStatusHandler?.((status: string) => {
    if (status === "prepare") {
      invokeTauri("close_all_inline_webviews").catch(() => {});
    }
  });
}

// ============================================================================
// INITIALIZE APPLICATION
// ============================================================================

// Timeout for overall initialization to prevent hanging forever
const INIT_TIMEOUT_MS = 10000;

async function initializeRuntimeInstanceIdentity(): Promise<void> {
  try {
    const { getIdentifier } = await import("@tauri-apps/api/app");
    const identifier = await getIdentifier();
    configureIdeServerForIdentifier(identifier);
    configureCloudAuthCallbackForIdentifier(identifier);
  } catch {
    // Browser/unit-test builds retain the compile-time/default callback.
  }
}

// PERFORMANCE: Initialize all critical services in parallel before render
async function initializeApp() {
  // Runtime identity must be known before loading App: several API modules
  // derive local HTTP/WebSocket constants at module evaluation time.
  await initializeRuntimeInstanceIdentity();
  // Tauri dev and bundled WebViews have different origins. Hydrate the shared
  // app-data auth store before App imports initialize auth atoms and guards.
  try {
    await initializeSharedServiceAuthStorage();
  } catch (error) {
    // Fall back to this origin's local session if the store is unavailable.
    // A focus event retries synchronization after React mounts.
    log.warn("[Init] Shared auth storage unavailable:", error);
  }
  const appModulePromise = import("@src/App");

  // Clear stale opened repos from previous app session (main window only)
  // Secondary windows should not clear, as they'd wipe main window's registration
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const currentWindow = getCurrentWindow();
    if (currentWindow.label === "main") {
      clearAllOpenedRepos();
    }
  } catch {
    // Not in Tauri or main window detection failed - clear anyway for safety
    clearAllOpenedRepos();
  }

  // All three init operations are independent - run them ALL in parallel:
  // - Theme CSS: loads via <link> element (network/cache)
  // - Tauri APIs: imports JS modules (JS parsing)
  // - Background: loads from IndexedDB + decodes (disk + GPU)
  //
  // Wrap in timeout to prevent hanging forever if any init hangs
  const initPromise = Promise.all([
    i18nReady,
    initTheme(),
    initializeTauriAPIs(),
    initBackgroundImage(),
    appModulePromise,
  ]);

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(new Error("Initialization timeout - app may be in a bad state"));
    }, INIT_TIMEOUT_MS);
  });

  try {
    await Promise.race([initPromise, timeoutPromise]);
  } catch (error) {
    // Log but continue - we want to mount React even if some init failed
    log.warn("[Init] Initialization issue:", error);
  }

  const App = (await appModulePromise).default;

  // Mount React app
  const rootElement = document.getElementById("root");
  if (rootElement) {
    // Track if React successfully rendered anything
    let reactRendered = false;

    // SAFETY: If React fails to render within timeout, show emergency error
    // React 18's render() is async and doesn't throw - errors go to ErrorBoundary
    // or get silently swallowed. This timeout catches cases where React completely fails.
    const splashTimeoutId = setTimeout(() => {
      const splash = document.getElementById("splash");
      if (splash && splash.style.display !== "none") {
        log.critical("[Init] React failed to render within timeout");
        // Check if React rendered anything at all
        if (!reactRendered && rootElement.children.length === 0) {
          showEmergencyError(
            "Application Failed to Start",
            "React failed to render. Try clearing app data and restarting.",
            true
          );
        } else {
          // React rendered something but splash wasn't hidden - just hide splash
          log.warn("[Init] Splash still visible, force hiding");
          splash.style.display = "none";
        }
      }
    }, 5000);

    // React 18 error handling - these catch errors that escape ErrorBoundary
    const handleReactError = (
      error: unknown,
      errorInfo: { componentStack?: string }
    ) => {
      log.critical("[React] Uncaught error:", error, errorInfo);
      clearTimeout(splashTimeoutId);
      showEmergencyError(
        "Critical React Error",
        "The application encountered a fatal error. Try clearing app data.",
        true
      );
    };

    try {
      const rootOptions: Record<string, unknown> = {
        // Called for errors caught by Error Boundaries (React 19+)
        onCaughtError: (error: unknown, errorInfo: unknown) => {
          log.error("[React] Error caught by boundary:", error, errorInfo);
          // ErrorBoundary handles display - just mark as rendered
          reactRendered = true;
        },
        // Called for errors NOT caught by Error Boundaries (fatal)
        onUncaughtError: handleReactError,
        // Called for errors during hydration or recoverable errors
        onRecoverableError: (error: unknown, errorInfo: unknown) => {
          log.warn("[React] Recoverable error:", error, errorInfo);
        },
      };
      const root = createRoot(
        rootElement,
        rootOptions as Parameters<typeof createRoot>[1]
      );

      root.render(<App />);

      // Mark as rendered after a microtask (render is scheduled, not sync)
      queueMicrotask(() => {
        reactRendered = true;
      });
    } catch (error) {
      // This only catches synchronous errors (rare in React 18)
      clearTimeout(splashTimeoutId);
      log.critical("[Init] React mount failed synchronously:", error);
      showEmergencyError(
        "Critical Startup Error",
        "React failed to initialize. This is usually caused by corrupted application data.",
        true
      );
      throw error;
    }

    // PERFORMANCE: Defer non-critical initialization to after first render.
    // Console / log level gating is already wired synchronously via
    // initializeLogging() at the top of this file, so nothing log-related
    // needs to run here.
    if (isDev) {
      const deferredInit = () => {
        import("@src/util/core/storage/devIndexedDBProtection").then(
          ({ initDevIndexedDBProtection }) => {
            initDevIndexedDBProtection();
          }
        );

        // Import diagnoseBackgroundStorage for window exports
        import("@src/util/core/storage/diagnosis");
      };

      if (typeof requestIdleCallback !== "undefined") {
        requestIdleCallback(deferredInit, { timeout: 1000 });
      } else {
        setTimeout(deferredInit, 100);
      }
    }
  } else {
    log.critical("Failed to find the root element");
  }
}

// Start initialization
initializeApp().catch((error) => {
  log.critical("[Init] App initialization failed:", error);
  showEmergencyError(
    "Initialization Failed",
    "The application failed to initialize. Please try restarting."
  );
});
