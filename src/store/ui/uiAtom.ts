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
import {
  type AccentPreset,
  normalizeAccentPreset,
} from "@src/config/appearance/skins/accent";
import {
  DEFAULT_SKIN_ID,
  getSkinSeed,
  resolveSkinId,
  supportsBothVariants,
} from "@src/config/appearance/skins/registry";
import type { SkinSeed, SkinVariant } from "@src/config/appearance/skins/types";
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
      ? "dark"
      : "light";
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

// ============================================
// Skins
// ============================================

/** Which half of the skin configuration is currently in effect. */
export const skinVariantAtom = atom<SkinVariant>((get) =>
  get(isDarkThemeAtom) ? "dark" : "light"
);
skinVariantAtom.debugLabel = "skinVariantAtom";

/**
 * Whether one skin and accent serve both variants.
 *
 * Linking is enforced on write rather than on read: the two settings keep
 * storing their own value, and the writers mirror across. That way unlinking
 * restores whatever each side last held instead of leaving both stuck on the
 * linked choice, and a settings file edited by hand is never misreported.
 */
export const linkSkinVariantsAtom = atom(
  (get) => get(settingsAtom)["general.linkSkinVariants"],
  (get, set, value: boolean) => {
    set(updateSettingAtom, { key: "general.linkSkinVariants", value });
    if (!value) return;
    // Adopt the live variant's selection for both sides — but only if that skin
    // can actually serve both, rather than pinning a dark-only skin to light.
    const activeSkin = get(activeSkinIdAtom);
    set(
      lightSkinIdAtom,
      supportsBothVariants(activeSkin) ? activeSkin : DEFAULT_SKIN_ID.light
    );
    set(lightAccentPresetAtom, get(primaryColorPresetAtom));
  }
);
linkSkinVariantsAtom.debugLabel = "linkSkinVariantsAtom";

export const lightSkinIdAtom = atom(
  (get) => resolveSkinId(get(settingsAtom)["general.lightSkin"], "light"),
  (get, set, value: string) => {
    set(updateSettingAtom, {
      key: "general.lightSkin",
      value: resolveSkinId(value, "light"),
    });
    if (get(linkSkinVariantsAtom) && supportsBothVariants(value)) {
      set(updateSettingAtom, {
        key: "general.darkSkin",
        value: resolveSkinId(value, "dark"),
      });
    }
  }
);
lightSkinIdAtom.debugLabel = "lightSkinIdAtom";

export const darkSkinIdAtom = atom(
  (get) => resolveSkinId(get(settingsAtom)["general.darkSkin"], "dark"),
  (get, set, value: string) => {
    set(updateSettingAtom, {
      key: "general.darkSkin",
      value: resolveSkinId(value, "dark"),
    });
    if (get(linkSkinVariantsAtom) && supportsBothVariants(value)) {
      set(updateSettingAtom, {
        key: "general.lightSkin",
        value: resolveSkinId(value, "light"),
      });
    }
  }
);
darkSkinIdAtom.debugLabel = "darkSkinIdAtom";

/** The skin backing the current variant. */
export const activeSkinIdAtom = atom<string>((get) =>
  get(skinVariantAtom) === "dark" ? get(darkSkinIdAtom) : get(lightSkinIdAtom)
);
activeSkinIdAtom.debugLabel = "activeSkinIdAtom";

export const activeSkinSeedAtom = atom<SkinSeed>((get) =>
  getSkinSeed(get(activeSkinIdAtom), get(skinVariantAtom))
);
activeSkinSeedAtom.debugLabel = "activeSkinSeedAtom";

// ============================================
// Accent
// ============================================

export const lightAccentPresetAtom = atom(
  (get) =>
    normalizeAccentPreset(get(settingsAtom)["general.primaryColorLight"]),
  (get, set, value: AccentPreset) => {
    set(updateSettingAtom, { key: "general.primaryColorLight", value });
    if (get(linkSkinVariantsAtom)) {
      set(updateSettingAtom, { key: "general.primaryColorDark", value });
    }
  }
);
lightAccentPresetAtom.debugLabel = "lightAccentPresetAtom";

export const darkAccentPresetAtom = atom(
  (get) => normalizeAccentPreset(get(settingsAtom)["general.primaryColorDark"]),
  (get, set, value: AccentPreset) => {
    set(updateSettingAtom, { key: "general.primaryColorDark", value });
    if (get(linkSkinVariantsAtom)) {
      set(updateSettingAtom, { key: "general.primaryColorLight", value });
    }
  }
);
darkAccentPresetAtom.debugLabel = "darkAccentPresetAtom";

/**
 * Accent for the current variant. Writing routes to whichever of the two
 * per-variant settings is live, so callers never have to branch on the mode.
 */
export const primaryColorPresetAtom = atom(
  (get) =>
    get(skinVariantAtom) === "dark"
      ? get(darkAccentPresetAtom)
      : get(lightAccentPresetAtom),
  (get, set, value: AccentPreset) => {
    set(
      get(skinVariantAtom) === "dark"
        ? darkAccentPresetAtom
        : lightAccentPresetAtom,
      value
    );
  }
);
primaryColorPresetAtom.debugLabel = "primaryColorPresetAtom";

// ============================================
// Surface + icon treatment
// ============================================

export const translucentSidebarAtom = atom(
  (get) => get(settingsAtom)["general.translucentSidebar"],
  (_get, set, value: boolean) => {
    set(updateSettingAtom, { key: "general.translucentSidebar", value });
  }
);
translucentSidebarAtom.debugLabel = "translucentSidebarAtom";

export const iconStyleAtom = atom(
  (get) => get(settingsAtom)["general.iconStyle"],
  (_get, set, value: "colorful" | "monochrome") => {
    set(updateSettingAtom, { key: "general.iconStyle", value });
  }
);
iconStyleAtom.debugLabel = "iconStyleAtom";

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

/** Login modal visibility */
export const loginModalVisibleAtom = atom<boolean>(false);
loginModalVisibleAtom.debugLabel = "loginModalVisibleAtom";

/** Route debug trigger — set to true by Cmd+0; resets to false after toast fires */
export const routeDebugModalOpenAtom = atom<boolean>(false);
routeDebugModalOpenAtom.debugLabel = "routeDebugModalOpenAtom";

/** Login modal fixed position */
export const loginModalFixAtom = atom<boolean>(false);
loginModalFixAtom.debugLabel = "loginModalFixAtom";

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
