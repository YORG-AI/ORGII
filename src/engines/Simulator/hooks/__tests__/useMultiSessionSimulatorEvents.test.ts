// @vitest-environment jsdom
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { useMultiSessionSimulatorEvents } from "../useMultiSessionSimulatorEvents";
import type { SubagentSession } from "../useSubagentSessions";

const proxy = vi.hoisted(() => ({
  getSnapshot: vi.fn(),
  loadFromCache: vi.fn(),
  subscribeSession: vi.fn(),
  getLatestSessionSnapshot: vi.fn(),
}));
vi.mock("@src/engines/SessionCore/core/store/EventStoreProxy", () => ({
  eventStoreProxy: proxy,
  isStreamingSnapshot: (snapshot: { streaming?: boolean }) =>
    snapshot.streaming === true,
}));
beforeEach(() => {
  proxy.subscribeSession.mockImplementation(() => vi.fn());
  Object.defineProperty(document, "hidden", {
    configurable: true,
    value: false,
  });
});
afterEach(() => vi.resetAllMocks());
it("rejects late loads after a parent switch before allocating a full snapshot", async () => {
  const env = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  env.IS_REACT_ACT_ENVIRONMENT = true;
  let resolveOld: (n: number) => void = () => {};
  proxy.loadFromCache
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        })
    )
    .mockResolvedValue(0);
  proxy.getSnapshot.mockResolvedValue({ sortedSimulatorEvents: [] });
  let result: ReturnType<typeof useMultiSessionSimulatorEvents> | undefined;
  function Harness({ id }: { id: string }) {
    const value = useMultiSessionSimulatorEvents([
      { sessionId: id } as SubagentSession,
    ]);
    useEffect(() => {
      result = value;
    }, [value]);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(createElement(Harness, { id: "old" })));
    await act(async () => root.render(createElement(Harness, { id: "new" })));
    await act(async () => resolveOld(1000));
    expect(proxy.getSnapshot.mock.calls).toEqual([["new"]]);
    expect([...result!.eventsMap.keys()]).toEqual(["new"]);
    expect(result!.loadState("new").status).toBe("ready");
  } finally {
    act(() => root.unmount());
    delete env.IS_REACT_ACT_ENVIRONMENT;
  }
});
it("exposes failed versus empty history and retries once on request", async () => {
  const env = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  env.IS_REACT_ACT_ENVIRONMENT = true;
  proxy.loadFromCache
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue(0);
  proxy.getSnapshot.mockResolvedValue({ sortedSimulatorEvents: [] });
  let result: ReturnType<typeof useMultiSessionSimulatorEvents> | undefined;
  function Harness() {
    const value = useMultiSessionSimulatorEvents([
      { sessionId: "child" } as SubagentSession,
    ]);
    useEffect(() => {
      result = value;
    }, [value]);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(createElement(Harness)));
    expect(result!.loadState("child").status).toBe("error");
    await act(async () => {
      result!.loadState("child").retry();
      result!.loadState("child").retry();
    });
    expect(proxy.loadFromCache).toHaveBeenCalledTimes(2);
    expect(result!.loadState("child").status).toBe("ready");
    await act(async () => {
      Object.defineProperty(document, "hidden", {
        configurable: true,
        value: true,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await act(async () => result!.loadState("child").retry());
    expect(proxy.loadFromCache).toHaveBeenCalledTimes(2);
  } finally {
    act(() => root.unmount());
    delete env.IS_REACT_ACT_ENVIRONMENT;
  }
});

it("keeps stream updates that arrive while a baseline request is in flight", async () => {
  const env = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  env.IS_REACT_ACT_ENVIRONMENT = true;
  let finish: (snapshot: unknown) => void = () => {};
  proxy.loadFromCache.mockResolvedValue(1);
  proxy.getSnapshot.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  let result: ReturnType<typeof useMultiSessionSimulatorEvents> | undefined;
  function Harness() {
    const value = useMultiSessionSimulatorEvents([
      { sessionId: "child" } as SubagentSession,
    ]);
    useEffect(() => {
      result = value;
    }, [value]);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(createElement(Harness)));
    const receive = proxy.subscribeSession.mock.calls[0][1];
    const event = {
      id: "event",
      createdAt: "2026-09-07T00:00:00Z",
      displayText: "old",
    };
    await act(async () =>
      receive({
        streaming: true,
        simulatorEventUpserts: [{ ...event, displayText: "new" }],
      })
    );
    await act(async () => finish({ sortedSimulatorEvents: [event] }));
    expect(result!.eventsMap.get("child")?.[0].displayText).toBe("new");
    expect(proxy.getSnapshot).toHaveBeenCalledOnce();
  } finally {
    act(() => root.unmount());
    delete env.IS_REACT_ACT_ENVIRONMENT;
  }
});
