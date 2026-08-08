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

import { org2CloudOrgsAtom } from "@src/features/Org2Cloud/org2CloudOrgsAtom";
import {
  SETUP_GUIDE_DEV_SCENARIO,
  setupGuideDevScenarioAtom,
} from "@src/store/ui/setupGuideDevScenarioAtom";

import { DeveloperTestPanel, isDeveloperTestPanelEnabled } from ".";
import { DEVELOPER_TEST_MODULES } from "./moduleRegistry";

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe("DeveloperTestPanel", () => {
  let container: HTMLDivElement;
  let root: Root;
  let store: ReturnType<typeof createStore>;

  const renderPanel = async () => {
    await act(async () => {
      root.render(
        React.createElement(
          Provider,
          { store },
          React.createElement(DeveloperTestPanel, {
            panelRef: { current: null },
            panelPosition: {
              top: 32,
              left: 8,
              width: 320,
              maxHeight: 480,
            },
            onClose: mocks.close,
          })
        )
      );
    });
  };

  beforeAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "development");
    store = createStore();
    store.set(setupGuideDevScenarioAtom, SETUP_GUIDE_DEV_SCENARIO.LIVE);
    store.set(org2CloudOrgsAtom, []);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
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

  it("registers onboarding as an independent test module", async () => {
    await renderPanel();

    expect(DEVELOPER_TEST_MODULES.map((module) => module.id)).toEqual([
      "onboarding",
    ]);
    const panel = document.querySelector(
      '[data-testid="developer-test-panel"]'
    );
    expect(panel).not.toBeNull();
    expect(document.activeElement).toBe(panel);
    expect(document.body.textContent).toContain(
      "sidebar.developerTestPanel.title"
    );
    expect(
      document.querySelector('[data-testid="developer-test-onboarding-module"]')
    ).not.toBeNull();
  });

  it("changes onboarding scenarios without closing the independent panel", async () => {
    await renderPanel();

    act(() =>
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="developer-test-onboarding-no_organization"]'
        )
        ?.click()
    );

    expect(store.get(setupGuideDevScenarioAtom)).toBe(
      SETUP_GUIDE_DEV_SCENARIO.NO_ORGANIZATION
    );
    expect(mocks.close).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("DEV");
  });

  it("delegates its close action to the Settings menu owner", async () => {
    await renderPanel();

    const closeButton = Array.from(
      document.body.querySelectorAll("button")
    ).find(
      (button) => button.getAttribute("aria-label") === "sidebar.guide.close"
    );

    expect(closeButton).toBeDefined();
    act(() => closeButton?.click());
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("requires a real cloud organization for role scenarios", async () => {
    await renderPanel();

    for (const scenario of ["member", "admin", "owner"]) {
      expect(
        document.querySelector<HTMLButtonElement>(
          `[data-testid="developer-test-onboarding-${scenario}"]`
        )?.disabled
      ).toBe(true);
    }

    await act(async () => {
      store.set(org2CloudOrgsAtom, [
        { orgId: "org-a", name: "ORG A", role: "member" },
      ]);
    });

    for (const scenario of ["member", "admin", "owner"]) {
      expect(
        document.querySelector<HTMLButtonElement>(
          `[data-testid="developer-test-onboarding-${scenario}"]`
        )?.disabled
      ).toBe(false);
    }
  });

  it("does not mount the panel outside development", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await renderPanel();

    expect(isDeveloperTestPanelEnabled()).toBe(false);
    expect(
      document.querySelector('[data-testid="developer-test-panel"]')
    ).toBeNull();
  });
});
