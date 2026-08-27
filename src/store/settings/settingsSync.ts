/**
 * Settings Sync
 *
 * Listens to Tauri events from the file watcher and updates the settings atom.
 * Also handles initialization on app startup, including syncing the persisted
 * language preference to i18next after settings load from disk.
 *
 * This should be called once in a root-level component or provider.
 */
import { listen } from "@tauri-apps/api/event";
import i18n from "i18next";
import { useAtomValue, useSetAtom } from "jotai";
import { useEffect, useRef } from "react";

import {
  THEME_PREFERENCE,
  getGlobalTheme,
  getSystemColorScheme,
  normalizeGlobalThemePreference,
  resolveGlobalThemePreference,
} from "@src/config/appearance/globalThemes";
import {
  LANGUAGE_PREFERENCE,
  type LanguagePreference,
  resolveLanguagePreference,
} from "@src/i18n";
import { LANGUAGE_STORAGE_KEY } from "@src/store/ui/languageAtom";
import { swapThemeCss } from "@src/util/ui/theme/swapThemeCss";
import { showThemeTransitionCover } from "@src/util/ui/theme/themeTransitionCover";

import { systemColorSchemeAtom } from "../ui/uiAtom";
import {
  handleExternalChangeAtom,
  handleFileDeletedAtom,
  initSettingsAtom,
  settingsAtom,
  settingsLoadedAtom,
} from "./settingsAtom";

/** Tauri event names (must match the Rust constants) */
const SETTINGS_CHANGED_EVENT = "settings-file-changed";
const SETTINGS_DELETED_EVENT = "settings-file-deleted";

/**
 * Hook that initializes the settings system and listens for file changes.
 *
 * Call this once in a top-level component (e.g., App.tsx or a provider).
 *
 * @example
 * ```tsx
 * function App() {
 *   useSettingsSync();
 *   return <MainLayout />;
 * }
 * ```
 */
export function useSettingsSync(): void {
  const initSettings = useSetAtom(initSettingsAtom);
  const handleExternalChange = useSetAtom(handleExternalChangeAtom);
  const handleFileDeleted = useSetAtom(handleFileDeletedAtom);
  const settingsLoaded = useAtomValue(settingsLoadedAtom);
  const settings = useAtomValue(settingsAtom);
  const setSystemColorScheme = useSetAtom(systemColorSchemeAtom);

  const writingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    initSettings();

    const unlistenChange = listen<Record<string, unknown>>(
      SETTINGS_CHANGED_EVENT,
      (event) => {
        if (cancelled) return;
        if (writingRef.current) {
          writingRef.current = false;
          return;
        }
        handleExternalChange(event.payload);
      }
    );

    const unlistenDelete = listen(SETTINGS_DELETED_EVENT, () => {
      if (cancelled) return;
      handleFileDeleted();
    });

    return () => {
      cancelled = true;
      unlistenChange.then((unlisten) => unlisten());
      unlistenDelete.then((unlisten) => unlisten());
    };
  }, [initSettings, handleExternalChange, handleFileDeleted]);

  // Sync theme to resolved CSS after settings load from disk or external edits.
  useEffect(() => {
    if (!settingsLoaded) return;

    const themePreference = normalizeGlobalThemePreference(
      settings["general.theme"]
    );
    const resolvedThemeId = resolveGlobalThemePreference(themePreference);
    const selectedTheme = getGlobalTheme(resolvedThemeId);

    try {
      localStorage.setItem("theme", themePreference);
    } catch {
      // localStorage may be unavailable
    }

    void swapThemeCss(selectedTheme.baseCssPath);
  }, [settingsLoaded, settings]);

  useEffect(() => {
    if (!settingsLoaded) return;
    const themePreference = normalizeGlobalThemePreference(
      settings["general.theme"]
    );
    if (themePreference !== THEME_PREFERENCE.SYSTEM) return;

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleSystemThemeChange = () => {
      const resolvedThemeId = resolveGlobalThemePreference(themePreference);
      const selectedTheme = getGlobalTheme(resolvedThemeId);
      const cover = showThemeTransitionCover();
      void swapThemeCss(selectedTheme.baseCssPath)
        .then(() => {
          setSystemColorScheme(getSystemColorScheme());
        })
        .finally(() => {
          void cover.hide();
        });
    };

    // WKWebView can drop the `prefers-color-scheme` change event entirely, or
    // deliver it while the display is off and the swap machinery is paused
    // (App Nap / occlusion). Re-check on every return to visibility so a
    // scheme flip that happened during sleep always converges — without this,
    // the app stays on the stale scheme until the user manually toggles the
    // OS appearance twice.
    const resyncSystemTheme = () => {
      if (document.visibilityState === "hidden") return;
      if (document.documentElement.dataset.theme === getSystemColorScheme()) {
        return;
      }
      // Coverless: this runs at wake, where the mismatch is already visible;
      // a veil would only add a second visual hiccup.
      const resolvedThemeId = resolveGlobalThemePreference(themePreference);
      const selectedTheme = getGlobalTheme(resolvedThemeId);
      void swapThemeCss(selectedTheme.baseCssPath).then(() => {
        setSystemColorScheme(getSystemColorScheme());
      });
    };

    mediaQuery.addEventListener("change", handleSystemThemeChange);
    document.addEventListener("visibilitychange", resyncSystemTheme);
    window.addEventListener("focus", resyncSystemTheme);
    return () => {
      mediaQuery.removeEventListener("change", handleSystemThemeChange);
      document.removeEventListener("visibilitychange", resyncSystemTheme);
      window.removeEventListener("focus", resyncSystemTheme);
    };
  }, [settingsLoaded, settings, setSystemColorScheme]);

  // Sync language to i18next + localStorage after settings load from disk.
  // This bridges the gap between the async settings.jsonc load and the
  // synchronous i18n init that reads localStorage on cold start.
  useEffect(() => {
    if (!settingsLoaded) return;

    const languagePreference = settings[
      "general.language"
    ] as LanguagePreference;
    if (!languagePreference) return;

    const resolvedLanguage = resolveLanguagePreference(languagePreference);
    if (i18n.language !== resolvedLanguage) {
      i18n.changeLanguage(resolvedLanguage);
    }

    try {
      localStorage.setItem(
        LANGUAGE_STORAGE_KEY,
        JSON.stringify(languagePreference)
      );
    } catch {
      // localStorage may be unavailable
    }
  }, [settingsLoaded, settings]);

  useEffect(() => {
    if (!settingsLoaded) return;
    const languagePreference = settings[
      "general.language"
    ] as LanguagePreference;
    if (languagePreference !== LANGUAGE_PREFERENCE.SYSTEM) return;

    const handleSystemLanguageChange = () => {
      void i18n.changeLanguage(resolveLanguagePreference(languagePreference));
    };
    window.addEventListener("languagechange", handleSystemLanguageChange);
    return () =>
      window.removeEventListener("languagechange", handleSystemLanguageChange);
  }, [settingsLoaded, settings]);
}
