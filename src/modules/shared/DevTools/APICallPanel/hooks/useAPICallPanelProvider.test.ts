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
  type UseAPICallPanelProviderReturn,
  useAPICallPanelProvider,
} from "./useAPICallPanelProvider";

const mocks = vi.hoisted(() => ({
  clearApiCalls: vi.fn(),
  disableApiTracking: vi.fn(),
  enableApiTracking: vi.fn(),
  getApiCallHotspots: vi.fn(() => []),
  getApiCalls: vi.fn(() => [
    {
      id: "call-1",
      method: "GET",
      url: "/health",
      fullUrl: "http://localhost/health",
      transport: "http",
      timestamp: "2026-07-23T00:00:00.000Z",
    },
  ]),
  getPushHotspots: vi.fn(() => []),
  getTimerHotspots: vi.fn(() => []),
}));

vi.mock("@src/util/monitoring/apiTracker", () => mocks);

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe("useAPICallPanelProvider lifecycle", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  afterAll(() => {
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("disables tracking and releases captured data when closed", async () => {
    let latest: UseAPICallPanelProviderReturn | null = null;
    const capture = (value: UseAPICallPanelProviderReturn) => {
      latest = value;
    };
    const Harness = ({
      onValue,
    }: {
      onValue: (value: UseAPICallPanelProviderReturn) => void;
    }) => {
      const value = useAPICallPanelProvider();
      useEffect(() => onValue(value), [onValue, value]);
      return null;
    };

    act(() => root.render(createElement(Harness, { onValue: capture })));
    await act(async () => {
      window.dispatchEvent(new Event("toggle-panel-api-call"));
      await Promise.resolve();
    });

    expect(latest!.visible).toBe(true);
    expect(latest!.apiCalls).toHaveLength(1);
    expect(mocks.enableApiTracking).toHaveBeenCalledOnce();

    act(() => latest!.handleClose());

    expect(latest!.visible).toBe(false);
    expect(latest!.apiCalls).toEqual([]);
    expect(latest!.hotspots).toEqual([]);
    expect(mocks.disableApiTracking).toHaveBeenCalled();
    expect(mocks.clearApiCalls).toHaveBeenCalled();
  });
});
