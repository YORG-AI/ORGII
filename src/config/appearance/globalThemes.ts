/**
 * Global appearance mode.
 *
 * This module answers exactly one question: is the app currently painting in
 * light or in dark, and which base stylesheet backs that. *Which* palette is
 * used within a variant is a separate concern owned by `skins/registry.ts` —
 * the user picks a light skin and a dark skin independently.
 *
 * Historically each named theme was its own stylesheet (`github-light`,
 * `github-dark`, `orgii-high-contrast`). Those ids are kept as legacy aliases so
 * existing `settings.jsonc` files and `localStorage` entries keep resolving.
 */
export const GLOBAL_THEME_IDS = ["light", "dark"] as const;

export type GlobalThemeId = (typeof GLOBAL_THEME_IDS)[number];

export const THEME_PREFERENCE = {
  SYSTEM: "system",
} as const;

export const GLOBAL_THEME_PREFERENCES = [
  THEME_PREFERENCE.SYSTEM,
  ...GLOBAL_THEME_IDS,
] as const;

export type GlobalThemePreference = (typeof GLOBAL_THEME_PREFERENCES)[number];

export type SystemColorScheme = "light" | "dark";

export const APPEARANCE_MODE = {
  SYSTEM: "system",
  LIGHT: "light",
  DARK: "dark",
} as const;

export type AppearanceMode =
  (typeof APPEARANCE_MODE)[keyof typeof APPEARANCE_MODE];

export type ThemeCssPath = "/orgii_main.css" | "/orgii_dark.css";

export interface GlobalThemeDefinition {
  id: GlobalThemeId;
  i18nKey: string;
  baseCssPath: ThemeCssPath;
  isDark: boolean;
}

const ORGII_LIGHT_THEME: GlobalThemeDefinition = {
  id: "light",
  i18nKey: "general.light",
  baseCssPath: "/orgii_main.css",
  isDark: false,
};

const ORGII_DARK_THEME: GlobalThemeDefinition = {
  id: "dark",
  i18nKey: "general.dark",
  baseCssPath: "/orgii_dark.css",
  isDark: true,
};

export const GLOBAL_THEMES: Record<GlobalThemeId, GlobalThemeDefinition> = {
  light: ORGII_LIGHT_THEME,
  dark: ORGII_DARK_THEME,
};

/**
 * `orgii-high-contrast` was removed when skins landed. It resolves to dark so
 * anyone who had it selected keeps a dark app instead of silently snapping to
 * light; the accessibility gap is tracked separately from the skin work.
 */
export const LEGACY_THEME_ALIASES = {
  "github-light": "light",
  "github-dark": "dark",
  "orgii-high-contrast": "dark",
  "/orgii_main.css": "light",
  "/orgii_dark.css": "dark",
  "/orgii_high_contrast.css": "dark",
} as const;

export const DEFAULT_GLOBAL_THEME_ID: GlobalThemeId = "light";
export const DEFAULT_GLOBAL_THEME_PREFERENCE: GlobalThemePreference =
  THEME_PREFERENCE.SYSTEM;

export function isGlobalThemeId(value: string): value is GlobalThemeId {
  return value in GLOBAL_THEMES;
}

export function isGlobalThemePreference(
  value: string
): value is GlobalThemePreference {
  return value === THEME_PREFERENCE.SYSTEM || isGlobalThemeId(value);
}

export function getSystemColorScheme(): SystemColorScheme {
  if (typeof window === "undefined") return APPEARANCE_MODE.LIGHT;
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? APPEARANCE_MODE.DARK
    : APPEARANCE_MODE.LIGHT;
}

export function getSystemThemeId(): GlobalThemeId {
  return getSystemColorScheme() === APPEARANCE_MODE.DARK ? "dark" : "light";
}

export function getSystemThemeEnglishLabel(
  colorScheme: SystemColorScheme = getSystemColorScheme()
): "Light" | "Dark" {
  return colorScheme === APPEARANCE_MODE.DARK ? "Dark" : "Light";
}

