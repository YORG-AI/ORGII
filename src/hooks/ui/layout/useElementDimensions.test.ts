// @vitest-environment jsdom
import React, { act, createElement, useRef } from "react";
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

import { useElementDimensions } from "./useElementDimensions";

function DimensionProbe(): React.ReactNode {
  const elementRef = useRef<HTMLDivElement>(null);
  const dimensions = useElementDimensions(elementRef);

  // eslint-disable-next-line react-hooks/refs -- createElement is required because Vitest only includes `.test.ts`; this is a normal React ref prop.
  return createElement("div", {
    ref: elementRef,
    "data-testid": "dimension-probe",
    "data-dimensions": `${dimensions.width}x${dimensions.height}`,
  });
}

describe("useElementDimensions", () => {
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
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("keeps the window resize fallback when ResizeObserver is unavailable", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const addWindowListener = vi.spyOn(window, "addEventListener");
    const removeWindowListener = vi.spyOn(window, "removeEventListener");

    expect(() => {
      act(() => root.render(createElement(DimensionProbe)));
    }).not.toThrow();

    expect(addWindowListener).toHaveBeenCalledWith(
      "resize",
      expect.any(Function)
    );

    act(() => root.unmount());
    root = createRoot(container);

    expect(removeWindowListener).toHaveBeenCalledWith(
      "resize",
      expect.any(Function)
    );
  });

  it("disconnects the observer when the measured element unmounts", () => {
    const observe = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class ResizeObserverMock {
        observe = observe;
        unobserve = vi.fn();
        disconnect = disconnect;
      }
    );

    act(() => root.render(createElement(DimensionProbe)));

    expect(observe).toHaveBeenCalledWith(
      container.querySelector('[data-testid="dimension-probe"]')
    );

    act(() => root.unmount());
    root = createRoot(container);

    expect(disconnect).toHaveBeenCalledOnce();
  });
});
