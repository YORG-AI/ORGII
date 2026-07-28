// @vitest-environment jsdom
import { act, createElement } from "react";
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

import { useWebviewUrlPolling } from "./useWebviewUrlPolling";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn<() => Promise<string | null>>(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe("useWebviewUrlPolling", () => {
  let host: HTMLDivElement;
  let root: Root;
  let visibilityState: DocumentVisibilityState;

  beforeAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    vi.useFakeTimers();
    visibilityState = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibilityState,
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    mocks.invoke.mockResolvedValue("https://example.test/next");
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    Reflect.deleteProperty(document, "visibilityState");
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  afterAll(() => {
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("pauses while hidden, revalidates on return, and disposes its timer", async () => {
    const isDestroyedRef = { current: false };
    const isUnmountedRef = { current: false };
    const pollIntervalRef: {
      current: ReturnType<typeof setInterval> | null;
    } = { current: null };
    const setCurrentUrl = vi.fn();
    const onNavigate = vi.fn();

    const Harness = () => {
      useWebviewUrlPolling({
        isWebviewCreated: true,
        isVisible: true,
        pollInterval: 1_000,
        labelRef: { current: "test-webview" },
        isDestroyedRef,
        isUnmountedRef,
        pollIntervalRef,
        lastPolledUrlRef: { current: "" },
        setCurrentUrl,
        onNavigate,
        log: vi.fn(),
      });
      return null;
    };

    await act(async () => {
      root.render(createElement(Harness));
    });
    expect(vi.getTimerCount()).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenCalledWith("get_webview_url", {
      label: "test-webview",
    });
    expect(setCurrentUrl).toHaveBeenCalledWith("https://example.test/next");
    expect(onNavigate).toHaveBeenCalledWith("https://example.test/next");
    expect(vi.getTimerCount()).toBe(1);

    visibilityState = "hidden";
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(vi.getTimerCount()).toBe(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(mocks.invoke).toHaveBeenCalledTimes(1);

    visibilityState = "visible";
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);

    act(() => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
  });
});
