// @vitest-environment jsdom
import { Provider, createStore } from "jotai";
import { StrictMode, act, createElement, useRef } from "react";
import { type Root, createRoot } from "react-dom/client";

import {
  activeOverlayCountAtom,
  overlayOcclusionStateAtom,
  useOverlayLayer,
} from "./overlayLayerAtom";

const RECT = {
  x: 20,
  y: 30,
  left: 20,
  top: 30,
  right: 220,
  bottom: 130,
  width: 200,
  height: 100,
  toJSON: () => ({}),
} as DOMRect;

function Overlay({
  active,
  nativeDimmingAlpha,
}: {
  active: boolean;
  nativeDimmingAlpha?: number;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useOverlayLayer(active, ref, { nativeDimmingAlpha });
  // eslint-disable-next-line react-hooks/refs -- Vitest only collects `.test.ts`; createElement is the JSX-equivalent ref prop.
  return createElement("div", { ref }, "overlay");
}

describe("useOverlayLayer", () => {
  let container: HTMLDivElement;
  let root: Root;
  let rectSpy: ReturnType<typeof vi.spyOn>;
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
    rectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue(RECT);
  });

  afterEach(() => {
    act(() => root.unmount());
    rectSpy.mockRestore();
    container.remove();
  });

  afterAll(() => {
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("publishes geometry while open and removes it on close under StrictMode", async () => {
    const store = createStore();
    const render = async (active: boolean) => {
      await act(async () => {
        root.render(
          createElement(
            StrictMode,
            null,
            createElement(
              Provider,
              { store },
              createElement(Overlay, {
                active,
                nativeDimmingAlpha: 0.6,
              })
            )
          )
        );
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve())
        );
      });
    };

    await render(false);
    expect(store.get(activeOverlayCountAtom)).toBe(0);

    await render(true);
    expect(store.get(activeOverlayCountAtom)).toBe(1);
    expect(store.get(overlayOcclusionStateAtom)).toEqual({
      rects: [{ x: 20, y: 30, width: 200, height: 100 }],
      blocksNativeInput: true,
      nativeDimmingAlpha: 0.6,
    });

    await render(false);
    expect(store.get(activeOverlayCountAtom)).toBe(0);
    expect(store.get(overlayOcclusionStateAtom)).toEqual({
      rects: [],
      blocksNativeInput: false,
      nativeDimmingAlpha: 0,
    });
  });
});
