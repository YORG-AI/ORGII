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
  visibilityObservers: new Set<() => void>(),
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

describe("useEmbeddedWebview visibility polling", () => {
  let container: HTMLDivElement;
  let host: HTMLDivElement;
  let hostVisible: boolean;
  let root: Root;
  let latest: UseEmbeddedWebviewReturn | null;

  beforeAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        private readonly callback: () => void;

        constructor(callback: () => void) {
          this.callback = callback;
          mocks.visibilityObservers.add(callback);
        }
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {
          mocks.visibilityObservers.delete(this.callback);
        }
        takeRecords(): IntersectionObserverEntry[] {
          return [];
        }
      }
    );
    vi.stubGlobal(
      "ResizeObserver",
      class {
        private readonly callback: () => void;

        constructor(callback: () => void) {
          this.callback = callback;
          mocks.visibilityObservers.add(callback);
        }
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {
          mocks.visibilityObservers.delete(this.callback);
        }
      }
    );
  });

  beforeEach(() => {
    vi.useFakeTimers();
    latest = null;
    mocks.visibilityObservers.clear();
    hostVisible = true;
    container = document.createElement("div");
    host = document.createElement("div");
    document.body.append(container, host);
    root = createRoot(container);

    Object.defineProperty(host, "offsetParent", {
      configurable: true,
      get: () => (hostVisible ? document.body : null),
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
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  afterAll(() => {
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
    vi.unstubAllGlobals();
  });

  it("observes visibility without retaining a polling timer", async () => {
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

    hostVisible = false;
    await act(async () => {
      for (const observer of mocks.visibilityObservers) observer();
      await Promise.resolve();
    });
    expect(latest!.isOpen).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(mocks.invoke).toHaveBeenCalledWith("close_test_webview", {
      label: "test-webview-id",
    });

    hostVisible = true;
    await act(async () => {
      for (const observer of mocks.visibilityObservers) observer();
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
