// @vitest-environment jsdom
import { Provider } from "jotai";
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
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

import { ROUTES } from "@src/config/routes";
import {
  getPinnedWorkbenchChromeReservedRight,
  isPinnedWorkbenchChromePath,
  resolvePinnedWorkbenchChromeSlots,
} from "@src/hooks/ui/workbench/usePinnedWorkbenchChrome";
import {
  activeStationChatVisibleAtom,
  chatPanelMaximizedAtom,
  chatWidthAtom,
} from "@src/store/ui/chatPanelAtom";
import {
  createInstrumentedStore,
  resetInstrumentedStore,
} from "@src/util/core/state/instrumentedStore";

import { PinnedWorkbenchChrome } from "./PinnedWorkbenchChrome";

const { isMacOSMock } = vi.hoisted(() => ({ isMacOSMock: vi.fn() }));

vi.mock("@src/util/platform/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@src/util/platform/tauri")>()),
  isMacOS: isMacOSMock,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@src/services/workStation/WorkStationViewService", () => ({
  WorkStationViewService: { showWorkStation: vi.fn(async () => true) },
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe("PinnedWorkbenchChrome", () => {
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

  function render(pathname = ROUTES.workStation.base.path): void {
    act(() => {
      root.render(
        createElement(
          Provider,
          { store },
          createElement(
            MemoryRouter,
            { initialEntries: [pathname] },
            createElement(PinnedWorkbenchChrome)
          )
        )
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

  it("renders nothing off macOS or on the Settings route", () => {
    isMacOSMock.mockReturnValue(false);
    render();
    expect(query("pinned-workbench-chrome")).toBeNull();

    isMacOSMock.mockReturnValue(true);
    render(ROUTES.app.settings.path);
    expect(query("pinned-workbench-chrome")).toBeNull();
    expect(isPinnedWorkbenchChromePath(ROUTES.app.settings.path)).toBe(false);
    expect(isPinnedWorkbenchChromePath(ROUTES.workStation.base.path)).toBe(
      true
    );
  });

  it("pins hide-chat and maximize-chat at the window's right edge, 1px apart", () => {
    render();
    act(() => {
      store.set(activeStationChatVisibleAtom, "my-station", true);
      store.set(chatWidthAtom, 360);
      store.set(chatPanelMaximizedAtom, false);
    });

    const group = query("pinned-workbench-chrome");
    expect(group?.style.right).toBe("8px");
    expect(group?.style.top).toBe("26px");
    expect(group?.className).toContain("gap-px");
    expect(query("pinned-workbench-chrome-chat-visibility")).not.toBeNull();
    expect(query("pinned-workbench-chrome-maximize-chat")).not.toBeNull();

    click("pinned-workbench-chrome-maximize-chat");
    expect(store.get(chatPanelMaximizedAtom)).toBe(true);
    expect(query("pinned-workbench-chrome-show-workstation")).not.toBeNull();
    expect(group?.style.right).toBe("8px");
    // Maximized: the hide-chat slot is gone outright, no spacer left behind.
    expect(query("pinned-workbench-chrome-chat-visibility")).toBeNull();
    expect(group?.childElementCount).toBe(1);
  });

  it("draws only the restore toggle, flush right, while the chat is hidden", () => {
    render();
    act(() => {
      store.set(activeStationChatVisibleAtom, "my-station", false);
      store.set(chatPanelMaximizedAtom, false);
    });

    expect(query("pinned-workbench-chrome-chat-visibility")).not.toBeNull();
    expect(query("pinned-workbench-chrome-maximize-chat")).toBeNull();
    expect(query("pinned-workbench-chrome")?.childElementCount).toBe(1);
  });

  it("reserves inset, the visible slots, and gaps for hosts", () => {
    expect(getPinnedWorkbenchChromeReservedRight(2)).toBe(8 + 28 + 1 + 28 + 1);
    expect(getPinnedWorkbenchChromeReservedRight(1)).toBe(8 + 28 + 1);
    expect(
      resolvePinnedWorkbenchChromeSlots({
        chatVisible: true,
        chatPanelMaximized: false,
      })
    ).toBe(2);
    expect(
      resolvePinnedWorkbenchChromeSlots({
        chatVisible: true,
        chatPanelMaximized: true,
      })
    ).toBe(1);
    expect(
      resolvePinnedWorkbenchChromeSlots({
        chatVisible: false,
        chatPanelMaximized: false,
      })
    ).toBe(1);
  });
});
