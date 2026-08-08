import {
  GLOBAL_THEMES,
  getGlobalTheme,
  resolveGlobalThemePreference,
} from "@src/config/appearance/globalThemes";
import { createLogger } from "@src/hooks/logger";
import {
  preloadThemeCss,
  syncThemeAppearance,
} from "@src/util/ui/theme/swapThemeCss";

const log = createLogger("Theme");

/**
 * Initialize theme CSS
 *
 * PERFORMANCE: This runs at startup and returns a Promise to ensure CSS is loaded
 * before React mounts, avoiding both FOUC and hover/cursor issues in Tauri.
 *
 * Note: We use direct localStorage.getItem here instead of the cache because:
 * 1. This runs before React mounts (cache isn't preloaded yet)
 * 2. We only read one key (minimal overhead)
 * 3. The preload hint in index.html handles the network side
 *
 * BUG FIX: Waits for CSS to load before resolving to prevent hover/cursor issues
 * in Tauri apps where CSS loading can be delayed on first launch.
 *
 * OPTIMIZATION: Timeout reduced to 500ms since CSS is preloaded in index.html
 * and should be available from cache almost instantly.
 */
function scheduleThemePreload(activeThemePath: string): void {
  const preload = () => {
    const themePaths = Array.from(
      new Set(Object.values(GLOBAL_THEMES).map((theme) => theme.baseCssPath))
    ).filter((themePath) => themePath !== activeThemePath);

    preloadThemeCss(themePaths);
  };

  if ("requestIdleCallback" in window) {
    window.requestIdleCallback(preload, { timeout: 1500 });
    return;
  }

  setTimeout(preload, 250);
}

const initTheme = (): Promise<void> => {
  return new Promise((resolve, _reject) => {
    const startTime = performance.now();

    // Get theme from localStorage (supports legacy CSS path and legacy light/dark)
    const storedTheme = localStorage.getItem("theme");
    const themeId = resolveGlobalThemePreference(storedTheme);
    const theme = getGlobalTheme(themeId).baseCssPath;

    // Check if the preloaded CSS matches the user's theme preference
    // If so, it should load almost instantly from cache
    const isDefaultTheme = theme === "/orgii_main.css";

    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.type = "text/css";
    link.href = theme;
    link.setAttribute("data-orgii-theme", "");

    // Track if already resolved to prevent double-resolution
    let resolved = false;
    const safeResolve = () => {
      if (resolved) return;
      resolved = true;
      scheduleThemePreload(theme);
      resolve();
    };

    // Wait for CSS to load before resolving
    link.onload = () => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          syncThemeAppearance(theme);
          safeResolve();
        });
      });
    };

    link.onerror = (error) => {
      if (resolved) return;
      resolved = true;
      log.error("[Theme] Failed to load CSS:", theme, error);
      scheduleThemePreload(theme);
      // Don't block app startup - resolve anyway
      resolve();
    };

    // PERFORMANCE: Reduced timeout from 3s to 500ms
    // CSS is preloaded in index.html, so it should be cached and load fast
    // If it takes longer than 500ms, something is wrong - proceed anyway
    const timeoutMs = isDefaultTheme ? 500 : 1000; // Longer for non-default themes
    const timeoutId = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      const duration = performance.now() - startTime;
      log.warn(
        `[Theme] CSS load timeout after ${duration.toFixed(0)}ms, continuing:`,
        theme
      );
      scheduleThemePreload(theme);
      resolve();
    }, timeoutMs);

    // Clear timeout if CSS loads successfully
    const originalOnload = link.onload;
    link.onload = (event) => {
      clearTimeout(timeoutId);
      if (originalOnload) {
        (originalOnload as (event: Event) => void)(event);
      }
    };

    // Insert at the start of <head> for highest CSS priority
    const head = document.querySelector("head");
    head!.insertBefore(link, head!.firstChild);
  });
};

export { initTheme };
