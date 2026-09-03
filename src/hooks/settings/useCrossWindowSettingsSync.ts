/**
 * Cross-Window Settings Synchronization
 *
 * SIMPLE APPROACH: Dispatch a custom event when localStorage changes,
 * and let components re-read their values from localStorage.
 *
 * ARCHITECTURE:
 * - When localStorage changes in another window, the browser fires a 'storage' event
 * - We dispatch a custom 'settings-changed' event with the key and new value
 * - Individual atoms/components can listen for this event to update themselves
 *
 * Note: The 'storage' event only fires in OTHER windows, not the one that made the change.
 * This is by design - the window making the change already updates its own atoms.
 */
import { useEffect } from "react";

import {
  getGlobalTheme,
  resolveGlobalThemePreference,
} from "@src/config/appearance/globalThemes";
import { createLogger } from "@src/hooks/logger";
import { settingsSyncTimestampAtom } from "@src/store/ui/settingsSyncAtom";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";
import { swapThemeCss } from "@src/util/ui/theme/swapThemeCss";

const log = createLogger("CrossWindowSync");

// Prefixes for settings that should be synced across windows
// Any localStorage key starting with these prefixes will trigger a sync
const SYNC_PREFIXES = [
  "orgii_", // App settings (background, glass, notifications, etc.)
  "orgii:", // Editor settings (theme, terminal commands, etc.)
  "theme", // App theme (special case - no prefix)
  "test_settings", // Test runner settings
] as const;

// Special handlers for settings that need extra processing beyond atom updates
const SPECIAL_HANDLERS: Record<string, (newValue: string) => void> = {
  // Theme needs to update the CSS link element
  theme: (newValue: string) => {
    updateThemeCSS(newValue);
  },
  // UI scale needs to trigger a custom event for zoom
  orgii_ui_scale: (_newValue: string) => {
    window.dispatchEvent(new CustomEvent("uiScaleChange"));
  },
};

/**
 * Custom event dispatched when settings change in another window.
 * Components can listen for this to update their state.
 */
export const SETTINGS_CHANGED_EVENT = "cross-window-settings-changed";

export interface SettingsChangedEvent {
  key: string;
  newValue: string | null;
  oldValue: string | null;
}

/**
 * Hook to sync ALL settings across windows automatically.
 *
 * How it works:
 * 1. Listens for 'storage' events from other windows
 * 2. For matching keys (orgii_*, orgii:*, theme), dispatches a custom event
 * 3. Triggers Jotai store to re-read affected atoms from localStorage
 *
 * Call this once in your App component.
 */
export function useCrossWindowSettingsSync(): void {
  useEffect(() => {
    const handleStorageChange = (event: StorageEvent) => {
      // Only handle our settings keys
      if (!event.key) return;

      // Check if this key matches our sync prefixes
      const shouldSync = SYNC_PREFIXES.some(
        (prefix) =>
          event.key === prefix || (event.key?.startsWith(prefix) ?? false)
      );

      if (!shouldSync) return;

      // Dispatch custom event for any listeners
      window.dispatchEvent(
        new CustomEvent<SettingsChangedEvent>(SETTINGS_CHANGED_EVENT, {
          detail: {
            key: event.key,
            newValue: event.newValue,
            oldValue: event.oldValue,
          },
        })
      );

      // Run special handlers if needed
      const handler = SPECIAL_HANDLERS[event.key];
      if (handler && event.newValue) {
        try {
          handler(event.newValue);
        } catch (error) {
          log.warn(`Handler failed for ${event.key}:`, error);
        }
      }

      // Force Jotai atoms to re-read from localStorage
      // This works because atomWithStorage reads from localStorage on each get
      // We just need to trigger a re-render
      forceAtomRefresh(event.key, event.newValue);
    };

    // Listen for storage events from other windows
    window.addEventListener("storage", handleStorageChange);

    return () => {
      window.removeEventListener("storage", handleStorageChange);
    };
  }, []);
}

/**
 * Force Jotai atoms to refresh by triggering a store notification.
 * This works by setting a timestamp atom that causes re-renders.
 */
function forceAtomRefresh(key: string, _newValue: string | null): void {
  try {
    // Get the instrumented store and trigger a refresh
    const store = getInstrumentedStore();

    // Update the timestamp to trigger re-renders in components using synced atoms
    store.set(settingsSyncTimestampAtom, Date.now());

    // Log for debugging
    if (process.env.NODE_ENV === "development") {
      log.debug(`Synced: ${key}`);
    }
  } catch (error) {
    log.warn("[CrossWindowSync] Failed to refresh atoms:", error);
  }
}

/**
 * Update the theme CSS link element.
 * This ensures the visual theme actually changes, not just the atom.
 */
function updateThemeCSS(themeValue: string): void {
  const themeId = resolveGlobalThemePreference(themeValue);
  const themePath = getGlobalTheme(themeId).baseCssPath;
  void swapThemeCss(themePath);
}

export default useCrossWindowSettingsSync;
