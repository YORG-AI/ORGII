// @vitest-environment jsdom
import { Provider, createStore } from "jotai";
import React, { act, createElement, useRef } from "react";
import { type Root, createRoot } from "react-dom/client";

import { overlayLayerRegistryAtom } from "@src/store/ui/overlayLayerAtom";

import { useInlineWebviewOcclusions } from "../useInlineWebviewOcclusions";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@src/util/platform/tauri", () => ({ isMacOS: () => true }));
vi.mock("@src/util/platform/tauri/nativeFrame", () => ({
  getNativeFrameScale: () => 1,
}));
vi.mock("../visibleWebviewRect", () => ({
  getVisibleWebviewRect: () => ({
    left: 100,
    top: 50,
    right: 500,
    bottom: 350,
    width: 400,
    height: 300,
  }),
}));

function Harness() {
  const ref = useRef<HTMLDivElement | null>(null);
  useInlineWebviewOcclusions({
    containerRef: ref,
    isWebviewCreated: true,
    isSurfaceVisible: true,
    label: "browser-session-test",
  });
  // eslint-disable-next-line react-hooks/refs -- Vitest only collects `.test.ts`; createElement is the JSX-equivalent ref prop.
  return createElement("div", { ref });
}

function renderHarness(
  store: ReturnType<typeof createStore>
): React.ReactElement {
  return createElement(Provider, { store }, createElement(Harness));
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useInlineWebviewOcclusions", () => {
  let container: HTMLDivElement;
  let root: Root;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    invokeMock.mockReset().mockResolvedValue(undefined);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("applies a local hole and clears it when the overlay closes", async () => {
    const store = createStore();
    await act(async () => {
      root.render(renderHarness(store));
    });
    await flushEffects();
    invokeMock.mockClear();

    act(() => {
      store.set(overlayLayerRegistryAtom, {
        menu: {
          id: "menu",
          rect: { x: 450, y: 20, width: 100, height: 100 },
          blocksNativeInput: true,
          nativeDimmingAlpha: 0,
        },
      });
    });
    await flushEffects();

    expect(invokeMock).toHaveBeenLastCalledWith(
      "set_inline_webview_occlusions",
      {
        label: "browser-session-test",
        rects: [{ x: 350, y: 0, width: 50, height: 70 }],
        blockInput: true,
        dimmingAlpha: 0,
      }
    );

    act(() => store.set(overlayLayerRegistryAtom, {}));
    await flushEffects();
    expect(invokeMock).toHaveBeenLastCalledWith(
      "set_inline_webview_occlusions",
      {
        label: "browser-session-test",
        rects: [],
        blockInput: false,
        dimmingAlpha: 0,
      }
    );
  });

  it("keeps a modal panel local while dimming the live native page", async () => {
    const store = createStore();
    await act(async () => {
      root.render(renderHarness(store));
    });
    await flushEffects();
    invokeMock.mockClear();

    act(() => {
      store.set(overlayLayerRegistryAtom, {
        modal: {
          id: "modal",
          rect: { x: 200, y: 100, width: 200, height: 120 },
          blocksNativeInput: true,
          nativeDimmingAlpha: 0.6,
        },
      });
    });
    await flushEffects();

    expect(invokeMock).toHaveBeenLastCalledWith(
      "set_inline_webview_occlusions",
      {
        label: "browser-session-test",
        rects: [{ x: 100, y: 50, width: 200, height: 120 }],
        blockInput: true,
        dimmingAlpha: 0.6,
      }
    );
  });

  it("applies the latest close after a slower open command completes", async () => {
    const store = createStore();
    await act(async () => {
      root.render(renderHarness(store));
    });
    await flushEffects();
    invokeMock.mockClear();

    let resolveOpen!: () => void;
    invokeMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveOpen = resolve;
        })
    );

    act(() => {
      store.set(overlayLayerRegistryAtom, {
        menu: {
          id: "menu",
          rect: { x: 200, y: 100, width: 100, height: 100 },
          blocksNativeInput: true,
          nativeDimmingAlpha: 0.6,
        },
      });
    });
    await flushEffects();
    expect(invokeMock).toHaveBeenCalledTimes(1);

    act(() => store.set(overlayLayerRegistryAtom, {}));
    await flushEffects();
    expect(invokeMock).toHaveBeenCalledTimes(1);

    resolveOpen();
    await flushEffects();

    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(invokeMock).toHaveBeenLastCalledWith(
      "set_inline_webview_occlusions",
      {
        label: "browser-session-test",
        rects: [],
        blockInput: false,
        dimmingAlpha: 0,
      }
    );
  });
});
