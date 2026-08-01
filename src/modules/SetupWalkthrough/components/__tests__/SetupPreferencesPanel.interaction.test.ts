// @vitest-environment jsdom
import React, { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import SetupPreferencesPanel from "../SetupPreferencesPanel";

interface MockSelectOption {
  label: string;
  value: string;
}

interface MockSelectProps {
  value: string;
  options: MockSelectOption[];
  onChange: (value: string) => void;
  dataTestId?: string;
  disabled?: boolean;
}

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

vi.mock("@src/components/Select", () => ({
  default: ({
    value,
    options,
    onChange,
    dataTestId,
    disabled,
  }: MockSelectProps) =>
    React.createElement(
      "select",
      {
        value,
        disabled,
        "data-testid": dataTestId,
        onChange: (event: React.ChangeEvent<HTMLSelectElement>) =>
          onChange(event.currentTarget.value),
      },
      options.map((option) =>
        React.createElement(
          "option",
          { key: option.value, value: option.value },
          option.label
        )
      )
    ),
}));

describe("SetupPreferencesPanel presentation switching", () => {
  let container: HTMLDivElement;
  let root: Root;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("switches presentations without resetting preference values or callbacks", async () => {
    const onComplete = vi.fn();

    await act(async () => {
      root.render(
        React.createElement(SetupPreferencesPanel, {
          isClosing: false,
          onComplete,
          onSkip: vi.fn(),
        })
      );
    });

    const presentation = container.querySelector<HTMLSelectElement>(
      '[data-testid="setup-presentation"]'
    );
    expect(presentation?.value).toBe("native");
    expect(
      container.querySelector('[data-testid="setup-presentation-native"]')
    ).not.toBeNull();

    act(() => {
      if (!presentation) return;
      presentation.value = "classic";
      presentation.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(
      container.querySelector('[data-testid="setup-presentation-classic"]')
    ).not.toBeNull();
    expect(
      container.querySelector<HTMLSelectElement>(
        '[data-testid="setup-appearance-mode"]'
      )?.value
    ).toBe("dark");

    act(() => {
      if (!presentation) return;
      presentation.value = "cinematic";
      presentation.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(
      container.querySelector('[data-testid="setup-presentation-cinematic"]')
    ).not.toBeNull();
    expect(
      container.querySelector<HTMLSelectElement>(
        '[data-testid="setup-appearance-mode"]'
      )?.value
    ).toBe("dark");

    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="setup-finish"]')
        ?.click();
    });
    expect(onComplete).toHaveBeenCalledOnce();

    act(() => {
      if (!presentation) return;
      presentation.value = "native";
      presentation.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(
      container.querySelector('[data-testid="setup-presentation-native"]')
    ).not.toBeNull();
  });
});
