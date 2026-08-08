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
  const getFinishButtonMarkup = (html: string): string => {
    const match = html.match(
      /<button(?=[^>]*data-testid="setup-finish")[\s\S]*?<\/button>/
    );
    expect(match).not.toBeNull();
    return match?.[0] ?? "";
  };

  it("renders only the three essential preference controls and terminal actions", () => {
    const html = renderToStaticMarkup(
      React.createElement(SetupPreferencesPanel, {
        isClosing: false,
        onComplete: vi.fn(),
        onSkip: vi.fn(),
      })
    );

    expect(html).toContain('data-testid="setup-language"');
    expect(html).toContain('data-testid="setup-appearance-mode"');
    expect(html).toContain('data-testid="setup-primary-color"');
    expect(html).not.toContain('data-testid="setup-theme"');
    expect(html).not.toContain('data-testid="setup-presentation"');
    expect(html).not.toContain("onboarding:readiness.presentation.compact");
    expect(html.match(/role="combobox"/g)).toHaveLength(2);
    expect(html.match(/aria-haspopup="listbox"/g)).toHaveLength(2);
    expect(html.match(/class="section-layout-row/g)).toHaveLength(3);
    expect(html).toContain("select-ghost");
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
    expect(html).not.toContain('data-testid="setup-presentation"');
  });

  it("replaces the fixed-width trailing arrow with an equal-width spinner", () => {
    const render = (isClosing: boolean) =>
      getFinishButtonMarkup(
        renderToStaticMarkup(
          React.createElement(SetupPreferencesPanel, {
            isClosing,
            onComplete: vi.fn(),
            onSkip: vi.fn(),
          })
        )
      );

    const idle = render(false);
    const closing = render(true);
    const iconSlotPattern =
      /<span class="([^"]*pointer-events-none[^"]*ml-2[^"]*)"><svg([^>]*)>/;
    const idleSlot = idle.match(iconSlotPattern);
    const closingSlot = closing.match(iconSlotPattern);

    expect(idleSlot?.[1]).toBe(closingSlot?.[1]);
    expect(idleSlot?.[2]).toContain('width="16"');
    expect(closingSlot?.[2]).toContain('width="16"');
    expect(idle).toContain("lucide-arrow-right");
    expect(idle).not.toContain("animate-spin");
    expect(closing).toContain("animate-spin");
    expect(idle.match(/<svg/g)).toHaveLength(1);
    expect(closing.match(/<svg/g)).toHaveLength(1);
    expect(idle).not.toContain("→");
  });
});
