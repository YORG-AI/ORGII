import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import SetupPreferencesPanel from "../SetupPreferencesPanel";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@src/modules/MainApp/Settings/sections/useAppearanceState", () => ({
  useAppearanceState: () => ({
    appearanceMode: "dark",
    appearanceModeOptions: [{ label: "Dark", value: "dark" }],
    globalThemeId: "orgii-dark",
    handleAppearanceModeChange: vi.fn(),
    handleThemeChange: vi.fn(),
    primaryColorOptions: [{ label: "Blue", value: "blue" }],
    primaryColorPreset: "blue",
    setPrimaryColorPreset: vi.fn(),
    themeOptions: [{ label: "ORGII Dark", value: "orgii-dark" }],
  }),
}));

vi.mock("@src/components/LanguageSelector", () => ({
  default: ({ ariaLabel }: { ariaLabel?: string }) =>
    React.createElement("div", {
      "aria-label": ariaLabel,
      "data-testid": "setup-language",
    }),
}));

describe("SetupPreferencesPanel", () => {
  it("renders four canonical preference controls and terminal actions", () => {
    const html = renderToStaticMarkup(
      React.createElement(SetupPreferencesPanel, {
        isClosing: false,
        onComplete: vi.fn(),
        onSkip: vi.fn(),
      })
    );

    expect(html).toContain('data-testid="setup-language"');
    expect(html).toContain('data-testid="setup-appearance-mode"');
    expect(html).toContain('data-testid="setup-theme"');
    expect(html).toContain('data-testid="setup-primary-color"');
    expect(html.match(/role="combobox"/g)).toHaveLength(3);
    expect(html.match(/aria-haspopup="listbox"/g)).toHaveLength(3);
    expect(html).toContain('data-testid="setup-finish"');
    expect(html).toContain('data-testid="setup-skip"');
  });

  it("keeps terminal actions visible and disables them while closing", () => {
    const html = renderToStaticMarkup(
      React.createElement(SetupPreferencesPanel, {
        isClosing: true,
        onComplete: vi.fn(),
        onSkip: vi.fn(),
      })
    );

    expect(html).toContain('data-testid="setup-finish"');
    expect(html).toContain('data-testid="setup-skip"');
    expect(html.match(/disabled=""/g)).toHaveLength(2);
  });
});
