// @vitest-environment jsdom
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

import { useViewportWidth } from "./useViewportWidth";

function ViewportWidthProbe() {
  const width = useViewportWidth();
  return React.createElement("div", { "data-width": width });
}

describe("useViewportWidth", () => {
  let container: HTMLDivElement;
  let root: Root;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("coalesces resize bursts to one frame and cancels pending work on unmount", () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1200,
      writable: true,
    });
    let pendingFrame: FrameRequestCallback | null = null;
    const requestFrame = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        pendingFrame = callback;
        return 41;
      });
    const cancelFrame = vi.spyOn(window, "cancelAnimationFrame");

    act(() => root.render(React.createElement(ViewportWidthProbe)));
    expect(container.firstElementChild?.getAttribute("data-width")).toBe(
      "1200"
    );

    window.innerWidth = 1919;
    act(() => {
      window.dispatchEvent(new Event("resize"));
      window.dispatchEvent(new Event("resize"));
    });

    expect(requestFrame).toHaveBeenCalledOnce();
    expect(container.firstElementChild?.getAttribute("data-width")).toBe(
      "1200"
    );

    act(() => pendingFrame?.(0));
    expect(container.firstElementChild?.getAttribute("data-width")).toBe(
      "1919"
    );

    window.innerWidth = 1920;
    act(() => window.dispatchEvent(new Event("resize")));
    expect(requestFrame).toHaveBeenCalledTimes(2);

    act(() => root.unmount());
    root = createRoot(container);
    expect(cancelFrame).toHaveBeenCalledWith(41);

    window.dispatchEvent(new Event("resize"));
    expect(requestFrame).toHaveBeenCalledTimes(2);
  });
});
