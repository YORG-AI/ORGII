import { createStore } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { IMPORTED_HISTORY_SOURCES } from "@src/api/tauri/externalHistory";

import {
  dataSourceConfigAtom,
  externalSessionsEnabledAtom,
} from "../../dataSourceConfigAtom";
import {
  sessionLastLoadedAtom,
  sessionLoadingAtom,
  sessionsAtom,
} from "../atoms";
import {
  __TESTS_ONLY,
  loadMoreCategory,
  loadSessions,
  loadSidebarSessionById,
  loadSidebarSessions,
} from "../loaders";
import { sessionPaginationAtom } from "../paginationAtoms";

const mocks = vi.hoisted(() => ({
  externalHistorySidebarList: vi.fn(),
  sessionAggregateList: vi.fn(),
  persistSessions: vi.fn(),
  store: undefined as ReturnType<typeof createStore> | undefined,
}));

vi.mock("@src/api/tauri/session", () => ({
  externalHistorySidebarList: mocks.externalHistorySidebarList,
  sessionAggregateList: mocks.sessionAggregateList,
  toFrontendSessions: (sessions: unknown[]) => sessions,
}));

vi.mock("@src/util/core/state/instrumentedStore", () => ({
  getInstrumentedStore: () => {
    if (!mocks.store) throw new Error("Test store not initialized");
    return mocks.store;
  },
}));

vi.mock("../persistence", () => ({
  loadPersistedSessions: () => [],
  persistSessions: mocks.persistSessions,
}));

function makeRow(sessionId: string, updatedAt: string) {
  return {
    sessionId,
    name: sessionId,
    createdAt: updatedAt,
    updatedAt,
    repoPath: "/tmp/project",
    storagePath: `/tmp/store/${sessionId}.jsonl`,
  };
}

