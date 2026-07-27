// @vitest-environment jsdom
import { Provider } from "jotai";
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

import SidebarSettingsMenuButton from "./SidebarSettingsMenuButton";

const mocks = vi.hoisted(() => ({
  closeDropdown: vi.fn(),
  goToSettings: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@src/hooks/navigation", () => ({
  useAppNavigation: () => ({
    goToSettings: mocks.goToSettings,
  }),
}));

vi.mock("@src/hooks/dropdown", () => ({
  useDropdownEngine: () => ({
    isOpen: true,
    isPositioned: true,
    toggle: vi.fn(),
    close: mocks.closeDropdown,
    triggerRef: { current: null },
    panelRef: { current: null },
    panelPosition: { top: 0, left: 0, width: 220 },
  }),
}));

vi.mock("@src/modules/MainApp/Settings/sections/useAppearanceState", () => ({
  useAppearanceState: () => ({
    appearanceMode: "system",
    appearanceModeOptions: [],
    globalThemeId: "system",
    themeOptions: [],
    handleAppearanceModeChange: vi.fn(),
    handleThemeChange: vi.fn(),
  }),
}));

vi.mock("@src/modules/WorkStation/shared", () => ({
  WorkstationToolbarTooltip: ({ children }: { children: React.ReactNode }) =>
    children,
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe("SidebarSettingsMenuButton", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root.render(
        React.createElement(
          Provider,
          null,
          React.createElement(SidebarSettingsMenuButton)
        )
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  afterAll(() => {
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("keeps the Changelog placeholder hidden while Tutorials remains available", () => {
    const buttons = Array.from(document.body.querySelectorAll("button"));
    const changelogButton = buttons.find(
      (button) => button.textContent === "routes.changelog"
    );
    const tutorialButton = buttons.find(
      (button) => button.textContent === "sidebar.settingsMenu.tutorials"
    );

    expect(changelogButton).toBeUndefined();
    expect(tutorialButton).toBeDefined();
  });
});
