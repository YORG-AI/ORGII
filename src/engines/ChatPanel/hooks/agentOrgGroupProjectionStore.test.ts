// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  GROUP_PROJECTION_CACHE_TTL_MS,
  GROUP_PROJECTION_MAX_INACTIVE_RUNS,
  GROUP_PROJECTION_MAX_PAGES,
  GROUP_PROJECTION_PUSH_DEBOUNCE_MS,
  agentOrgGroupProjectionStoreTestApi,
  getAgentOrgGroupProjectionSnapshot,
  loadOlderAgentOrgGroupProjection,
  refreshAgentOrgGroupProjection,
  subscribeAgentOrgGroupProjection,
} from "./agentOrgGroupProjectionStore";

const mocks = vi.hoisted(() => ({
  getPage: vi.fn(),
  stateSubscriber: null as ((sessionId: string) => void) | null,
  socketHandlers: new Map<string, (event: never) => void>(),
}));

vi.mock("@src/api/tauri/agent", () => ({
  getAgentOrgGroupProjectionPage: mocks.getPage,
  subscribeAgentOrgStateChanges: vi.fn(
    (subscriber: (sessionId: string) => void) => {
      mocks.stateSubscriber = subscriber;
      return () => {
        if (mocks.stateSubscriber === subscriber) mocks.stateSubscriber = null;
      };
    }
  ),
}));

vi.mock("@src/api/realtime/codeEditorWebSocket", () => ({
  getCodeEditorWebSocket: () => ({
    on: (name: string, handler: (event: never) => void) => {
      mocks.socketHandlers.set(name, handler);
      return () => mocks.socketHandlers.delete(name);
    },
  }),
}));

