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

const mocks = vi.hoisted(() => ({
  handleAppearanceModeChange: vi.fn(),
  setPrimaryColorPreset: vi.fn(),
}));

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
    appearanceModeOptions: [
      { label: "Dark", value: "dark" },
      { label: "Light", value: "light" },
    ],
    handleAppearanceModeChange: mocks.handleAppearanceModeChange,
    primaryColorOptions: [
      { label: "Blue", value: "blue" },
      { label: "Orange", value: "orange" },
    ],
    primaryColorPreset: "blue",
    setPrimaryColorPreset: mocks.setPrimaryColorPreset,
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

describe("SetupPreferencesPanel interactions", () => {
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
    vi.clearAllMocks();
  });

  afterAll(() => {
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("writes essential preferences through canonical callbacks and finishes", async () => {
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

    const appearance = container.querySelector<HTMLSelectElement>(
      '[data-testid="setup-appearance-mode"]'
    );
    const color = container.querySelector<HTMLSelectElement>(
      '[data-testid="setup-primary-color"]'
    );
    act(() => {
      if (!appearance) return;
      appearance.value = "light";
      appearance.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(mocks.handleAppearanceModeChange).toHaveBeenCalledWith("light");

    act(() => {
      if (!color) return;
      color.value = "orange";
      color.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(mocks.setPrimaryColorPreset).toHaveBeenCalledWith("orange");

    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="setup-finish"]')
        ?.click();
    });
    expect(onComplete).toHaveBeenCalledOnce();
    expect(
      container.querySelector('[data-testid="setup-presentation"]')
    ).toBeNull();
    expect(container.querySelector('[data-testid="setup-theme"]')).toBeNull();
  });
});
