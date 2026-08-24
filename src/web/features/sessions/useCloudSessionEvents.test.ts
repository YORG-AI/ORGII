/** @vitest-environment jsdom */
import { Provider, createStore } from "jotai";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore";
import { org2CloudAuthAtom } from "@src/features/Org2Cloud/org2CloudAuthAtom";
import type { SessionEventSegmentsSnapshot } from "@src/features/TeamCollaboration/sync/CollabSyncBackend";
import { createSmokeRoot, dispatch } from "@src/test/reactSmokeHarness";

import { useCloudSessionEvents } from "./useCloudSessionEvents";
import type { WebSessionListItem } from "./useWebSessionRoster";

const mocks = vi.hoisted(() => ({
  getFreshSession: vi.fn(),
  readCache: vi.fn(),
  writeCache: vi.fn(),
  deleteCache: vi.fn(),
  canRead: vi.fn(),
  shouldFetch: vi.fn(),
  startPoller: vi.fn(),
  poll: null as null | (() => void | Promise<void>),
  stream: vi.fn(),
}));

vi.mock("../auth/useFreshWebCloudSession", () => ({
  useFreshWebCloudSession: () => mocks.getFreshSession,
}));

vi.mock("@src/features/Org2Cloud/org2CloudBackendAdapter", () => ({
  buildCloudSessionFetchClient: (
    _accessToken: string,
    _endpoint: unknown,
    options: {
      onTransferProgress?: (progress: {
        decodedEvents: number;
        totalEvents: number | null;
      }) => void;
    }
  ) => ({
    getSessionEventSegments: vi.fn(),
    streamSessionEventSegments: (
      input: unknown,
      onPage: (page: SessionEventSegmentsSnapshot) => Promise<void>
    ) => mocks.stream(input, onPage, options),
  }),
}));

vi.mock("./webCloudSessionEventCache", () => ({
  readWebCloudSessionEventCache: (...args: unknown[]) =>
    mocks.readCache(...args),
  writeWebCloudSessionEventCache: (...args: unknown[]) =>
    mocks.writeCache(...args),
  deleteWebCloudSessionEventCache: (...args: unknown[]) =>
    mocks.deleteCache(...args),
}));

vi.mock("./webCloudSessionCachePolicy", () => ({
  buildWebCloudSessionCacheKey: () => "cache-key",
  buildWebCloudSessionCacheKeyForIdentity: () => "cache-key",
  canReadWebCloudSessionEvents: (value: WebSessionListItem) =>
    mocks.canRead(value),
  shouldFetchWebCloudSessionEvents: (...args: unknown[]) =>
    mocks.shouldFetch(...args),
}));

vi.mock("@src/shared/scheduling/visibilityAwarePoller", () => ({
  startVisibilityAwarePoller: (...args: unknown[]) =>
    mocks.startPoller(...args),
}));

function event(id: string): SessionEvent {
  return { id } as SessionEvent;
}

function page(
  seq: number,
  ids: string[],
  count: number,
  isTail = false,
  summary?: { frozenSeq: number; tailHash: string | null }
): SessionEventSegmentsSnapshot {
  return {
    epoch: 1,
    frozenSeq: summary?.frozenSeq ?? (isTail ? seq - 1 : seq),
    tailHash: summary?.tailHash ?? (isTail ? `tail-${seq}` : null),
    count,
    segments: [
      {
        seq: isTail ? 0 : seq,
        isTail,
        events: ids.map(event),
        eventCount: ids.length,
        segmentHash: `segment-${seq}`,
      },
    ],
  };
}

function session(id: string, eventsCount = 4): WebSessionListItem {
  return {
    id,
    orgId: "org-1",
    orgName: "Org One",
    sourceSessionId: `source-${id}`,
    status: "stopped",
    eventsEpoch: 1,
    eventsCount,
    writable: false,
  } as WebSessionListItem;
}

function Probe({ value }: { value: WebSessionListItem }) {
  const result = useCloudSessionEvents(value);
  return React.createElement(
    "div",
    {
      "data-status": result.status,
      "data-progress": result.progress
        ? `${result.progress.loadedEvents}/${result.progress.totalEvents}`
        : "none",
    },
    React.createElement(
      "span",
      { "data-events": true },
      result.events.map((item) => item.id).join(",")
    ),
    React.createElement(
      "button",
      { "data-retry": true, onClick: () => void result.refresh() },
      "retry"
    )
  );
}

const AUTH = {
  kind: "org2_cloud" as const,
  supabaseUrl: "https://cloud.example.test",
  supabaseAnonKey: "anon",
  userId: "user-1",
  accessToken: "access",
  refreshToken: "refresh",
  expiresAt: 4_102_444_800,
};

