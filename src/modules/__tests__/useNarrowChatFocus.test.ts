// @vitest-environment jsdom
import { Provider } from "jotai";
import { createStore } from "jotai/vanilla";
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

import { chatPanelDraggingAtom } from "@src/store/ui/chatPanelAtom";

import {
  resolveWorkbenchEvaluationWidth,
  useNarrowChatFocus,
} from "../useNarrowChatFocus";

describe("resolveWorkbenchEvaluationWidth", () => {
  it("uses the projected target width during programmatic reopening", () => {
    expect(
      resolveWorkbenchEvaluationWidth({
        chatPanelDragging: false,
        chatPanelMaximized: false,
        chatVisible: true,
        chatWidth: 520,
        mainContentWidth: 1280,
        measuredWorkbenchWidth: 24,
      })
    ).toBe(760);
  });

  it("uses the projected target width while chat is maximized", () => {
    expect(
      resolveWorkbenchEvaluationWidth({
        chatPanelDragging: false,
        chatPanelMaximized: true,
        chatVisible: true,
        chatWidth: 520,
        mainContentWidth: 1280,
        measuredWorkbenchWidth: 0,
      })
    ).toBe(760);
  });

  it("uses the measured width during direct chat resizing", () => {
    expect(
      resolveWorkbenchEvaluationWidth({
        chatPanelDragging: true,
        chatPanelMaximized: false,
        chatVisible: true,
        chatWidth: 520,
        mainContentWidth: 1280,
        measuredWorkbenchWidth: 472,
      })
    ).toBe(472);
  });
});

function NarrowChatFocusProbe() {
  useNarrowChatFocus({ enabled: true });
  return null;
}

describe("useNarrowChatFocus observer lifecycle", () => {
  let container: HTMLDivElement;
  let mainContent: HTMLDivElement;
  let workbench: HTMLDivElement;
  let root: Root;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement("div");
    mainContent = document.createElement("div");
    workbench = document.createElement("div");
    mainContent.setAttribute("data-main-content", "");
    workbench.setAttribute("data-workbench-surface", "");
    mainContent.appendChild(workbench);
    document.body.append(container, mainContent);
    root = createRoot(container);

    vi.spyOn(mainContent, "getBoundingClientRect").mockReturnValue({
      width: 1280,
    } as DOMRect);
    vi.spyOn(workbench, "getBoundingClientRect").mockReturnValue({
      width: 760,
    } as DOMRect);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    mainContent.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("observes the workbench only during a direct divider drag", () => {
    const observers: ResizeObserverMock[] = [];

    class ResizeObserverMock {
      readonly observed = new Set<Element>();
      readonly observe = vi.fn((element: Element) => {
        this.observed.add(element);
      });
      readonly unobserve = vi.fn((element: Element) => {
        this.observed.delete(element);
      });
      readonly disconnect = vi.fn(() => {
        this.observed.clear();
      });

      constructor(_callback: ResizeObserverCallback) {
        observers.push(this);
      }
    }

    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    const store = createStore();

    act(() => {
      root.render(
        React.createElement(
          Provider,
          { store },
          React.createElement(NarrowChatFocusProbe)
        )
      );
    });

    expect(observers).toHaveLength(1);
    expect(observers[0].observed.has(mainContent)).toBe(true);
    expect(observers[0].observed.has(workbench)).toBe(false);

    act(() => store.set(chatPanelDraggingAtom, true));
    expect(observers[0].observed.has(workbench)).toBe(true);

    act(() => store.set(chatPanelDraggingAtom, false));
    expect(observers[0].observed.has(workbench)).toBe(false);
    expect(observers[0].unobserve).toHaveBeenCalledWith(workbench);

    act(() => root.unmount());
    root = createRoot(container);
    expect(observers[0].disconnect).toHaveBeenCalledOnce();
  });
});
