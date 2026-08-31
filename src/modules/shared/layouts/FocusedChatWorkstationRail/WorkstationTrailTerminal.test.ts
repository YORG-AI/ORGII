// @vitest-environment jsdom
import i18next from "i18next";
import { Provider, createStore } from "jotai";
import React, { act, useEffect } from "react";
import { type Root, createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TerminalCoreProps } from "@src/engines/TerminalCore";
import common from "@src/i18n/locales/en/common.json";
import navigation from "@src/i18n/locales/en/navigation.json";
import {
  miniTerminalActiveIdAtom,
  miniTerminalClaimedIdsAtom,
  miniTerminalCollapsedAtom,
  miniTerminalHostMountedAtom,
  miniTerminalVisibleAtom,
  openMiniTerminalAtom,
} from "@src/store/ui/miniTerminalAtom";
import { terminalSessionsAtom } from "@src/store/workstation/codeEditor/terminal";
import * as tauri from "@src/util/platform/tauri/init";
import * as creationThrottle from "@src/util/ui/terminal/creationThrottle";
import { toBackendPtySessionId } from "@src/util/ui/terminal/ptySessionId";

import { WorkstationTrailTerminal } from "./WorkstationTrailTerminal";

const lifecycle = vi.hoisted(() => ({ mount: vi.fn(), unmount: vi.fn() }));
vi.mock("@src/engines/TerminalCore", () => ({
  default: function TerminalProbe({
    visible,
    fontSize,
    terminalState,
  }: TerminalCoreProps) {
    useEffect(() => {
      lifecycle.mount();
      return () => lifecycle.unmount();
    }, []);
    return React.createElement(
      "output",
      {
        "aria-label": "Terminal runtime",
        "data-visible": visible,
        "data-font-size": fontSize,
      },
      terminalState?.activeSessionId
    );
  },
}));

const i18n = i18next.createInstance();
await i18n.init({
  lng: "en",
  fallbackLng: "en",
  resources: { en: { common, navigation } },
  interpolation: { escapeValue: false },
});

