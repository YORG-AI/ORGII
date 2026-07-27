/**
 * UI Atom
 *
 * Pure UI state management (extracted from allAtom.ts)
 * Theme, modals, terminal settings, and other UI-only state.
 * Persistent settings are backed by the central settings system (~/.orgii/settings.jsonc).
 *
 * Background configuration atoms live in backgroundConfigAtom.ts. Import them
 * directly from "@src/store/ui/backgroundConfigAtom" or from the "@src/store/ui"
 * barrel — they are not re-exported from this file.
 */
import { atom } from "jotai";

import {
  type ApplicationUiFontId,
  normalizeApplicationUiFontId,
} from "@src/config/appearance/applicationUiFonts";
import {
  APPEARANCE_MODE,
  type SystemColorScheme,
  THEME_PREFERENCE,
  getGlobalTheme,
  getSystemColorScheme,
  normalizeGlobalThemeId,
  normalizeGlobalThemePreference,
  resolveGlobalThemePreference,
} from "@src/config/appearance/globalThemes";
import type { PrimaryColorPreset } from "@src/config/appearance/primaryColors";
import {
  settingsAtom,
  updateSettingAtom,
} from "@src/store/settings/settingsAtom";

// ============================================
// Theme & Appearance
// ============================================

/** Current global theme preference from settings.jsonc (normalized from legacy values) */
export const globalThemeIdAtom = atom(
  (get) => {
    const theme = get(settingsAtom)["general.theme"];
    return normalizeGlobalThemePreference(theme);
  },
  (_get, set, value: string) => {
    const themePreference = normalizeGlobalThemePreference(value);
    set(updateSettingAtom, { key: "general.theme", value: themePreference });
  }
);
globalThemeIdAtom.debugLabel = "globalThemeIdAtom";

export const systemColorSchemeAtom = atom<SystemColorScheme>(
  getSystemColorScheme()
);
systemColorSchemeAtom.debugLabel = "systemColorSchemeAtom";

/** Concrete theme ID after resolving the global theme preference */
export const resolvedGlobalThemeIdAtom = atom((get) => {
  const themePreference = get(globalThemeIdAtom);
  if (themePreference === THEME_PREFERENCE.SYSTEM) {
    return get(systemColorSchemeAtom) === APPEARANCE_MODE.DARK
      ? "github-dark"
      : "github-light";
  }
  return resolveGlobalThemePreference(themePreference);
});
resolvedGlobalThemeIdAtom.debugLabel = "resolvedGlobalThemeIdAtom";

/** Current theme CSS file resolved from the global theme preference */
export const themesAtom = atom(
  (get) => {
    const themeId = get(resolvedGlobalThemeIdAtom);
    return getGlobalTheme(themeId).baseCssPath;
  },
  (_get, set, value: string) => {
    const themeId = normalizeGlobalThemeId(value);
    set(updateSettingAtom, { key: "general.theme", value: themeId });
  }
);
themesAtom.debugLabel = "themesAtom";

/** Whether the active global theme is a dark variant */
export const isDarkThemeAtom = atom<boolean>((get) => {
  const themeId = get(resolvedGlobalThemeIdAtom);
  return getGlobalTheme(themeId).isDark;
});
isDarkThemeAtom.debugLabel = "isDarkThemeAtom";

export const primaryColorPresetAtom = atom(
  (get) => get(settingsAtom)["general.primaryColor"] as PrimaryColorPreset,
  (_get, set, value: PrimaryColorPreset) => {
    set(updateSettingAtom, { key: "general.primaryColor", value });
  }
);
primaryColorPresetAtom.debugLabel = "primaryColorPresetAtom";

// ============================================
// UI Scale
// ============================================

const DEFAULT_UI_SCALE = 100;
const MIN_UI_SCALE = 75;
const MAX_UI_SCALE = 150;
const UI_SCALE_STEP = 5;

export const uiScaleAtom = atom(
  (get) => get(settingsAtom)["general.uiScale"],
  (_get, set, value: number) => {
    const clampedValue = Math.max(MIN_UI_SCALE, Math.min(MAX_UI_SCALE, value));
    set(updateSettingAtom, { key: "general.uiScale", value: clampedValue });
    window.dispatchEvent(new Event("uiScaleChange"));
  }
);
uiScaleAtom.debugLabel = "uiScaleAtom";

export const UI_SCALE_CONFIG = {
  DEFAULT: DEFAULT_UI_SCALE,
  MIN: MIN_UI_SCALE,
  MAX: MAX_UI_SCALE,
  STEP: UI_SCALE_STEP,
};

export const applicationUiFontAtom = atom(
  (get) =>
    normalizeApplicationUiFontId(
      get(settingsAtom)["general.applicationUiFont"]
    ),
  (_get, set, value: ApplicationUiFontId) => {
    set(updateSettingAtom, { key: "general.applicationUiFont", value });
  }
);
applicationUiFontAtom.debugLabel = "applicationUiFontAtom";

// ============================================
// Terminal Theme & Settings
// ============================================

/** Terminal theme - automatically syncs with app theme (dark/light) */
export type TerminalThemeName = "dark" | "light";

// Terminal theme automatically syncs with app theme (light/dark)
export const terminalThemeAtom = atom<TerminalThemeName>((get) => {
  const isDarkTheme = get(isDarkThemeAtom);
  return isDarkTheme ? "dark" : "light";
});
terminalThemeAtom.debugLabel = "terminalThemeAtom";