export function getFollowSystemThemeLabel(
  colorScheme: SystemColorScheme = getSystemColorScheme(),
  followSystemLabel = "Follow system"
): string {
  return `${followSystemLabel} (${getSystemThemeEnglishLabel(colorScheme)})`;
}

export function normalizeGlobalThemeId(
  value: string | null | undefined
): GlobalThemeId {
  if (!value) return DEFAULT_GLOBAL_THEME_ID;
  if (value === THEME_PREFERENCE.SYSTEM) return getSystemThemeId();
  if (isGlobalThemeId(value)) return value;
  return (
    LEGACY_THEME_ALIASES[value as keyof typeof LEGACY_THEME_ALIASES] ??
    DEFAULT_GLOBAL_THEME_ID
  );
}

export function normalizeGlobalThemePreference(
  value: string | null | undefined
): GlobalThemePreference {
  if (!value) return DEFAULT_GLOBAL_THEME_PREFERENCE;
  if (isGlobalThemePreference(value)) return value;
  return (
    LEGACY_THEME_ALIASES[value as keyof typeof LEGACY_THEME_ALIASES] ??
    DEFAULT_GLOBAL_THEME_PREFERENCE
  );
}

export function resolveGlobalThemePreference(
  preference: string | null | undefined
): GlobalThemeId {
  const normalizedPreference = normalizeGlobalThemePreference(preference);
  return normalizedPreference === THEME_PREFERENCE.SYSTEM
    ? getSystemThemeId()
    : normalizedPreference;
}

export function getGlobalTheme(
  themeId: string | null | undefined
): GlobalThemeDefinition {
  return GLOBAL_THEMES[resolveGlobalThemePreference(themeId)];
}

export function isThemeCssPathDark(
  themePath: string | null | undefined
): boolean {
  return getGlobalTheme(themePath).isDark;
}

export const GLOBAL_THEME_GROUPS: Record<
  Exclude<AppearanceMode, typeof APPEARANCE_MODE.SYSTEM>,
  GlobalThemeId[]
> = {
  [APPEARANCE_MODE.LIGHT]: ["light"],
  [APPEARANCE_MODE.DARK]: ["dark"],
};

export function getAppearanceModeForTheme(
  themeId: string | null | undefined
): AppearanceMode {
  const normalizedPreference = normalizeGlobalThemePreference(themeId);
  if (normalizedPreference === THEME_PREFERENCE.SYSTEM) {
    return APPEARANCE_MODE.SYSTEM;
  }
  return GLOBAL_THEMES[normalizedPreference].isDark
    ? APPEARANCE_MODE.DARK
    : APPEARANCE_MODE.LIGHT;
}

export function normalizeAppearanceMode(value: string): AppearanceMode {
  if (value === APPEARANCE_MODE.SYSTEM) return APPEARANCE_MODE.SYSTEM;
  if (value === APPEARANCE_MODE.DARK) return APPEARANCE_MODE.DARK;
  return APPEARANCE_MODE.LIGHT;
}

export function getDefaultThemePreferenceForAppearanceMode(
  mode: AppearanceMode
): GlobalThemePreference {
  if (mode === APPEARANCE_MODE.SYSTEM) return THEME_PREFERENCE.SYSTEM;
  return GLOBAL_THEME_GROUPS[mode][0];
}

export function getDefaultThemeForAppearanceMode(
  mode: Exclude<AppearanceMode, typeof APPEARANCE_MODE.SYSTEM>
): GlobalThemeId {
  return GLOBAL_THEME_GROUPS[mode][0];
}

export function getThemeOptionsForAppearanceMode(
  mode: AppearanceMode
): GlobalThemePreference[] {
  if (mode === APPEARANCE_MODE.SYSTEM) {
    return [THEME_PREFERENCE.SYSTEM];
  }
  return GLOBAL_THEME_GROUPS[mode];
}

export const APPEARANCE_MODE_OPTIONS = [
  APPEARANCE_MODE.SYSTEM,
  APPEARANCE_MODE.LIGHT,
  APPEARANCE_MODE.DARK,
] as const;
