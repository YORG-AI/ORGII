// @vitest-environment jsdom
import { Provider, createStore } from "jotai";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildSettingsPath } from "@src/config/mainAppPaths";
import { workstationActiveSessionIdAtom } from "@src/store/session/viewAtom";
import {
  openWorkstationTabAtom,
  workstationTabsStateAtom,
} from "@src/store/workstation/tabs/atoms";
import { createFileTab } from "@src/store/workstation/tabs/factories";
import { emptyWorkstationTabsState } from "@src/store/workstation/tabs/storage";

import { useAppShellActions } from "./useAppShellActions";

vi.mock("@src/router/lazy/preload", () => ({ preloadRouteByPath: vi.fn() }));
vi.mock("@src/scaffold/GlobalSpotlight/openSpotlight", () => ({
  openWorkspaceSpotlight: vi.fn(),
}));

function ActionProbe() {
  const { handleOpenSettings } = useAppShellActions();
  const location = useLocation();
  const navigate = useNavigate();
  return createElement(
    "div",
    { "data-route": location.pathname },
    createElement("button", { onClick: handleOpenSettings }, "More settings"),
    createElement("button", { onClick: () => navigate(-1) }, "Back")
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useAppShellActions", () => {
  it("opens app editor appearance settings without creating a workstation tab", () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const store = createStore();
    store.set(workstationTabsStateAtom, emptyWorkstationTabsState());
    store.set(workstationActiveSessionIdAtom, "session-A");
    store.set(openWorkstationTabAtom, {
      workspace: { kind: "session", sessionId: "session-A" },
      tab: createFileTab("/repo/current.ts"),
    });
    const tabsBefore = store.get(workstationTabsStateAtom);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    try {
      act(() =>
        root.render(
          createElement(
            Provider,
            { store },
            createElement(
              MemoryRouter,
              { initialEntries: ["/workstation/code"] },
              createElement(ActionProbe)
            )
          )
        )
      );
      act(() =>
        container.querySelectorAll<HTMLButtonElement>("button")[0].click()
      );

      expect(
        container.querySelector("[data-route]")?.getAttribute("data-route")
      ).toBe(buildSettingsPath({ section: "appearance", tab: "code-editor" }));
      expect(store.get(workstationTabsStateAtom)).toBe(tabsBefore);
      expect(store.get(workstationActiveSessionIdAtom)).toBe("session-A");

      act(() =>
        container.querySelectorAll<HTMLButtonElement>("button")[1].click()
      );
      expect(
        container.querySelector("[data-route]")?.getAttribute("data-route")
      ).toBe("/workstation/code");
      expect(store.get(workstationTabsStateAtom)).toBe(tabsBefore);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});