describe("useCloudSessionEvents streaming", () => {
  const roots: Array<ReturnType<typeof createSmokeRoot>> = [];
  let store: ReturnType<typeof createStore>;

  const renderProbe = (
    root: ReturnType<typeof createSmokeRoot>,
    value: WebSessionListItem
  ) =>
    root.render(
      React.createElement(
        Provider,
        { store },
        React.createElement(Probe, { value })
      )
    );

  beforeEach(() => {
    store = createStore();
    store.set(org2CloudAuthAtom, AUTH);
    mocks.getFreshSession.mockReset().mockResolvedValue({
      accessToken: "token",
    });
    mocks.readCache.mockReset().mockResolvedValue(null);
    mocks.writeCache.mockReset().mockResolvedValue(undefined);
    mocks.deleteCache.mockReset().mockResolvedValue(undefined);
    mocks.canRead
      .mockReset()
      .mockImplementation(
        (value: WebSessionListItem) =>
          value.accessMode !== "metadata_only" &&
          value.eventsEpoch !== undefined
      );
    mocks.shouldFetch.mockReset().mockReturnValue(true);
    mocks.poll = null;
    mocks.startPoller
      .mockReset()
      .mockImplementation(
        (_document: Document, poll: () => void | Promise<void>) => {
          mocks.poll = poll;
          return vi.fn();
        }
      );
    mocks.stream.mockReset();
  });

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => root.unmount()));
  });

  it("publishes each decoded page before the full session finishes", async () => {
    let releaseFinalPage = () => {};
    const waitForFinalPage = new Promise<void>((resolve) => {
      releaseFinalPage = resolve;
    });
    mocks.stream.mockImplementation(
      async (
        _input,
        onPage: (value: SessionEventSegmentsSnapshot) => Promise<void>,
        options: {
          onTransferProgress?: (value: {
            decodedEvents: number;
            totalEvents: number | null;
          }) => void;
        }
      ) => {
        const summary = { frozenSeq: 1, tailHash: "tail-2" };
        options.onTransferProgress?.({ decodedEvents: 2, totalEvents: 4 });
        await onPage(page(1, ["one", "two"], 4, false, summary));
        await waitForFinalPage;
        options.onTransferProgress?.({ decodedEvents: 4, totalEvents: 4 });
        await onPage(page(2, ["three", "four"], 4, true, summary));
        return {
          epoch: 1,
          frozenSeq: 1,
          tailHash: "tail-2",
          count: 4,
        };
      }
    );

    const root = createSmokeRoot();
    roots.push(root);
    await renderProbe(root, session("session-1"));

    const probe = root.container.firstElementChild;
    expect(probe?.getAttribute("data-status")).toBe("loading");
    expect(probe?.getAttribute("data-progress")).toBe("2/4");
    expect(probe?.querySelector("[data-events]")?.textContent).toBe("one,two");

    await dispatch(releaseFinalPage);

    expect(probe?.getAttribute("data-status")).toBe("loaded");
    expect(probe?.getAttribute("data-progress")).toBe("none");
    expect(probe?.querySelector("[data-events]")?.textContent).toBe(
      "one,two,three,four"
    );
    expect(mocks.writeCache).toHaveBeenCalledOnce();
  });

  it("ignores a late page after the user switches sessions", async () => {
    let releaseOldSession = () => {};
    const oldSessionGate = new Promise<void>((resolve) => {
      releaseOldSession = resolve;
    });
    mocks.stream.mockImplementation(
      async (
        input: { sessionRowId: string },
        onPage: (value: SessionEventSegmentsSnapshot) => Promise<void>
      ) => {
        if (input.sessionRowId === "session-old") {
          await oldSessionGate;
          await onPage(page(1, ["stale"], 1, true));
        } else {
          await onPage(page(1, ["current"], 1, true));
        }
        return {
          epoch: 1,
          frozenSeq: 0,
          tailHash: "tail-1",
          count: 1,
        };
      }
    );

    const root = createSmokeRoot();
    roots.push(root);
    await renderProbe(root, session("session-old", 1));
    await renderProbe(root, session("session-new", 1));

    expect(root.container.querySelector("[data-events]")?.textContent).toBe(
      "current"
    );
    await dispatch(releaseOldSession);
    expect(root.container.querySelector("[data-events]")?.textContent).toBe(
      "current"
    );
  });

  it("keeps a partial page visible after failure and replaces it on retry", async () => {
    mocks.stream
      .mockImplementationOnce(
        async (
          _input,
          onPage: (value: SessionEventSegmentsSnapshot) => Promise<void>
        ) => {
          await onPage(page(1, ["partial"], 2));
          throw new Error("network interrupted");
        }
      )
      .mockImplementationOnce(
        async (
          _input,
          onPage: (value: SessionEventSegmentsSnapshot) => Promise<void>
        ) => {
          await onPage(page(1, ["complete-a", "complete-b"], 2, true));
          return {
            epoch: 1,
            frozenSeq: 0,
            tailHash: "tail-1",
            count: 2,
          };
        }
      );

    const root = createSmokeRoot();
    roots.push(root);
    await renderProbe(root, session("session-retry", 2));

    const probe = root.container.firstElementChild;
    expect(probe?.getAttribute("data-status")).toBe("error");
    expect(probe?.querySelector("[data-events]")?.textContent).toBe("partial");

    await dispatch(() =>
      root.container.querySelector<HTMLButtonElement>("[data-retry]")?.click()
    );

    expect(probe?.getAttribute("data-status")).toBe("loaded");
    expect(probe?.querySelector("[data-events]")?.textContent).toBe(
      "complete-a,complete-b"
    );
  });

  it("hides and evicts a transcript immediately after permission downgrade", async () => {
    mocks.stream.mockImplementation(
      async (
        _input,
        onPage: (value: SessionEventSegmentsSnapshot) => Promise<void>
      ) => {
        await onPage(page(1, ["private-event"], 1, true));
        return {
          epoch: 1,
          frozenSeq: 0,
          tailHash: "tail-1",
          count: 1,
        };
      }
    );
    const root = createSmokeRoot();
    roots.push(root);
    const readable = session("session-private", 1);
    await renderProbe(root, readable);
    expect(root.container.querySelector("[data-events]")?.textContent).toBe(
      "private-event"
    );

    mocks.getFreshSession.mockClear().mockResolvedValue(null);
    await renderProbe(root, {
      ...readable,
      accessMode: "metadata_only",
      eventsEpoch: undefined,
      eventsCount: undefined,
    });

    expect(root.container.querySelector("[data-events]")?.textContent).toBe("");
    expect(root.container.firstElementChild?.getAttribute("data-status")).toBe(
      "loaded"
    );
    expect(mocks.stream).toHaveBeenCalledOnce();
    expect(mocks.getFreshSession).not.toHaveBeenCalled();
    expect(mocks.deleteCache).toHaveBeenCalledWith("cache-key");
  });

  it("bypasses a fresh cache during the running-session safety poll", async () => {
    const cachedSnapshot = {
      epoch: 1,
      frozenSeq: 0,
      tailHash: "tail-1",
      count: 1,
      segments: [],
      events: [event("cached")],
    };
    mocks.readCache
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ snapshot: cachedSnapshot });
    mocks.shouldFetch.mockReturnValue(false);
    mocks.stream.mockImplementation(
      async (
        _input,
        onPage: (value: SessionEventSegmentsSnapshot) => Promise<void>
      ) => {
        const id = mocks.stream.mock.calls.length === 1 ? "initial" : "polled";
        await onPage(page(1, [id], 1, true));
        return {
          epoch: 1,
          frozenSeq: 0,
          tailHash: `tail-${id}`,
          count: 1,
        };
      }
    );
    const root = createSmokeRoot();
    roots.push(root);
    await renderProbe(root, {
      ...session("session-running", 1),
      status: "running",
    });
    expect(mocks.stream).toHaveBeenCalledOnce();
    expect(mocks.poll).not.toBeNull();

    await React.act(async () => {
      await mocks.poll?.();
    });

    expect(mocks.stream).toHaveBeenCalledTimes(2);
    expect(root.container.querySelector("[data-events]")?.textContent).toBe(
      "polled"
    );
  });

  it("keeps the last complete transcript when a background poll loses its tail", async () => {
    mocks.stream
      .mockImplementationOnce(
        async (
          _input,
          onPage: (value: SessionEventSegmentsSnapshot) => Promise<void>
        ) => {
          const summary = { frozenSeq: 1, tailHash: "old-tail" };
          await onPage(page(1, ["old-frozen"], 2, false, summary));
          await onPage(page(2, ["old-tail"], 2, true, summary));
          return {
            epoch: 1,
            frozenSeq: 1,
            tailHash: "old-tail",
            count: 2,
          };
        }
      )
      .mockImplementationOnce(
        async (
          _input,
          onPage: (value: SessionEventSegmentsSnapshot) => Promise<void>
        ) => {
          await onPage(
            page(2, ["new-frozen"], 3, false, {
              frozenSeq: 2,
              tailHash: "new-tail",
            })
          );
          throw new Error("tail page interrupted");
        }
      );
    const root = createSmokeRoot();
    roots.push(root);
    await renderProbe(root, {
      ...session("session-running-failure", 2),
      status: "running",
    });
    expect(root.container.querySelector("[data-events]")?.textContent).toBe(
      "old-frozen,old-tail"
    );

    await React.act(async () => {
      await mocks.poll?.();
    });

    expect(root.container.firstElementChild?.getAttribute("data-status")).toBe(
      "error"
    );
    expect(root.container.querySelector("[data-events]")?.textContent).toBe(
      "old-frozen,old-tail"
    );
  });
});
