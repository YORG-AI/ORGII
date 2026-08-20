// @vitest-environment jsdom
import { act, createElement, useEffect } from "react";
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

import {
  type UseEmbeddedWebviewReturn,
  useEmbeddedWebview,
} from "./useEmbeddedWebview";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(() => Promise.resolve()),
  unlisten: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(mocks.unlisten)),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "main" }),
}));
vi.mock("uuid", () => ({ v4: () => "webview-id" }));
vi.mock("@src/util/platform/tauri/nativeFrame", () => ({
  toNativeFrame: () => ({ x: 1, y: 2, width: 300, height: 200 }),
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

const commands = {
  create: "create_test_webview",
  close: "close_test_webview",
  urlChangedEvent: "test-webview-url-changed",
};

describe("useEmbeddedWebview visibility observation", () => {
  let container: HTMLDivElement;
  let host: HTMLDivElement;
  let hostVisible: boolean;
  let pageVisibility: DocumentVisibilityState;
  let originalVisibilityState: PropertyDescriptor | undefined;
  let notifyIntersection: (() => void) | null;
  let notifyResize: (() => void) | null;
  let root: Root;
  let latest: UseEmbeddedWebviewReturn | null;

  beforeAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    vi.useFakeTimers();
    latest = null;
    notifyIntersection = null;
    notifyResize = null;
    hostVisible = true;
    pageVisibility = "visible";
    container = document.createElement("div");
    host = document.createElement("div");
    document.body.append(container, host);
    root = createRoot(container);

    vi.stubGlobal(
      "IntersectionObserver",
      class IntersectionObserverMock {
        readonly root = null;
        readonly rootMargin = "";
        readonly thresholds = [];

        constructor(callback: IntersectionObserverCallback) {
          notifyIntersection = () =>
            callback([], this as unknown as IntersectionObserver);
        }

        disconnect() {}
        observe() {}
        takeRecords(): IntersectionObserverEntry[] {
          return [];
        }
        unobserve() {}
      }
    );
    vi.stubGlobal(
      "ResizeObserver",
      class ResizeObserverMock {
        constructor(callback: ResizeObserverCallback) {
          notifyResize = () => callback([], this as unknown as ResizeObserver);
        }

        disconnect() {}
        observe() {}
        unobserve() {}
      }
    );

    Object.defineProperty(host, "offsetParent", {
      configurable: true,
      get: () => (hostVisible ? document.body : null),
    });
    originalVisibilityState = Object.getOwnPropertyDescriptor(
      document,
      "visibilityState"
    );
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => pageVisibility,
    });
    host.getBoundingClientRect = () =>
      ({
        x: 0,
        y: 0,
        top: 0,
        right: 300,
        bottom: 200,
        left: 0,
        width: 300,
        height: 200,
        toJSON: () => ({}),
      }) as DOMRect;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    host.remove();
    if (originalVisibilityState) {
      Object.defineProperty(
        document,
        "visibilityState",
        originalVisibilityState
      );
    } else {
      Reflect.deleteProperty(document, "visibilityState");
    }
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  afterAll(() => {
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("reacts to host visibility changes without polling", async () => {
    const hostRef = { current: host };
    const Harness = () => {
      const value = useEmbeddedWebview({
        labelPrefix: "test",
        containerRef: hostRef,
        commands,
      });
      useEffect(() => {
        latest = value;
      }, [value]);
      return null;
    };

    await act(async () => {
      root.render(createElement(Harness));
      await Promise.resolve();
    });

    expect(vi.getTimerCount()).toBe(0);

    await act(async () => {
      await latest!.openWebview("https://example.test");
    });
    expect(latest!.isOpen).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    pageVisibility = "hidden";
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      notifyIntersection!();
      await Promise.resolve();
    });
    expect(latest!.isOpen).toBe(true);
    expect(mocks.invoke).not.toHaveBeenCalledWith("close_test_webview", {
      label: "test-webview-id",
    });

    hostVisible = false;
    await act(async () => {
      notifyIntersection!();
      await Promise.resolve();
    });
    expect(latest!.isOpen).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(mocks.invoke).toHaveBeenCalledWith("close_test_webview", {
      label: "test-webview-id",
    });

    hostVisible = true;
    await act(async () => {
      notifyResize!();
      await Promise.resolve();
    });
    expect(latest!.isOpen).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    await act(async () => {
      await latest!.closeWebview();
    });
    expect(latest!.isOpen).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
