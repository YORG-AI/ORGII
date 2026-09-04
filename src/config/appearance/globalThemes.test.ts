import { describe, expect, it } from "vitest";

import {
  APPEARANCE_MODE,
  APPEARANCE_MODE_OPTIONS,
  GLOBAL_THEMES,
  getAppearanceModeForTheme,
  getGlobalTheme,
  isThemeCssPathDark,
  normalizeAppearanceMode,
  normalizeGlobalThemeId,
  normalizeGlobalThemePreference,
} from "./globalThemes";

describe("global themes", () => {
  it("ships exactly one stylesheet per variant", () => {
    expect(Object.keys(GLOBAL_THEMES).sort()).toEqual(["dark", "light"]);
    expect(GLOBAL_THEMES.light.baseCssPath).toBe("/orgii_main.css");
    expect(GLOBAL_THEMES.dark.baseCssPath).toBe("/orgii_dark.css");
  });

  it("no longer offers high contrast as an appearance mode", () => {
    expect(APPEARANCE_MODE_OPTIONS).toEqual(["system", "light", "dark"]);
    expect(APPEARANCE_MODE).not.toHaveProperty("HIGH_CONTRAST");
    expect(normalizeAppearanceMode("highContrast")).toBe(APPEARANCE_MODE.LIGHT);
  });

  describe("legacy ids", () => {
    it("maps the retired named themes onto their variant", () => {
      expect(normalizeGlobalThemePreference("github-light")).toBe("light");
      expect(normalizeGlobalThemePreference("github-dark")).toBe("dark");
      expect(normalizeGlobalThemeId("github-light")).toBe("light");
      expect(normalizeGlobalThemeId("github-dark")).toBe("dark");
    });

    it("keeps a high-contrast user on a dark app rather than flipping to light", () => {
      expect(normalizeGlobalThemePreference("orgii-high-contrast")).toBe(
        "dark"
      );
      expect(normalizeGlobalThemeId("/orgii_high_contrast.css")).toBe("dark");
      expect(getAppearanceModeForTheme("orgii-high-contrast")).toBe(
        APPEARANCE_MODE.DARK
      );
    });

    it("maps stylesheet paths, which older builds stored verbatim", () => {
      expect(normalizeGlobalThemeId("/orgii_main.css")).toBe("light");
      expect(normalizeGlobalThemeId("/orgii_dark.css")).toBe("dark");
      expect(isThemeCssPathDark("/orgii_dark.css")).toBe(true);
      expect(isThemeCssPathDark("/orgii_main.css")).toBe(false);
    });

    it("falls back to the default for values it cannot place", () => {
      expect(normalizeGlobalThemePreference("solarized-lagoon")).toBe("system");
      expect(normalizeGlobalThemeId("solarized-lagoon")).toBe("light");
    });
  });

  it("reports system as its own appearance mode", () => {
    expect(getAppearanceModeForTheme("system")).toBe(APPEARANCE_MODE.SYSTEM);
  });

  it("always resolves to a concrete theme definition", () => {
    expect(getGlobalTheme("dark").isDark).toBe(true);
    expect(getGlobalTheme("light").isDark).toBe(false);
    expect(getGlobalTheme(null).baseCssPath).toMatch(/orgii_(main|dark)\.css/);
  });
});