describe("docked terminal controls", () => {
  let root: Root;
  let container: HTMLDivElement;
  let store: ReturnType<typeof createStore>;
  const props = {
    width: 570,
    height: 350,
    onResize: vi.fn(),
    onResizeEnd: vi.fn(),
    onResizingChange: vi.fn(),
  };

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    store = createStore();
    store.set(miniTerminalHostMountedAtom, true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    lifecycle.mount.mockClear();
    lifecycle.unmount.mockClear();
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    localStorage.clear();
    Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  });

  async function mount(count: number) {
    const sessions = Array.from({ length: count }, (_, index) => ({
      id: `shell-${index + 1}`,
      name: `Shell ${index + 1}`,
      isActive: false,
    }));
    store.set(terminalSessionsAtom, sessions);
    sessions.forEach(({ id }) => store.set(openMiniTerminalAtom, id));
    await act(async () => {
      root.render(
        React.createElement(
          Provider,
          { store },
          React.createElement(
            I18nextProvider,
            { i18n },
            React.createElement(WorkstationTrailTerminal, props)
          )
        )
      );
    });
  }
  async function clickLabel(label: string) {
    const button = [
      ...container.querySelectorAll<HTMLButtonElement>("button"),
    ].find((node) => node.getAttribute("aria-label") === label);
    expect(button).toBeDefined();
    await act(async () => button!.click());
  }
  function tabs() {
    return [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  }

  it("uses the single terminal name as the header without a duplicate tab", async () => {
    await mount(1);
    const header = container.querySelector("aside")!.firstElementChild!;
    expect(header.textContent).toBe("Shell 1");
    expect(tabs()).toHaveLength(0);
    expect(header.querySelector('[role="tablist"]')).toBeNull();
    expect(header.querySelector('[data-icon="chevron-down"]')).not.toBeNull();
    expect(header.querySelector('[data-icon="stop"]')).not.toBeNull();
    expect(
      container
        .querySelector('[aria-label="Terminal runtime"]')
        ?.getAttribute("data-font-size")
    ).toBe("12");
    const labelId = container
      .querySelector('[role="tabpanel"]')!
      .getAttribute("aria-labelledby")!;
    expect(document.getElementById(labelId)?.textContent).toBe("Shell 1");
    await clickLabel("Collapse");
    expect(header.textContent).toBe("Shell 1");
    expect(header.querySelector('[data-icon="chevron-right"]')).not.toBeNull();
  });

  it("shows all three tabs without an add button or overflow menu", async () => {
    await mount(3);
    const header = container.querySelector("aside")!.firstElementChild!;
    expect(header.textContent).not.toContain("Terminals");
    expect(header.querySelector('[data-icon="chevron-down"]')).not.toBeNull();
    expect(tabs().map((tab) => tab.textContent)).toEqual([
      "Shell 1",
      "Shell 2",
      "Shell 3",
    ]);
    expect(container.querySelector('[data-icon="plus"]')).toBeNull();
    expect(container.querySelector("[aria-haspopup]")).toBeNull();
    for (const button of header.querySelectorAll("button")) {
      expect(button.classList.contains("h-5")).toBe(true);
      if (button.getAttribute("role") !== "tab")
        expect(button.classList.contains("w-5")).toBe(true);
    }
    expect(
      header.querySelector('[role="tablist"]')!.classList.contains("gap-px")
    ).toBe(true);
    expect(
      container
        .querySelector('[role="tabpanel"]')!
        .getAttribute("aria-labelledby")
    ).toBe(tabs()[2].id);
    expect(tabs()[2].getAttribute("aria-controls")).toBe(
      container.querySelector('[role="tabpanel"]')!.id
    );
    expect(
      container.querySelector('[role="tablist"]')!.textContent
    ).not.toContain("+");
    await clickLabel("Collapse");
    expect(container.querySelector('[data-icon="plus"]')).toBeNull();
  });

  it("hides add at three, rejects a repeated click, and restores add after stopping", async () => {
    await mount(2);
    const create = vi
      .spyOn(creationThrottle, "tryBeginTerminalCreation")
      .mockReturnValue(true);
    const add = container.querySelector<HTMLButtonElement>(
      '[aria-label="New mini terminal"]'
    )!;
    expect(add).not.toBeNull();
    await act(async () => {
      add.click();
      add.click();
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(store.get(terminalSessionsAtom)).toHaveLength(3);
    expect(tabs()).toHaveLength(3);
    expect(container.querySelector('[data-icon="plus"]')).toBeNull();
    await clickLabel(common.tooltips.killTerminal);
    expect(tabs()).toHaveLength(2);
    expect(container.querySelector('[data-icon="plus"]')).not.toBeNull();
  });

  it.each([1, 2])(
    "scrolls the tab strip in both directions at %sx scale",
    async (scale) => {
      await mount(3);
      const list = container.querySelector<HTMLElement>('[role="tablist"]')!;
      vi.spyOn(list, "getBoundingClientRect").mockReturnValue(
        new DOMRect(100, 0, 120 * scale, 24 * scale)
      );
      Object.defineProperty(list, "offsetWidth", {
        configurable: true,
        value: 120,
      });
      tabs().forEach((tab, index) => {
        vi.spyOn(tab, "getBoundingClientRect").mockImplementation(
          () =>
            new DOMRect(
              100 + (index * 100 - list.scrollLeft) * scale,
              0,
              100 * scale,
              24 * scale
            )
        );
      });
      container.scrollLeft = 12;
      await act(async () =>
        tabs()[2].dispatchEvent(
          new KeyboardEvent("keydown", { key: "Home", bubbles: true })
        )
      );
      await act(async () =>
        tabs()[0].dispatchEvent(
          new KeyboardEvent("keydown", { key: "End", bubbles: true })
        )
      );
      expect(list.scrollLeft).toBe(180);
      expect(document.activeElement).toBe(tabs()[2]);
      await act(async () =>
        tabs()[2].dispatchEvent(
          new KeyboardEvent("keydown", { key: "Home", bubbles: true })
        )
      );
      expect(list.scrollLeft).toBe(0);
      expect(document.activeElement).toBe(tabs()[0]);
      expect(container.scrollLeft).toBe(12);
    }
  );

  it("switches visible tabs with keyboard focus", async () => {
    await mount(3);
    await act(async () =>
      tabs()[2].dispatchEvent(
        new KeyboardEvent("keydown", { key: "Home", bubbles: true })
      )
    );
    expect(store.get(miniTerminalActiveIdAtom)).toBe("shell-1");
    expect(document.activeElement).toBe(tabs()[0]);
    await act(async () =>
      tabs()[0].dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })
      )
    );
    expect(store.get(miniTerminalActiveIdAtom)).toBe("shell-2");
    expect(tabs()[1].getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tabs()[1]);
  });

  it("folds to a centered process count without unmounting the terminal, then restores its size", async () => {
    await mount(3);
    const surface = container.querySelector("aside")!;
    expect(surface.style.width).toBe("570px");
    expect(surface.style.height).toBe("350px");
    await clickLabel("Collapse");
    expect(store.get(miniTerminalCollapsedAtom)).toBe(true);
    expect(tabs()).toHaveLength(0);
    expect(surface.firstElementChild!.textContent).toBe("3 processes");
    expect(surface.firstElementChild!.classList.contains("mb-1")).toBe(false);
    expect(surface.style.width).toBe("");
    expect(surface.style.height).toBe("");
    expect(
      container.querySelector('[aria-label="Resize terminal"]')
    ).toBeNull();
    expect(
      container.querySelector("output")!.getAttribute("data-visible")
    ).toBe("false");
    expect(lifecycle.mount).toHaveBeenCalledTimes(1);
    expect(lifecycle.unmount).not.toHaveBeenCalled();
    await clickLabel("Expand");
    expect(surface.style.width).toBe("570px");
    expect(surface.style.height).toBe("350px");
    expect(
      container.querySelector('[aria-label="Resize terminal"]')
    ).not.toBeNull();
    expect(lifecycle.mount).toHaveBeenCalledTimes(1);
  });

  it("stops only the selected PTY through the existing terminal writer", async () => {
    await mount(3);
    vi.spyOn(tauri, "isTauriReady").mockReturnValue(true);
    const invoke = vi.spyOn(tauri, "invokeTauri").mockResolvedValue(undefined);
    await clickLabel(common.tooltips.killTerminal);
    expect(invoke).toHaveBeenCalledWith("close_pty", {
      sessionId: toBackendPtySessionId("shell-3"),
    });
    expect(store.get(terminalSessionsAtom).map(({ id }) => id)).toEqual([
      "shell-1",
      "shell-2",
    ]);
    expect(store.get(miniTerminalClaimedIdsAtom)).toEqual([
      "shell-1",
      "shell-2",
    ]);
    expect(store.get(miniTerminalActiveIdAtom)).toBe("shell-1");
  });

  it("returns to a single named header when only one terminal remains", async () => {
    await mount(2);
    await clickLabel(common.tooltips.killTerminal);
    const header = container.querySelector("aside")!.firstElementChild!;
    expect(header.textContent).toBe("Shell 1");
    expect(tabs()).toHaveLength(0);
    const labelId = container
      .querySelector('[role="tabpanel"]')!
      .getAttribute("aria-labelledby")!;
    expect(document.getElementById(labelId)?.textContent).toBe("Shell 1");
  });

  it("hides the dock without stopping sessions", async () => {
    await mount(3);
    const invoke = vi.spyOn(tauri, "invokeTauri").mockResolvedValue(undefined);
    await clickLabel("Hide mini terminal");
    expect(store.get(miniTerminalVisibleAtom)).toBe(false);
    expect(store.get(miniTerminalClaimedIdsAtom)).toEqual([]);
    expect(store.get(terminalSessionsAtom)).toHaveLength(3);
    expect(invoke).not.toHaveBeenCalled();
  });
});