// Terminal font size (backed by settings.jsonc)
export const terminalFontSizeAtom = atom(
  (get) => get(settingsAtom)["terminal.fontSize"],
  (_get, set, value: number) => {
    const clampedValue = Math.max(8, Math.min(32, value));
    set(updateSettingAtom, { key: "terminal.fontSize", value: clampedValue });
    window.dispatchEvent(new Event("terminalFontSizeChange"));
  }
);
terminalFontSizeAtom.debugLabel = "terminalFontSizeAtom";

// Terminal letter spacing (backed by settings.jsonc)
export const terminalLetterSpacingAtom = atom(
  (get) => get(settingsAtom)["terminal.letterSpacing"],
  (_get, set, value: number) => {
    const clampedValue = Math.max(-2, Math.min(10, value));
    set(updateSettingAtom, {
      key: "terminal.letterSpacing",
      value: clampedValue,
    });
    window.dispatchEvent(new Event("terminalLetterSpacingChange"));
  }
);
terminalLetterSpacingAtom.debugLabel = "terminalLetterSpacingAtom";

// ============================================
// User Display Name
// ============================================

export const userDisplayNameAtom = atom(
  (get) => get(settingsAtom)["general.userDisplayName"],
  (_get, set, value: string) => {
    set(updateSettingAtom, { key: "general.userDisplayName", value });
    window.dispatchEvent(new Event("userDisplayNameChange"));
  }
);
userDisplayNameAtom.debugLabel = "userDisplayNameAtom";

// ============================================
// Modal & Dialog State
// ============================================

/** Route debug trigger — set to true by Cmd+0; resets to false after toast fires */
export const routeDebugModalOpenAtom = atom<boolean>(false);
routeDebugModalOpenAtom.debugLabel = "routeDebugModalOpenAtom";

/**
 * Session expired state
 * When true, user will be blocked and redirected to login page
 */
export const sessionExpiredAtom = atom<boolean>(false);
sessionExpiredAtom.debugLabel = "sessionExpiredAtom";

// ============================================
// Session Expiration Event System
// ============================================

/** Custom event name for session expiration */
export const SESSION_EXPIRED_EVENT = "orgii:session-expired";

/**
 * Trigger session expiration from anywhere (including non-React code like API handlers)
 * This dispatches a custom event that the AuthGuard listens to
 */
export function triggerSessionExpired(): void {
  // Clear auth tokens
  localStorage.removeItem("id_token");
  localStorage.removeItem("user_id");
  localStorage.removeItem("hosted_user_id");
  // Clear user info atom storage
  localStorage.removeItem("orgii-user-info");
  // Dispatch custom event for React components to listen
  window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));
}

// ============================================
// Window State
// ============================================

/** Window fullscreen state (macOS) */
export const windowFullscreenAtom = atom<boolean>(false);
windowFullscreenAtom.debugLabel = "windowFullscreenAtom";

// ============================================
// Spotlight & Inspect Mode
// ============================================

/** Spotlight search open state */
export const spotlightOpenAtom = atom<boolean>(false);
spotlightOpenAtom.debugLabel = "spotlightOpenAtom";

/** Spotlight initial action - used to open spotlight with a specific action prefilled */
export const spotlightInitialActionAtom = atom<string | null>(null);
spotlightInitialActionAtom.debugLabel = "spotlightInitialActionAtom";

/**
 * Spotlight initial query - used to open Spotlight with a prefilled query
 * and optional URL-like second-layer target.
 */
export type SpotlightInitialEditorMode = "file" | "command" | "symbol";

export type SpotlightInitialLayer =
  | { kind: "default" }
  | { kind: "workspace"; mode: "switch" | "open" | "add" | "create" }
  | { kind: "branch" }
  | { kind: "worktree" }
  | { kind: "editor"; mode?: SpotlightInitialEditorMode }
  | { kind: "agentSessionSearch" }
  | { kind: "allSessionsSearch" }
  | { kind: "agentControl" }
  | { kind: "sessionCreator" };

export interface SpotlightInitialQuery {
  query: string;
  /** URL-like second-layer target for direct Spotlight navigation. */
  layer?: SpotlightInitialLayer;
}
export const spotlightInitialQueryAtom = atom<SpotlightInitialQuery | null>(
  null
);
spotlightInitialQueryAtom.debugLabel = "spotlightInitialQueryAtom";

/** Inspect mode locked (pinned element) */
export const inspectModeLockedAtom = atom<boolean>(false);
inspectModeLockedAtom.debugLabel = "inspectModeLockedAtom";

/** Inspect mode enabled (Command+8) */
export const inspectModeEnabledAtom = atom<boolean>(false);
inspectModeEnabledAtom.debugLabel = "inspectModeEnabledAtom";

/** ADE Manager active state. When enabled, agent-originated GUI actions may dispatch through the Zod ActionSystem. */
export const adeManagerEnabledAtom = atom<boolean>(false);
adeManagerEnabledAtom.debugLabel = "adeManagerEnabledAtom";

// ============================================
// Loading & Status
// ============================================

/** Online status. Guarded against environments where `navigator` is not
 *  defined (e.g. Vitest `node` runs that import this atom transitively). */
export const isOnlineAtom = atom<boolean>(
  typeof navigator === "undefined" ? true : navigator.onLine
);
isOnlineAtom.debugLabel = "isOnlineAtom";

export type SpotlightPlacement = "top" | "center";

export const spotlightPlacementAtom = atom(
  (get) =>
    get(settingsAtom)["general.spotlightPlacement"] as SpotlightPlacement,
  (_get, set, value: SpotlightPlacement) => {
    set(updateSettingAtom, { key: "general.spotlightPlacement", value });
  }
);
spotlightPlacementAtom.debugLabel = "spotlightPlacementAtom";
