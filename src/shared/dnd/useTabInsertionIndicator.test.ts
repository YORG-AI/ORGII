// @vitest-environment jsdom
import { type RefObject, act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useTabInsertionIndicator } from "./useTabInsertionIndicator";

const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

function Harness({
  containerRef,
  draggingTabId,
}: {
  containerRef: RefObject<HTMLDivElement | null>;
  draggingTabId: string | null;
}) {
  useTabInsertionIndicator({ containerRef, draggingTabId });
  return null;
}

describe("useTabInsertionIndicator", () => {
  let host: HTMLDivElement;
  let band: HTMLDivElement;
  let bandRef: RefObject<HTMLDivElement | null>;
  let root: Root;
  let bandTop: number;
  let targetLeft: number;
  let nextFrameId: number;
  let frames: Map<number, FrameRequestCallback>;
  let visibility: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    band = document.createElement("div");
    band.dataset.tabBand = "true";
    const scrollStrip = document.createElement("div");
    scrollStrip.dataset.scrollStrip = "true";
    for (const tabId of ["source", "target"]) {
      const tab = document.createElement("div");
      tab.dataset.tabId = tabId;
      scrollStrip.appendChild(tab);
    }
    band.appendChild(scrollStrip);
    document.body.appendChild(band);
    bandRef = { current: band };
    bandTop = 10;
    targetLeft = 190;
    nextFrameId = 0;
    frames = new Map();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      const frameId = ++nextFrameId;
      frames.set(frameId, callback);
      return frameId;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((frameId) => {
      frames.delete(frameId);
    });
    visibility = vi.spyOn(document, "visibilityState", "get");
    visibility.mockReturnValue("visible");
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        const left = this.dataset.tabId === "target" ? targetLeft : 100;
        const width = this.hasAttribute("data-tab-band") ? 400 : 80;
        return new DOMRect(left, bandTop, width, 32);
      }
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    band.remove();
    vi.restoreAllMocks();
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  function renderDrag(draggingTabId: string | null = "source") {
    act(() =>
      root.render(
        createElement(Harness, { containerRef: bandRef, draggingTabId })
      )
    );
  }

  function movePointer(clientX = 210, clientY = bandTop + 12) {
    document.dispatchEvent(new MouseEvent("pointermove", { clientX, clientY }));
  }

  function flushFrame() {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(0);
  }

  function indicator() {
    return document.querySelector<HTMLDivElement>(".tab-insertion-indicator")!;
  }

  it.each([
    ["Workstation", 10],
    ["Chat Panel", 130],
  ])("matches the %s highlight band's top and height", (_surface, top) => {
    bandTop = top;
    renderDrag();
    movePointer();
    flushFrame();

    expect(indicator().style.height).toBe("32px");
    expect(indicator().style.transform).toBe(`translate3d(189px, ${top}px, 0)`);
    expect(indicator().style.display).toBe("block");
    expect(indicator().getAttribute("aria-hidden")).toBe("true");
  });

  it("updates vertical geometry when the insertion x position is unchanged", () => {
    renderDrag();
    movePointer();
    flushFrame();

    bandTop = 20;
    window.dispatchEvent(new Event("resize"));
    flushFrame();
    expect(indicator().style.transform).toBe("translate3d(189px, 20px, 0)");
  });

  it("reappears at the same insertion position after leaving the tab band", () => {
    renderDrag();
    movePointer();
    flushFrame();
    movePointer(50);
    flushFrame();
    expect(indicator().style.display).toBe("none");

    movePointer();
    flushFrame();
    expect(indicator().style.display).toBe("block");
  });

  it("tracks scrolling without waiting for another pointer movement", () => {
    renderDrag();
    movePointer();
    flushFrame();
    targetLeft = 200;
    band
      .querySelector("[data-scroll-strip]")!
      .dispatchEvent(new Event("scroll"));
    flushFrame();
    expect(indicator().style.transform).toBe("translate3d(199px, 10px, 0)");
  });

  it.each([
    [10, 100],
    [590, 498],
  ])(
    "keeps a scrolled edge at %ipx out of the button areas",
    (left, expected) => {
      targetLeft = left;
      renderDrag();
      movePointer();
      flushFrame();
      expect(indicator().style.transform).toBe(
        `translate3d(${expected}px, 10px, 0)`
      );
    }
  );

  it("coalesces pointer bursts into one frame and does no continuous work", () => {
    renderDrag();
    movePointer(200);
    movePointer(205);
    movePointer();
    expect(frames.size).toBe(1);
    flushFrame();
    expect(frames.size).toBe(0);
    expect(indicator().style.transform).toBe("translate3d(189px, 10px, 0)");
  });

  it("creates no indicator or pointer listener while idle", () => {
    const addListener = vi.spyOn(document, "addEventListener");
    renderDrag(null);
    movePointer();
    expect(indicator()).toBeNull();
    expect(frames.size).toBe(0);
    expect(
      addListener.mock.calls.filter(([type]) => type === "pointermove")
    ).toHaveLength(0);
  });

  it("cancels pending work while hidden and refreshes once on return", () => {
    renderDrag();
    movePointer();
    visibility.mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(frames.size).toBe(0);
    expect(indicator().style.display).toBe("none");
    movePointer();
    expect(frames.size).toBe(0);

    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(frames.size).toBe(1);
    flushFrame();
    expect(indicator().style.display).toBe("block");
    expect(frames.size).toBe(0);
  });

  it("removes listeners, pending frames, and DOM on repeated drag end or cancel", () => {
    const addListener = vi.spyOn(document, "addEventListener");
    const removeListener = vi.spyOn(document, "removeEventListener");
    for (let cycle = 0; cycle < 3; cycle++) {
      renderDrag();
      movePointer();
      expect(
        document.querySelectorAll(".tab-insertion-indicator")
      ).toHaveLength(1);
      renderDrag(null);
      expect(indicator()).toBeNull();
      expect(frames.size).toBe(0);
      movePointer();
      expect(frames.size).toBe(0);
    }
    for (const type of ["pointermove", "visibilitychange"]) {
      const added = addListener.mock.calls.filter(([event]) => event === type);
      const removed = removeListener.mock.calls.filter(
        ([event]) => event === type
      );
      expect(added).toHaveLength(3);
      expect(removed.map(([, listener]) => listener)).toEqual(
        added.map(([, listener]) => listener)
      );
    }
  });

  it("cleans up when the tab strip unmounts during a drag", () => {
    renderDrag();
    movePointer();
    act(() => root.render(null));
    expect(indicator()).toBeNull();
    expect(frames.size).toBe(0);
    movePointer();
    window.dispatchEvent(new Event("resize"));
    expect(frames.size).toBe(0);
  });
});
