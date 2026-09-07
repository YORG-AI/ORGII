// @vitest-environment jsdom
import { Provider, createStore } from "jotai";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";
import type { Session } from "@src/store/session";

import {
  sidebarSessionOrderAtom,
  sidebarSessionSortAtom,
} from "../sidebarSessionOrder";
import { useSessionSidebarOrdering } from "./useSessionSidebarOrdering";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

function mount(pinnedIds = ["a"]) {
  const store = createStore();
  store.set(sidebarSessionOrderAtom, []);
  store.set(sidebarSessionSortAtom, "updated");
  const onTogglePin = vi.fn(async () => undefined);
  const items: NavigationMenuItem[] = ["a", "b"].map((id) => ({
    id,
    key: id,
    label: id,
  }));
  const sessionMap = new Map(
    items.map((item) => [
      item.id,
      { session_id: item.id, pinned: pinnedIds.includes(item.id) } as Session,
    ])
  );
  let renderCount = 0;
  function Harness() {
    renderCount += 1;
    const ordering = useSessionSidebarOrdering({
      enabled: true,
      items,
      sessionMap,
      onTogglePin,
    });
    return React.createElement(
      React.Fragment,
      null,
      ordering.unpinDropZone,
      ...items.map((item) =>
        React.createElement(
          React.Fragment,
          { key: item.id },
          ordering.wrap(item, React.createElement("span", null, item.label))
        )
      ),
      ordering.insertionLine
    );
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      React.createElement(Provider, { store }, React.createElement(Harness))
    )
  );
  const start = (id: string) =>
    act(() => {
      document.dispatchEvent(
        new CustomEvent("tab-drag-start", { detail: { tabId: id } })
      );
    });
  const drop = (id: string) => {
    const row = container.querySelector<HTMLElement>(
      `[data-sidebar-order-id="${id}"]`
    )!;
    vi.spyOn(row, "getBoundingClientRect").mockReturnValue({
      top: 50,
      bottom: 80,
      left: 0,
      right: 200,
      width: 200,
      height: 30,
    } as DOMRect);
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: () => row,
    });
    const rendersBeforeMove = renderCount;
    act(() => {
      window.dispatchEvent(
        new MouseEvent("pointermove", { clientX: 30, clientY: 78 })
      );
    });
    expect(renderCount).toBe(rendersBeforeMove);
    const line = document.querySelector(
      '[data-testid="sidebar-session-insertion-line"]'
    );
    act(() => {
      document.dispatchEvent(
        new CustomEvent("tab-drag-end", {
          detail: { pointerX: 30, pointerY: 78 },
        })
      );
    });
    return line;
  };
  return {
    store,
    onTogglePin,
    start,
    drop,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe("session sidebar drag integration", () => {
  it("unpins when moving to a regular row, displays a line and saves the position", () => {
    const view = mount();
    try {
      view.start("a");
      expect(view.drop("b")).not.toBeNull();
      expect(view.onTogglePin).toHaveBeenCalledWith("a");
      expect(view.store.get(sidebarSessionSortAtom)).toBe("manual");
      expect(view.store.get(sidebarSessionOrderAtom)).toEqual(["b", "a"]);
      expect(
        document.querySelector('[data-testid="sidebar-session-insertion-line"]')
      ).toBeNull();
    } finally {
      view.unmount();
    }
  });
  it("rejects dragging an unpinned row into pinned rows", () => {
    const view = mount();
    try {
      view.start("b");
      expect(view.drop("a")).toBeNull();
      expect(view.onTogglePin).not.toHaveBeenCalled();
      expect(view.store.get(sidebarSessionOrderAtom)).toEqual([]);
      expect(view.store.get(sidebarSessionSortAtom)).toBe("updated");
      expect(
        document.querySelector('[data-testid="sidebar-pin-drop-zone"]')
      ).toBeNull();
    } finally {
      view.unmount();
    }
  });
  it.each([[[]], [["a", "b"]]])(
    "retains reordering within the same pin state (%j)",
    (pinnedIds) => {
      const view = mount(pinnedIds);
      try {
        view.start("a");
        expect(view.drop("b")).not.toBeNull();
        expect(view.store.get(sidebarSessionOrderAtom)).toEqual(["b", "a"]);
        expect(view.onTogglePin).not.toHaveBeenCalled();
      } finally {
        view.unmount();
      }
    }
  );
  it("supports the bottom unpin zone without a row target", () => {
    const view = mount();
    try {
      for (const [source, zoneId] of [["a", "sidebar-unpin-drop-zone"]]) {
        view.start(source);
        const zone = document.querySelector<HTMLElement>(
          `[data-testid="${zoneId}"]`
        )!;
        vi.spyOn(zone, "getBoundingClientRect").mockReturnValue({
          top: 100,
          bottom: 140,
          left: 0,
          right: 200,
          width: 200,
          height: 40,
        } as DOMRect);
        act(() => {
          document.dispatchEvent(
            new CustomEvent("tab-drag-end", {
              detail: { pointerX: 20, pointerY: 120 },
            })
          );
        });
        expect(view.onTogglePin).toHaveBeenCalledWith(source);
      }
    } finally {
      view.unmount();
    }
  });

  it("cancels without mutations and removes listeners on unmount", () => {
    const view = mount();
    view.start("a");
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    view.drop("b");
    expect(view.onTogglePin).not.toHaveBeenCalled();
    expect(view.store.get(sidebarSessionSortAtom)).toBe("updated");
    view.unmount();
    view.start("a");
    expect(
      document.querySelector('[data-testid="sidebar-unpin-drop-zone"]')
    ).toBeNull();
  });
});
