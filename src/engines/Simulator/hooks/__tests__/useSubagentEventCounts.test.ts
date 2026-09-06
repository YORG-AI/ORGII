// @vitest-environment jsdom
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { useSubagentEventCounts } from "../useSubagentEventCounts";
import type { SubagentSession } from "../useSubagentSessions";

const proxy = vi.hoisted(() => ({
  getChatActivity: vi.fn(),
  subscribeSession: vi.fn(() => vi.fn()),
  getLatestSessionSnapshot: vi.fn(),
  loadFromCache: vi.fn(),
  getSnapshot: vi.fn(),
}));
vi.mock("@src/engines/SessionCore/core/store/EventStoreProxy", () => ({
  eventStoreProxy: proxy,
}));
afterEach(() => vi.resetAllMocks());
beforeEach(() => proxy.subscribeSession.mockImplementation(() => vi.fn()));
it("uses bounded activity batches, ignores old-parent completions, and never hydrates histories", async () => {
  const env = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  env.IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(document, "hidden", {
    configurable: true,
    value: false,
  });
  let finish: (activity: Record<string, boolean>) => void = () => {};
  proxy.getChatActivity
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    )
    .mockResolvedValue({ b: true });
  let result: ReadonlyMap<string, number> = new Map();
  function Harness({ ids }: { ids: string[] }) {
    const value = useSubagentEventCounts(
      ids.map((sessionId) => ({ sessionId }) as SubagentSession)
    );
    useEffect(() => {
      result = value;
    }, [value]);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(createElement(Harness, { ids: ["a"] })));
    await act(async () => root.render(createElement(Harness, { ids: ["b"] })));
    await act(async () => finish({ a: true }));
    expect([...result]).toEqual([["b", 1]]);
    expect(proxy.loadFromCache).not.toHaveBeenCalled();
    expect(proxy.getSnapshot).not.toHaveBeenCalled();
    proxy.getChatActivity.mockResolvedValue({});
    await act(async () =>
      root.render(
        createElement(Harness, {
          ids: Array.from({ length: 130 }, (_, i) => `child-${i}`),
        })
      )
    );
    expect(
      proxy.getChatActivity.mock.calls.slice(-3).map(([ids]) => ids.length)
    ).toEqual([64, 64, 2]);
  } finally {
    act(() => root.unmount());
    delete env.IS_REACT_ACT_ENVIRONMENT;
  }
});
it("does no hidden work and retries a failed probe on visibility", async () => {
  const env = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  env.IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(document, "hidden", {
    configurable: true,
    value: true,
  });
  proxy.getChatActivity
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue({ a: true });
  let result: ReadonlyMap<string, number> = new Map();
  function Harness() {
    const value = useSubagentEventCounts([
      { sessionId: "a" } as SubagentSession,
    ]);
    useEffect(() => {
      result = value;
    }, [value]);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  const visibility = async (hidden: boolean) => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: hidden,
    });
    await act(async () =>
      document.dispatchEvent(new Event("visibilitychange"))
    );
  };
  try {
    await act(async () => root.render(createElement(Harness)));
    expect(proxy.getChatActivity).not.toHaveBeenCalled();
    await visibility(false);
    expect(result.size).toBe(0);
    await visibility(true);
    await visibility(false);
    expect(result.get("a")).toBe(1);
    expect(proxy.getChatActivity).toHaveBeenCalledTimes(2);
  } finally {
    act(() => root.unmount());
    delete env.IS_REACT_ACT_ENVIRONMENT;
  }
});
