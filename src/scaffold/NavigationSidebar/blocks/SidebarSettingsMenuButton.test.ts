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

import { DROPDOWN_PANEL } from "@src/components/Dropdown/tokens";
import {
  ORG2_CLOUD_AUTH_STORAGE_KEY,
  org2CloudAuthAtom,
} from "@src/features/Org2Cloud/org2CloudAuthAtom";
import * as entitlementCoordinator from "@src/features/Org2Cloud/org2CloudEntitlementCoordinator";
import { devModeEnabledAtom } from "@src/store/platform/devModeAtom";

import SidebarSettingsMenuButton from "./SidebarSettingsMenuButton";

const mocks = vi.hoisted(() => ({
  closeDropdown: vi.fn(),
  goToSettings: vi.fn(),
  navigateTo: vi.fn(),
}));

function createRect({
  top,
  left,
  width,
  height,
}: {
  top: number;
  left: number;
  width: number;
  height: number;
}): DOMRect {
  return {
    top,
    right: left + width,
    bottom: top + height,
    left,
    width,
    height,
    x: left,
    y: top,
    toJSON: () => ({}),
  };
}

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
    panelPosition: { bottom: 0, left: 0, width: 220 },
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
    store = createStore();
    store.set(org2CloudAuthAtom, null);
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
    vi.restoreAllMocks();
  });

  afterAll(() => {
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("omits ADE Manager, Tutorials, and the Changelog placeholder", () => {
    const buttons = Array.from(document.body.querySelectorAll("button"));
    const changelogButton = buttons.find(
      (button) => button.textContent === "routes.changelog"
    );
    const tutorialButton = buttons.find(
      (button) => button.textContent === "sidebar.settingsMenu.tutorials"
    );
    const adeManagerButton = buttons.find(
      (button) => button.textContent === "common:adeManager.menuToggle"
    );

    expect(changelogButton).toBeUndefined();
    expect(tutorialButton).toBeUndefined();
    expect(adeManagerButton).toBeUndefined();
  });

  it("does not expose the retired setup walkthrough", () => {
    const setupButton = Array.from(
      document.body.querySelectorAll("button")
    ).find(
      (button) => button.textContent === "sidebar.settingsMenu.setupChecklist"
    );

    expect(setupButton).toBeUndefined();
  });

  it("puts login last in the signed-out account menu", async () => {
    const onSignIn = vi.fn();

    await act(async () => {
      root.render(
        React.createElement(
          Provider,
          { store },
          React.createElement(SidebarSettingsMenuButton, {
            onSignIn,
            renderTrigger: ({ isOpen, onClick }) =>
              React.createElement(
                "button",
                {
                  type: "button",
                  onClick,
                  "aria-expanded": isOpen,
                  "data-testid": "account-menu-trigger",
                },
                "Account"
              ),
          })
        )
      );
    });

    const trigger = document.querySelector<HTMLButtonElement>(
      '[data-testid="account-menu-trigger"]'
    );
    expect(trigger?.getAttribute("aria-expanded")).toBe("true");

    const signIn = document.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-menu-sign-in"]'
    );
    expect(signIn?.textContent).toBe("cloud.signIn");
    expect(
      Array.from(signIn!.parentElement!.querySelectorAll("button")).at(-1)
    ).toBe(signIn);
    expect(
      document.querySelector('[data-testid="sidebar-menu-sign-out"]')
    ).toBeNull();

    act(() => signIn?.click());
    expect(mocks.closeDropdown).toHaveBeenCalledOnce();
    expect(onSignIn).toHaveBeenCalledOnce();
  });

  it("puts logout first and clears the persisted account before showing login", async () => {
    const onSignIn = vi.fn();
    const resetEntitlements = vi.spyOn(
      entitlementCoordinator,
      "resetOrgEntitlementCoordinator"
    );

    await act(async () => {
      store.set(org2CloudAuthAtom, {
        kind: "org2_cloud",
        supabaseUrl: "https://cloud.example.test",
        supabaseAnonKey: "test-anon-key",
        userId: "user-1",
        accessToken: "test-access-token",
        refreshToken: "test-refresh-token",
        expiresAt: 2_000_000_000,
      });
      root.render(
        React.createElement(
          Provider,
          { store },
          React.createElement(SidebarSettingsMenuButton, { onSignIn })
        )
      );
    });

    const signOut = document.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-menu-sign-out"]'
    );
    expect(signOut?.textContent).toBe("cloud.signOut");
    expect(signOut!.parentElement!.querySelector("button")).toBe(signOut);
    expect(
      document.querySelector('[data-testid="sidebar-menu-sign-in"]')
    ).toBeNull();

    await act(async () => signOut!.click());

    expect(mocks.closeDropdown).toHaveBeenCalledOnce();
    expect(resetEntitlements).toHaveBeenCalledOnce();
    expect(resetEntitlements).toHaveBeenCalledWith(store);
    expect(store.get(org2CloudAuthAtom)).toBeNull();
    expect(localStorage.getItem(ORG2_CLOUD_AUTH_STORAGE_KEY)).toBe("null");
    expect(
      document.querySelector('[data-testid="sidebar-menu-sign-out"]')
    ).toBeNull();
    const signIn = document.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-menu-sign-in"]'
    );
    expect(signIn).not.toBeNull();
    expect(
      Array.from(signIn!.parentElement!.querySelectorAll("button")).at(-1)
    ).toBe(signIn);
    expect(onSignIn).not.toHaveBeenCalled();
  });

  it("does not expose onboarding development simulations", () => {
    expect(
      document.querySelector(
        '[data-testid="sidebar-open-developer-test-panel"]'
      )
    ).toBeNull();
  });

  it("consolidates chat panel and workstation controls under Layout", async () => {
    const layoutTrigger = document.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-settings-layout"]'
    );

    expect(layoutTrigger?.textContent).toBe("general.layout");
    expect(
      document.querySelectorAll('[data-testid="sidebar-settings-layout"]')
    ).toHaveLength(1);

    await act(async () => {
      layoutTrigger?.dispatchEvent(
        new MouseEvent("mouseover", { bubbles: true })
      );
    });

    const submenuText = Array.from(
      document.body.querySelectorAll<HTMLDivElement>("div.fixed")
    )
      .map((panel) => panel.textContent)
      .join(" ");

    expect(submenuText).toContain("layoutSettings.chatPanelLocation");
    expect(submenuText).toContain("layoutSettings.sidebarPosition");
    expect(submenuText).toContain("layoutSettings.modelPickerStyle");
    expect(submenuText).toContain("layoutSettings.paginateChatHistory");

    const segmentedControls = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="group"]')
    );
    expect(segmentedControls).toHaveLength(3);
    expect(
      segmentedControls.every((control) => control.classList.contains("h-6"))
    ).toBe(true);
    expect(
      segmentedControls.map((control) => control.getAttribute("aria-label"))
    ).toEqual([
      "layoutSettings.chatPanelLocation",
      "layoutSettings.sidebarPosition",
      "layoutSettings.modelPickerStyle",
    ]);
    expect(
      document.body.querySelector('[role="switch"]')?.getAttribute("aria-label")
    ).toBe("layoutSettings.paginateChatHistory");
  });

  it("aligns vertically to the row but measures the gap from the outer panel", async () => {
    const presenceTrigger = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>("button")
    ).find((button) => button.textContent === "myRoles.tabs.presence");
    expect(presenceTrigger).toBeDefined();
    const parentPanel = presenceTrigger?.closest<HTMLDivElement>("div.fixed");
    expect(parentPanel).toBeDefined();

    vi.spyOn(presenceTrigger!, "getBoundingClientRect").mockReturnValue(
      createRect({
        top: 280,
        left: 25,
        width: 370,
        height: 32,
      })
    );
    vi.spyOn(parentPanel!, "getBoundingClientRect").mockReturnValue(
      createRect({
        top: 40,
        left: 20,
        width: 380,
        height: 660,
      })
    );

    await act(async () => {
      presenceTrigger!.dispatchEvent(
        new MouseEvent("mouseover", { bubbles: true })
      );
    });

    const onlineOption = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>("button")
    ).find((button) => button.textContent === "sidebar.presence.online");
    const submenu = onlineOption?.parentElement?.parentElement;

    expect(submenu?.style.top).toBe("276px");
    expect(submenu?.style.bottom).toBe("");
    expect(submenu?.style.left).toBe(`${400 + DROPDOWN_PANEL.submenuGap}px`);
  });

  it("bottom-aligns a tall upward submenu with its parent menu", async () => {
    const appearanceTrigger = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>("button")
    ).find(
      (button) => button.textContent === "sidebar.settingsMenu.appearance"
    );
    expect(appearanceTrigger).toBeDefined();
    const parentPanel = appearanceTrigger?.closest<HTMLDivElement>("div.fixed");
    expect(parentPanel).toBeDefined();

    const nativeGetBoundingClientRect =
      HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        if (this === appearanceTrigger) {
          return createRect({
            top: 400,
            left: 25,
            width: 370,
            height: 32,
          });
        }
        if (this === parentPanel) {
          return createRect({
            top: 80,
            left: 20,
            width: 380,
            height: 520,
          });
        }
        if (
          this instanceof HTMLDivElement &&
          this.classList.contains("fixed")
        ) {
          return createRect({
            top: 0,
            left: 400 + DROPDOWN_PANEL.submenuGap,
            width: 220,
            height: 300,
          });
        }
        return nativeGetBoundingClientRect.call(this);
      }
    );

    await act(async () => {
      appearanceTrigger!.dispatchEvent(
        new MouseEvent("mouseover", { bubbles: true })
      );
    });

    const submenu = Array.from(
      document.body.querySelectorAll<HTMLDivElement>("div.fixed")
    ).find((panel) => panel !== parentPanel);

    expect(submenu?.style.top).toBe("300px");
    expect(submenu?.style.left).toBe(`${400 + DROPDOWN_PANEL.submenuGap}px`);
    expect(Number.parseFloat(submenu!.style.top) + 300).toBe(600);
  });
});