function page(
  id: string,
  options: { hasMore?: boolean; cursor?: string; runId?: string } = {}
) {
  const [, sourceId = "0", itemOrdinal = "0"] = id.split(":");
  return {
    runId: options.runId ?? "run-1",
    items: [
      {
        id,
        kind: "user_message" as const,
        order: {
          createdAt: "2026-01-01T00:00:00Z",
          sourceRank: 20,
          stableSourceId: sourceId.padStart(20, "0"),
          itemOrdinal: Number(itemOrdinal),
        },
        turnIntentId: `turn-${id}`,
        route: "member" as const,
        targetMemberId: "reviewer",
        targetName: "Reviewer",
        sourceRef: { kind: "inbox" as const, id: 1 },
        text: id,
        createdAt: "2026-01-01T00:00:00Z",
        state: "queued" as const,
        canStop: true,
      },
    ],
    hasMore: options.hasMore ?? false,
    nextCursor: options.cursor,
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("agentOrgGroupProjectionStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    for (const runId of Array.from(
      agentOrgGroupProjectionStoreTestApi.entries.keys()
    )) {
      agentOrgGroupProjectionStoreTestApi.disposeAgentOrgGroupProjection(runId);
    }
    mocks.getPage.mockReset();
    mocks.stateSubscriber = null;
    mocks.socketHandlers.clear();
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
  });

  it("shares one run-level request across subscribers", async () => {
    let resolvePage: (value: ReturnType<typeof page>) => void = () => undefined;
    mocks.getPage.mockReturnValue(
      new Promise((resolve) => {
        resolvePage = resolve;
      })
    );
    const unsubscribeA = subscribeAgentOrgGroupProjection(
      "run-1",
      "root-1",
      vi.fn()
    );
    const unsubscribeB = subscribeAgentOrgGroupProjection(
      "run-1",
      "root-1",
      vi.fn()
    );
    expect(mocks.getPage).toHaveBeenCalledTimes(1);
    resolvePage(page("group:1:0"));
    await settle();
    expect(getAgentOrgGroupProjectionSnapshot("run-1").items).toHaveLength(1);
    unsubscribeA();
    unsubscribeB();
  });

  it("orders server identities exactly beyond JavaScript safe integers", () => {
    const older = page("group:9007199254740992:1").items[0];
    const newer = page("group:9007199254740993:0").items[0];

    expect(
      agentOrgGroupProjectionStoreTestApi
        .mergeItems([], [newer, older])
        .items.map((item) => item.id)
    ).toEqual([older.id, newer.id]);
  });

  it("does not lose a push that arrives during an in-flight refresh", async () => {
    let resolveFirst: (value: ReturnType<typeof page>) => void = () =>
      undefined;
    mocks.getPage
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFirst = resolve;
        })
      )
      .mockResolvedValueOnce(page("group:2:0"));
    const unsubscribe = subscribeAgentOrgGroupProjection(
      "run-1",
      "root-1",
      vi.fn()
    );

    mocks.stateSubscriber?.("root-1");
    await vi.advanceTimersByTimeAsync(GROUP_PROJECTION_PUSH_DEBOUNCE_MS);
    expect(mocks.getPage).toHaveBeenCalledTimes(1);

    resolveFirst(page("group:1:0"));
    await settle();
    await vi.advanceTimersByTimeAsync(GROUP_PROJECTION_PUSH_DEBOUNCE_MS);
    await settle();

    expect(mocks.getPage).toHaveBeenCalledTimes(2);
    expect(
      getAgentOrgGroupProjectionSnapshot("run-1").items.map((item) => item.id)
    ).toEqual(["group:1:0", "group:2:0"]);
    unsubscribe();
  });

  it("makes an explicit read-back wait for one post-mutation refresh", async () => {
    let resolveFirst: (value: ReturnType<typeof page>) => void = () =>
      undefined;
    mocks.getPage
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFirst = resolve;
        })
      )
      .mockResolvedValueOnce(page("group:2:0"));
    const unsubscribe = subscribeAgentOrgGroupProjection(
      "run-1",
      "root-1",
      vi.fn()
    );

    const readBack = refreshAgentOrgGroupProjection("run-1");
    resolveFirst(page("group:1:0"));
    await readBack;

    expect(mocks.getPage).toHaveBeenCalledTimes(2);
    expect(
      getAgentOrgGroupProjectionSnapshot("run-1").items.map((item) => item.id)
    ).toEqual(["group:1:0", "group:2:0"]);
    unsubscribe();
  });

  it("coalesces pushes and performs no hidden refresh", async () => {
    mocks.getPage.mockResolvedValueOnce(page("group:1:0"));
    const unsubscribe = subscribeAgentOrgGroupProjection(
      "run-1",
      "root-1",
      vi.fn()
    );
    await settle();
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    mocks.stateSubscriber?.("root-1");
    mocks.stateSubscriber?.("root-1");
    await vi.advanceTimersByTimeAsync(GROUP_PROJECTION_PUSH_DEBOUNCE_MS * 2);
    expect(mocks.getPage).toHaveBeenCalledTimes(1);

    mocks.getPage.mockResolvedValueOnce(page("group:2:0"));
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(GROUP_PROJECTION_PUSH_DEBOUNCE_MS);
    await settle();
    expect(mocks.getPage).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("cancels a scheduled refresh when the document becomes hidden", async () => {
    mocks.getPage.mockResolvedValueOnce(page("group:1:0"));
    const unsubscribe = subscribeAgentOrgGroupProjection(
      "run-1",
      "root-1",
      vi.fn()
    );
    await settle();

    mocks.stateSubscriber?.("root-1");
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(GROUP_PROJECTION_PUSH_DEBOUNCE_MS * 2);
    expect(mocks.getPage).toHaveBeenCalledTimes(1);

    mocks.getPage.mockResolvedValueOnce(page("group:2:0"));
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(GROUP_PROJECTION_PUSH_DEBOUNCE_MS);
    await settle();
    expect(mocks.getPage).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("coalesces focus and reconnect revalidation and preserves old items on failure", async () => {
    mocks.getPage.mockResolvedValueOnce(page("group:1:0"));
    const unsubscribe = subscribeAgentOrgGroupProjection(
      "run-1",
      "root-1",
      vi.fn()
    );
    await settle();
    mocks.getPage.mockRejectedValueOnce(new Error("bounded refresh failed"));

    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("focus"));
    mocks.socketHandlers.get("connected")?.({} as never);
    await vi.advanceTimersByTimeAsync(GROUP_PROJECTION_PUSH_DEBOUNCE_MS);
    await settle();

    expect(mocks.getPage).toHaveBeenCalledTimes(2);
    expect(
      getAgentOrgGroupProjectionSnapshot("run-1").items.map((item) => item.id)
    ).toEqual(["group:1:0"]);
    expect(getAgentOrgGroupProjectionSnapshot("run-1").error).toBe(
      "bounded refresh failed"
    );
    unsubscribe();
  });

  it("revalidates a retained TTL snapshot when the run is reopened", async () => {
    mocks.getPage
      .mockResolvedValueOnce(page("group:1:0"))
      .mockResolvedValueOnce(page("group:2:0"));
    const unsubscribeFirst = subscribeAgentOrgGroupProjection(
      "run-1",
      "root-1",
      vi.fn()
    );
    await settle();
    unsubscribeFirst();

    const unsubscribeSecond = subscribeAgentOrgGroupProjection(
      "run-1",
      "root-1",
      vi.fn()
    );
    await settle();

    expect(mocks.getPage).toHaveBeenCalledTimes(2);
    expect(
      getAgentOrgGroupProjectionSnapshot("run-1").items.map((item) => item.id)
    ).toEqual(["group:1:0", "group:2:0"]);
    unsubscribeSecond();
  });

  it("rejects a late response after zero-subscriber disposal", async () => {
    let resolveOld: (value: ReturnType<typeof page>) => void = () => undefined;
    mocks.getPage.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveOld = resolve;
      })
    );
    const unsubscribe = subscribeAgentOrgGroupProjection(
      "run-1",
      "root-1",
      vi.fn()
    );
    unsubscribe();
    await vi.advanceTimersByTimeAsync(GROUP_PROJECTION_CACHE_TTL_MS);
    expect(agentOrgGroupProjectionStoreTestApi.entries.size).toBe(0);

    mocks.getPage.mockResolvedValueOnce(page("group:2:0"));
    const unsubscribeNew = subscribeAgentOrgGroupProjection(
      "run-1",
      "root-1",
      vi.fn()
    );
    await settle();
    resolveOld(page("group:1:0"));
    await settle();
    expect(
      getAgentOrgGroupProjectionSnapshot("run-1").items.map((item) => item.id)
    ).toEqual(["group:2:0"]);
    unsubscribeNew();
  });

  it("releases listeners, entries, and timers after repeated open/close", async () => {
    mocks.getPage.mockResolvedValue(page("group:1:0"));
    for (let index = 0; index < 20; index += 1) {
      const unsubscribe = subscribeAgentOrgGroupProjection(
        "run-1",
        "root-1",
        vi.fn()
      );
      await settle();
      unsubscribe();
    }
    await vi.advanceTimersByTimeAsync(GROUP_PROJECTION_CACHE_TTL_MS);
    expect(agentOrgGroupProjectionStoreTestApi.entries.size).toBe(0);
    expect(mocks.stateSubscriber).toBeNull();
    expect(mocks.socketHandlers.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops older-page reads at the retained page budget", async () => {
    let requestIndex = 0;
    mocks.getPage.mockImplementation(async () => {
      requestIndex += 1;
      return page(`group:${requestIndex}:0`, {
        hasMore: true,
        cursor: `cursor-${requestIndex}`,
      });
    });
    const unsubscribe = subscribeAgentOrgGroupProjection(
      "run-1",
      "root-1",
      vi.fn()
    );
    await settle();

    for (let index = 0; index < GROUP_PROJECTION_MAX_PAGES + 5; index += 1) {
      await loadOlderAgentOrgGroupProjection("run-1");
    }

    expect(mocks.getPage).toHaveBeenCalledTimes(GROUP_PROJECTION_MAX_PAGES);
    expect(getAgentOrgGroupProjectionSnapshot("run-1").items).toHaveLength(
      GROUP_PROJECTION_MAX_PAGES
    );
    expect(getAgentOrgGroupProjectionSnapshot("run-1").hasMore).toBe(false);
    unsubscribe();
  });

  it("evicts inactive runs above the global cache bound without touching active runs", async () => {
    mocks.getPage.mockImplementation(
      async ({ sessionId }: { sessionId: string }) =>
        page(`group:${sessionId}:0`, { runId: sessionId })
    );
    const unsubscribeActive = subscribeAgentOrgGroupProjection(
      "active-run",
      "active-run",
      vi.fn()
    );
    await settle();

    for (
      let index = 0;
      index < GROUP_PROJECTION_MAX_INACTIVE_RUNS + 3;
      index += 1
    ) {
      const runId = `inactive-${index}`;
      const unsubscribe = subscribeAgentOrgGroupProjection(
        runId,
        runId,
        vi.fn()
      );
      await settle();
      unsubscribe();
    }

    expect(agentOrgGroupProjectionStoreTestApi.entries.has("active-run")).toBe(
      true
    );
    expect(
      agentOrgGroupProjectionStoreTestApi.entries.size
    ).toBeLessThanOrEqual(GROUP_PROJECTION_MAX_INACTIVE_RUNS + 1);
    unsubscribeActive();
    await vi.advanceTimersByTimeAsync(GROUP_PROJECTION_CACHE_TTL_MS);
    expect(agentOrgGroupProjectionStoreTestApi.entries.size).toBe(0);
  });
});
