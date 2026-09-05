// @vitest-environment jsdom
import { Provider } from "jotai";
import { act, createElement } from "react";
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

import { hoverSidebarOpenAtom } from "@src/store/ui/hoverSidebarAtom";
import { sidebarCollapsedAtom } from "@src/store/ui/sidebarAtom";
import {
  createInstrumentedStore,
  resetInstrumentedStore,
} from "@src/util/core/state/instrumentedStore";

import { PinnedSidebarChrome } from "./PinnedSidebarChrome";

const { isMacOSMock } = vi.hoisted(() => ({ isMacOSMock: vi.fn() }));

vi.mock("@src/util/platform/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@src/util/platform/tauri")>()),
  isMacOS: isMacOSMock,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe("PinnedSidebarChrome", () => {
  let container: HTMLDivElement;
  let root: Root;
  let store: ReturnType<typeof createInstrumentedStore>;

  beforeAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    isMacOSMock.mockReturnValue(true);
    resetInstrumentedStore();
    localStorage.clear();
    store = createInstrumentedStore();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    resetInstrumentedStore();
    isMacOSMock.mockReset();
  });

  afterAll(() => {
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  function render(): void {
    act(() => {
      root.render(
        createElement(Provider, { store }, createElement(PinnedSidebarChrome))
      );
    });
  }

  function query(testId: string): HTMLElement | null {
    return container.querySelector(`[data-testid="${testId}"]`);
  }

  function click(testId: string): void {
    const element = query(testId);
    if (!(element instanceof HTMLElement)) {
      throw new Error(`${testId} did not render`);
    }
    act(() => element.click());
  }

  it("renders nothing off macOS", () => {
    isMacOSMock.mockReturnValue(false);
    render();
    expect(query("pinned-sidebar-chrome")).toBeNull();
  });

  it("pins the arrows and the hide toggle at the traffic-light offset", () => {
    act(() => store.set(sidebarCollapsedAtom, false));
    render();

    const group = query("pinned-sidebar-chrome");
    expect(group).not.toBeNull();
    expect(group?.style.left).toBe("88px");
    expect(group?.style.top).toBe("26px");
    expect(query("session-history-nav")).not.toBeNull();
    expect(query("pinned-sidebar-chrome-hide")).not.toBeNull();

    click("pinned-sidebar-chrome-hide");
    expect(store.get(sidebarCollapsedAtom)).toBe(true);
    expect(query("pinned-sidebar-chrome-show")).not.toBeNull();
    expect(group?.style.left).toBe("88px");
  });

  it("offers expand and close while the hover sidebar is open", () => {
    act(() => {
      store.set(sidebarCollapsedAtom, true);
      store.set(hoverSidebarOpenAtom, true);
    });
    render();

    expect(query("pinned-sidebar-chrome-expand")).not.toBeNull();
    click("pinned-sidebar-chrome-close-hover");
    expect(store.get(hoverSidebarOpenAtom)).toBe(false);
    expect(store.get(sidebarCollapsedAtom)).toBe(true);

    act(() => store.set(hoverSidebarOpenAtom, true));
    click("pinned-sidebar-chrome-expand");
    expect(store.get(hoverSidebarOpenAtom)).toBe(false);
    expect(store.get(sidebarCollapsedAtom)).toBe(false);
  });
});