describe("loadSidebarSessions", () => {
  beforeEach(() => {
    mocks.store = createStore();
    mocks.externalHistorySidebarList.mockReset();
    mocks.sessionAggregateList.mockReset();
    mocks.persistSessions.mockReset();
  });

  it("loads an independent initial page for every external-history source", async () => {
    mocks.sessionAggregateList.mockResolvedValue({ sessions: [] });
    mocks.externalHistorySidebarList.mockImplementation(
      async (request: {
        requests: Array<{
          source: string;
          buckets: Array<{ bucket: string; limit: number; offset: number }>;
        }>;
      }) => {
        return {
          sources: request.requests.map((sourceRequest) => {
            const source = IMPORTED_HISTORY_SOURCES.find(
              (candidate) => candidate.sourceId === sourceRequest.source
            );
            if (!source) throw new Error("unknown source");
            return {
              source: sourceRequest.source,
              buckets: sourceRequest.buckets.map(({ bucket, offset }) => ({
                bucket,
                sessions:
                  bucket === "today"
                    ? Array.from({ length: 10 }, (_, index) =>
                        makeRow(
                          `${source.prefix}today-${offset + index}`,
                          "2026-07-12T12:00:00Z"
                        )
                      )
                    : bucket === "yesterday"
                      ? [
                          makeRow(
                            `${source.prefix}yesterday`,
                            "2026-07-11T12:00:00Z"
                          ),
                        ]
                      : [],
                hasMore: bucket === "today",
              })),
            };
          }),
        };
      }
    );

    await loadSidebarSessions({ forceRefresh: true, pageSize: 10 });

    expect(mocks.externalHistorySidebarList).toHaveBeenCalledTimes(1);
    const externalRequest = mocks.externalHistorySidebarList.mock
      .calls[0][0] as {
      requests: Array<{
        source: string;
        buckets: Array<{ limit: number; offset: number }>;
      }>;
    };
    expect(externalRequest.requests.map(({ source }) => source).sort()).toEqual(
      IMPORTED_HISTORY_SOURCES.map((source) => source.sourceId).sort()
    );
    expect(
      externalRequest.requests.every(
        (request) =>
          request.buckets.length === 4 &&
          request.buckets.every(
            (bucket: { limit: number; offset: number }) =>
              bucket.limit === 10 && bucket.offset === 0
          )
      )
    ).toBe(true);
    expect(
      mocks.sessionAggregateList.mock.calls.some(
        ([filter]) => filter.category === "external_history"
      )
    ).toBe(false);

    const loaded = mocks.store?.get(sessionsAtom) ?? [];
    const loadedIds = new Set(loaded.map((session) => session.session_id));
    // Imported sessions live only in the source app's own store, so the
    // sidebar row is the hover card's only chance at a storage path.
    expect(
      loaded.every(
        (session) =>
          session.storagePath === `/tmp/store/${session.session_id}.jsonl`
      )
    ).toBe(true);
    for (const source of IMPORTED_HISTORY_SOURCES) {
      expect(loadedIds).toContain(`${source.prefix}yesterday`);
      expect(
        mocks.store?.get(sessionPaginationAtom)[source.listCategory].loaded
      ).toBe(11);
      expect(
        mocks.store?.get(sessionPaginationAtom)[source.listCategory].dateBuckets
          ?.yesterday
      ).toEqual({ loaded: 1, hasMore: false });
    }
  });

  it("shares one in-flight initial load between concurrent consumers", async () => {
    let releaseExternalHistory!: () => void;
    const externalHistoryPending = new Promise<void>((resolve) => {
      releaseExternalHistory = resolve;
    });
    mocks.sessionAggregateList.mockResolvedValue({ sessions: [] });
    mocks.externalHistorySidebarList.mockImplementation(
      async (request: {
        requests: Array<{
          source: string;
          buckets: Array<{ bucket: string }>;
        }>;
      }) => {
        await externalHistoryPending;
        return {
          sources: request.requests.map((sourceRequest) => ({
            source: sourceRequest.source,
            buckets: sourceRequest.buckets.map(({ bucket }) => ({
              bucket,
              sessions: [],
              hasMore: false,
            })),
          })),
        };
      }
    );

    const firstLoad = loadSidebarSessions({ forceRefresh: true });
    const secondLoad = loadSidebarSessions({ forceRefresh: true });
    const thirdLoad = loadSidebarSessions();

    expect(mocks.sessionAggregateList).toHaveBeenCalledTimes(2);
    expect(mocks.externalHistorySidebarList).toHaveBeenCalledTimes(1);

    releaseExternalHistory();
    await Promise.all([firstLoad, secondLoad, thirdLoad]);
    expect(mocks.persistSessions).toHaveBeenCalledTimes(1);
  });

  it("does not let a cache hit suppress a same-tick forced refresh", async () => {
    mocks.store?.set(sessionLastLoadedAtom, Date.now());
    mocks.sessionAggregateList.mockResolvedValue({ sessions: [] });
    mocks.externalHistorySidebarList.mockImplementation(
      async (request: {
        requests: Array<{
          source: string;
          buckets: Array<{ bucket: string }>;
        }>;
      }) => ({
        sources: request.requests.map((sourceRequest) => ({
          source: sourceRequest.source,
          buckets: sourceRequest.buckets.map(({ bucket }) => ({
            bucket,
            sessions: [],
            hasMore: false,
          })),
        })),
      })
    );

    const cachedLoad = loadSidebarSessions();
    const forcedLoad = loadSidebarSessions({ forceRefresh: true });
    await Promise.all([cachedLoad, forcedLoad]);

    expect(mocks.sessionAggregateList).toHaveBeenCalledTimes(2);
    expect(mocks.externalHistorySidebarList).toHaveBeenCalledTimes(1);
  });

  it("shares one flat-list request between concurrent hook consumers", async () => {
    let release!: (value: { sessions: unknown[] }) => void;
    mocks.sessionAggregateList.mockImplementation(
      () =>
        new Promise<{ sessions: unknown[] }>((resolve) => {
          release = resolve;
        })
    );

    const first = loadSessions();
    const second = loadSessions();

    expect(mocks.sessionAggregateList).toHaveBeenCalledTimes(1);
    release({ sessions: [] });
    await Promise.all([first, second]);
    expect(mocks.persistSessions).toHaveBeenCalledTimes(1);
  });

  it("runs one forced flat-list refresh after an active non-forced load", async () => {
    let releaseFirst!: (value: { sessions: unknown[] }) => void;
    const staleSession = {
      session_id: "stale",
      name: "Stale",
      status: "completed" as const,
      created_at: "2026-07-01T00:00:00Z",
      updated_at: "2026-07-01T00:00:00Z",
    };
    const freshSession = {
      ...staleSession,
      session_id: "fresh",
      name: "Fresh",
      updated_at: "2026-07-02T00:00:00Z",
    };
    mocks.sessionAggregateList
      .mockImplementationOnce(
        () =>
          new Promise<{ sessions: unknown[] }>((resolve) => {
            releaseFirst = resolve;
          })
      )
      .mockResolvedValueOnce({ sessions: [freshSession] });

    const first = loadSessions();
    const forced = loadSessions({ forceRefresh: true });

    expect(mocks.sessionAggregateList).toHaveBeenCalledTimes(1);
    releaseFirst({ sessions: [staleSession] });
    await first;
    await forced;

    expect(mocks.sessionAggregateList).toHaveBeenCalledTimes(2);
    expect(mocks.store?.get(sessionsAtom)).toEqual([freshSession]);
    expect(mocks.persistSessions).toHaveBeenCalledTimes(1);
    expect(mocks.store?.get(sessionLoadingAtom)).toBe(false);
  });

  it("treats external-source configuration as part of the flat-list scope", async () => {
    let releaseFirst!: (value: { sessions: unknown[] }) => void;
    mocks.sessionAggregateList
      .mockImplementationOnce(
        () =>
          new Promise<{ sessions: unknown[] }>((resolve) => {
            releaseFirst = resolve;
          })
      )
      .mockResolvedValueOnce({ sessions: [] });

    const first = loadSessions();
    mocks.store?.set(externalSessionsEnabledAtom, false);
    const changedScope = loadSessions();

    releaseFirst({ sessions: [] });
    await Promise.all([first, changedScope]);

    expect(mocks.sessionAggregateList).toHaveBeenCalledTimes(2);
    expect(mocks.sessionAggregateList).toHaveBeenLastCalledWith(
      expect.objectContaining({ includeExternalHistory: false })
    );
  });

  it("runs a trailing load when the data-source scope changes in flight", async () => {
    let releaseFirstLoad!: () => void;
    const firstLoadPending = new Promise<void>((resolve) => {
      releaseFirstLoad = resolve;
    });
    mocks.sessionAggregateList.mockResolvedValue({ sessions: [] });
    mocks.externalHistorySidebarList.mockImplementation(
      async (request: {
        requests: Array<{
          source: string;
          buckets: Array<{ bucket: string }>;
        }>;
      }) => {
        await firstLoadPending;
        return {
          sources: request.requests.map((sourceRequest) => ({
            source: sourceRequest.source,
            buckets: sourceRequest.buckets.map(({ bucket }) => ({
              bucket,
              sessions: [],
              hasMore: false,
            })),
          })),
        };
      }
    );

    const firstLoad = loadSidebarSessions({ forceRefresh: true });
    mocks.store?.set(dataSourceConfigAtom, {
      warp: { enabled: false, frequency: "default", lastScannedAt: null },
    });
    const changedScopeLoad = loadSidebarSessions({ forceRefresh: true });

    expect(mocks.externalHistorySidebarList).toHaveBeenCalledTimes(1);
    releaseFirstLoad();
    await Promise.all([firstLoad, changedScopeLoad]);

    expect(mocks.sessionAggregateList).toHaveBeenCalledTimes(4);
    expect(mocks.externalHistorySidebarList).toHaveBeenCalledTimes(2);
    const trailingSources =
      mocks.externalHistorySidebarList.mock.calls[1][0].requests.map(
        ({ source }: { source: string }) => source
      );
    expect(trailingSources).not.toContain("warp");
  });

  it("continues each external date bucket from its own offset", async () => {
    mocks.sessionAggregateList.mockResolvedValue({ sessions: [] });
    mocks.externalHistorySidebarList.mockImplementation(
      async (request: {
        requests: Array<{
          source: string;
          buckets: Array<{ bucket: string; offset: number }>;
        }>;
      }) => ({
        sources: request.requests.map((sourceRequest) => ({
          source: sourceRequest.source,
          buckets: sourceRequest.buckets.map(({ bucket, offset }) => ({
            bucket,
            sessions: [
              makeRow(
                `${sourceRequest.source}-${bucket}-${offset}`,
                "2026-07-12T12:00:00Z"
              ),
            ],
            hasMore: bucket === "today" && offset === 0,
          })),
        })),
      })
    );

    await loadSidebarSessions({ forceRefresh: true, pageSize: 10 });
    const codexCategory = "external_history:codex_app" as const;
    await loadMoreCategory(codexCategory, 10);

    const lastRequest = mocks.externalHistorySidebarList.mock.calls.at(-1)?.[0];
    expect(lastRequest.requests).toHaveLength(1);
    expect(lastRequest.requests[0].source).toBe("codex_app");
    expect(lastRequest.requests[0].buckets).toEqual([
      expect.objectContaining({ bucket: "today", offset: 1, limit: 10 }),
    ]);
  });

  it("gates a disabled Warp source out of sidebar loading", async () => {
    mocks.store?.set(dataSourceConfigAtom, {
      warp: { enabled: false, frequency: "default", lastScannedAt: null },
    });
    mocks.sessionAggregateList.mockResolvedValue({ sessions: [] });
    mocks.externalHistorySidebarList.mockImplementation(
      async (request: {
        requests: Array<{
          source: string;
          buckets: Array<{ bucket: string }>;
        }>;
      }) => ({
        sources: request.requests.map((sourceRequest) => ({
          source: sourceRequest.source,
          buckets: sourceRequest.buckets.map(({ bucket }) => ({
            bucket,
            sessions: [],
            hasMore: false,
          })),
        })),
      })
    );

    await loadSidebarSessions({ forceRefresh: true, pageSize: 10 });

    expect(mocks.externalHistorySidebarList).toHaveBeenCalledTimes(1);
    const requestedSources =
      mocks.externalHistorySidebarList.mock.calls[0][0].requests.map(
        ({ source }: { source: string }) => source
      );
    expect(requestedSources).not.toContain("warp");
    expect(requestedSources).toHaveLength(IMPORTED_HISTORY_SOURCES.length - 1);
  });

  it("hydrates one historical session by canonical ID without paging", async () => {
    const historicalSession = {
      session_id: "codexapp-rollout-historical",
      name: "Historical Codex session",
      status: "completed",
      created_at: "2026-06-01T12:00:00Z",
      updated_at: "2026-06-01T13:00:00Z",
    };
    mocks.sessionAggregateList.mockResolvedValue({
      sessions: [historicalSession],
    });

    const loaded = await loadSidebarSessionById("codexapp-rollout-historical");

    expect(loaded).toEqual(historicalSession);
    expect(mocks.sessionAggregateList).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionIds: ["codexapp-rollout-historical"],
        includeExternalHistory: true,
        limit: 1,
      })
    );
    expect(mocks.sessionAggregateList.mock.calls[0]?.[0]).not.toHaveProperty(
      "disabledExternalHistorySources"
    );
    expect(mocks.externalHistorySidebarList).not.toHaveBeenCalled();
    expect(mocks.store?.get(sessionsAtom)).toContainEqual(historicalSession);
  });

  it("enriches an existing lightweight child with canonical parent metadata", async () => {
    const lightweightChild = {
      session_id: "codexapp-rollout-child",
      name: "Codex child",
      status: "completed",
      created_at: "2026-07-15T12:00:00Z",
      updated_at: "2026-07-15T12:01:00Z",
    };
    const canonicalChild = {
      ...lightweightChild,
      parentSessionId: "codexapp-rollout-root",
    };
    mocks.store?.set(sessionsAtom, [lightweightChild]);
    mocks.sessionAggregateList.mockResolvedValue({
      sessions: [canonicalChild],
    });

    const loaded = await loadSidebarSessionById(lightweightChild.session_id);

    expect(loaded).toEqual(canonicalChild);
    expect(mocks.sessionAggregateList).toHaveBeenCalledWith(
      expect.objectContaining({ sessionIds: [lightweightChild.session_id] })
    );
    expect(mocks.store?.get(sessionsAtom)).toContainEqual(canonicalChild);
  });

  it("does not erase an exact-loaded child during a provider first-page refresh", () => {
    const codex = IMPORTED_HISTORY_SOURCES.find(
      (source) => source.sourceId === "codex_app"
    );
    expect(codex).toBeTruthy();
    if (!codex) return;

    const oldRoot = {
      session_id: "codexapp-old-root",
      name: "Old root",
      status: "completed" as const,
      created_at: "2026-07-01T00:00:00Z",
      updated_at: "2026-07-01T00:00:00Z",
    };
    const exactChild = {
      ...oldRoot,
      session_id: "codexapp-exact-child",
      name: "Exact child",
      parentSessionId: "codexapp-current-root",
    };
    const currentRoot = {
      ...oldRoot,
      session_id: "codexapp-current-root",
      name: "Current root",
      updated_at: "2026-07-14T00:00:00Z",
    };

    const replaced = __TESTS_ONLY.replaceExternalHistorySourceFirstPage(
      [oldRoot, exactChild],
      [currentRoot],
      codex
    );

    expect(replaced.map((session) => session.session_id)).toEqual([
      "codexapp-current-root",
      "codexapp-exact-child",
    ]);

    const disabled = __TESTS_ONLY.replaceExternalHistorySourceFirstPage(
      replaced,
      [],
      codex,
      false
    );
    expect(disabled).toEqual([]);
  });
});
