// @vitest-environment jsdom
import { Provider, createStore } from "jotai";
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

import { devModeEnabledAtom } from "@src/store/platform/devModeAtom";

import SidebarSettingsMenuButton from "./SidebarSettingsMenuButton";

const mocks = vi.hoisted(() => ({
  closeDropdown: vi.fn(),
  goToSettings: vi.fn(),
  navigateTo: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@src/hooks/navigation", () => ({
  useAppNavigation: () => ({
    goToSettings: mocks.goToSettings,
    navigateTo: mocks.navigateTo,
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
  ToolbarTooltip: ({ children }: { children: React.ReactNode }) => children,
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe("SidebarSettingsMenuButton", () => {
  let container: HTMLDivElement;
  let root: Root;
  let store: ReturnType<typeof createStore>;

  beforeAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(async () => {
    vi.stubEnv("NODE_ENV", "development");
    store = createStore();
    store.set(devModeEnabledAtom, true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root.render(
        React.createElement(
          Provider,
          { store },
          React.createElement(SidebarSettingsMenuButton)
        )
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
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

  it("reopens the setup checklist through shared app navigation", () => {
    const setupButton = Array.from(
      document.body.querySelectorAll("button")
    ).find(
      (button) => button.textContent === "sidebar.settingsMenu.setupChecklist"
    );

    expect(setupButton).toBeDefined();
    act(() => setupButton?.click());

    expect(mocks.navigateTo).toHaveBeenCalledWith("/orgii/app/walkthrough");
    expect(mocks.closeDropdown).toHaveBeenCalled();
  });

  it("moves the onboarding test panel into the Dev Mode menu list", () => {
    expect(
      document.querySelector('[data-testid="developer-test-panel-trigger"]')
    ).toBeNull();

    const developerTestsButton = document.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-open-developer-test-panel"]'
    );
    expect(developerTestsButton).not.toBeNull();

    act(() => developerTestsButton?.click());

    expect(mocks.closeDropdown).toHaveBeenCalled();
    expect(
      document.querySelector('[data-testid="developer-test-panel"]')
    ).not.toBeNull();
  });

  it("hides the onboarding test panel entry when Dev Mode is off", async () => {
    await act(async () => {
      store.set(devModeEnabledAtom, false);
    });

    expect(
      document.querySelector(
        '[data-testid="sidebar-open-developer-test-panel"]'
      )
    ).toBeNull();
  });
});
