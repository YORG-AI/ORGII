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
    expect(html).toContain('data-testid="setup-presentation"');
    expect(html).toContain('data-testid="setup-presentation-native"');
    expect(html).toContain('data-testid="setup-appearance-mode"');
    expect(html).toContain('data-testid="setup-theme"');
    expect(html).toContain('data-testid="setup-primary-color"');
    expect(html.match(/role="combobox"/g)).toHaveLength(4);
    expect(html.match(/aria-haspopup="listbox"/g)).toHaveLength(4);
    expect(html).toContain("bg-primary-container");
    expect(html).toContain("!bg-transparent");
    expect(html.match(/class="section-layout-row/g)).toHaveLength(4);
    expect(html).not.toContain("setup-preference-row");
    expect(html).not.toContain("setup-preference-cta");
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

  it("can start in the cinematic presentation without changing bindings", () => {
    const html = renderToStaticMarkup(
      React.createElement(SetupPreferencesPanel, {
        isClosing: false,
        onComplete: vi.fn(),
        onSkip: vi.fn(),
        initialPresentation: "cinematic",
      })
    );

    expect(html).toContain('data-testid="setup-presentation-cinematic"');
    expect(html).toContain("setup-preferences-card");
    expect(html).toContain("setup-preference-row");
    expect(html).toContain("setup-preference-cta");
    expect(html).toContain('data-testid="setup-appearance-mode"');
    expect(html).toContain('data-testid="setup-theme"');
    expect(html).toContain('data-testid="setup-primary-color"');
  });

  it("can start in the classic vertical presentation with canonical controls", () => {
    const html = renderToStaticMarkup(
      React.createElement(SetupPreferencesPanel, {
        isClosing: false,
        onComplete: vi.fn(),
        onSkip: vi.fn(),
        initialPresentation: "classic",
      })
    );

    expect(html).toContain('data-testid="setup-presentation-classic"');
    expect(html).toContain("onboarding:readiness.classicPanel.title");
    expect(html).toContain("onboarding:readiness.classicPanel.description");
    expect(html).not.toContain("logo.png");
    expect(html).toContain("!bg-transparent");
    expect(html.match(/flex-col/g)?.length).toBeGreaterThanOrEqual(4);
    expect(html).toContain('data-testid="setup-appearance-mode"');
    expect(html).toContain('data-testid="setup-theme"');
    expect(html).toContain('data-testid="setup-primary-color"');
    expect(html).not.toContain("setup-preference-row");
  });
});
