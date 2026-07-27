// @vitest-environment jsdom
import { act, createElement, useEffect } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UseWebviewLayoutReturn } from "../useWebviewLayout";
import { useWebviewLayout } from "../useWebviewLayout";
import { WEBVIEW_LAYOUT_CHANGED_EVENT } from "../webviewLayoutEvents";

const invokeMock = vi.fn().mockResolvedValue(undefined);

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
const labelRef = { current: "browser-session-layout-test" };
const layoutContainerRef = { current: null as HTMLDivElement | null };

class ResizeObserverMock {
  static instances: ResizeObserverMock[] = [];
  readonly disconnect = vi.fn();
  readonly observe = vi.fn();

  constructor(readonly callback: ResizeObserverCallback) {
    ResizeObserverMock.instances.push(this);
  }

  unobserve(): void {}
}

let latestLayout: UseWebviewLayoutReturn | null = null;

function LayoutHarness({ isVisible }: { isVisible: boolean }) {
  const layout = useWebviewLayout({
    containerRef: layoutContainerRef,
    isWebviewCreated: true,
    isWebviewAvailable: true,
    isVisible,
    labelRef,
    log: vi.fn(),
  });
  useEffect(() => {
    latestLayout = layout;
    return () => {
      latestLayout = null;
    };
  }, [layout]);
  return null;
}

describe("useWebviewLayout visibility lifecycle", () => {
  let container: HTMLDivElement;
  let root: Root;
  let rectSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    invokeMock.mockClear();
    ResizeObserverMock.instances = [];
    globalThis.ResizeObserver =
      ResizeObserverMock as unknown as typeof ResizeObserver;
    layoutContainerRef.current = document.createElement("div");
    rectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue({
        x: 10,
        y: 20,
        left: 10,
        top: 20,
        right: 310,
        bottom: 220,
        width: 300,
        height: 200,
        toJSON: () => ({}),
      });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    rectSpy.mockRestore();
    latestLayout = null;
    layoutContainerRef.current = null;
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("disconnects observers and ignores layout work while hidden", async () => {
    act(() => {
      root.render(createElement(LayoutHarness, { isVisible: true }));
    });
    expect(ResizeObserverMock.instances).toHaveLength(1);

    await act(async () => {
      await latestLayout!.updatePosition({ force: true });
    });
    expect(invokeMock).toHaveBeenLastCalledWith(
      "update_inline_webview_position",
      expect.objectContaining({
        label: "browser-session-layout-test",
        x: 10,
        y: 20,
        width: 300,
        height: 200,
      })
    );

    act(() => {
      root.render(createElement(LayoutHarness, { isVisible: false }));
    });
    expect(ResizeObserverMock.instances[0].disconnect).toHaveBeenCalledTimes(1);

    invokeMock.mockClear();
    await act(async () => {
      await latestLayout!.updatePosition({ force: true });
      window.dispatchEvent(new Event(WEBVIEW_LAYOUT_CHANGED_EVENT));
      await Promise.resolve();
    });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("uses the atomic reposition-and-show command when becoming visible", async () => {
    act(() => {
      root.render(createElement(LayoutHarness, { isVisible: true }));
    });

    await act(async () => {
      await latestLayout!.updatePosition({ force: true, show: true });
    });

    expect(invokeMock).toHaveBeenCalledWith(
      "reposition_and_show_webview",
      expect.objectContaining({
        label: "browser-session-layout-test",
        x: 10,
        y: 20,
        width: 300,
        height: 200,
      })
    );
  });

  it("cleans up every observer across repeated visible/hidden cycles", () => {
    for (let index = 0; index < 20; index += 1) {
      act(() => {
        root.render(createElement(LayoutHarness, { isVisible: true }));
      });
      act(() => {
        root.render(createElement(LayoutHarness, { isVisible: false }));
      });
    }

    expect(ResizeObserverMock.instances).toHaveLength(20);
    for (const observer of ResizeObserverMock.instances) {
      expect(observer.disconnect).toHaveBeenCalledTimes(1);
    }
  });
});
