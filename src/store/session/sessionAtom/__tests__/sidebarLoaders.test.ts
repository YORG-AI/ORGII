import { createStore } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { IMPORTED_HISTORY_SOURCES } from "@src/api/tauri/externalHistory";

import { dataSourceConfigAtom } from "../../dataSourceConfigAtom";
import { sessionsAtom } from "../atoms";
import {
  __TESTS_ONLY,
  loadMoreCategory,
  loadSessionRoster,
  loadSidebarSessionById,
  loadSidebarSessions,
  loadSidebarSessionsByIds,
  refreshRecentNativeSessions,
  registerNewNativeSidebarSession,
  syncSidebarSessionRoster,
} from "../loaders";
import { sessionPaginationAtom } from "../paginationAtoms";

const mocks = vi.hoisted(() => ({
  externalHistorySidebarList: vi.fn(),
  nativeSidebarSessionPage: vi.fn(),
  sessionAggregateList: vi.fn(),
  persistSessions: vi.fn(),
  store: undefined as ReturnType<typeof createStore> | undefined,
}));

vi.mock("@src/api/tauri/session", () => ({
  externalHistorySidebarList: mocks.externalHistorySidebarList,
  nativeSidebarSessionPage: mocks.nativeSidebarSessionPage,
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

function makeRow(
  sessionId: string,
  updatedAt: string,
  continuationLineageId?: string
) {
  return {
    sessionId,
    name: sessionId,
    createdAt: updatedAt,
    updatedAt,
    repoPath: "/tmp/project",
    storagePath: `/tmp/store/${sessionId}.jsonl`,
    continuationLineageId,
  };
}

describe("loadSidebarSessions", () => {
  beforeEach(() => {
    mocks.store = createStore();
    mocks.externalHistorySidebarList.mockReset();
    mocks.nativeSidebarSessionPage.mockReset();
    mocks.nativeSidebarSessionPage.mockResolvedValue({
      sessions: [],
      nextCursor: null,
      hasMore: false,
    });
    mocks.sessionAggregateList.mockReset();
    mocks.persistSessions.mockReset();
  });

  it("keeps legacy sidebar callers on the canonical roster coordinator", () => {
    expect(loadSidebarSessions).toBe(loadSessionRoster);
  });

  it("keeps healthy imported sources listed when one source's store fails", async () => {
    mocks.sessionAggregateList.mockResolvedValue({ sessions: [] });
    mocks.externalHistorySidebarList.mockResolvedValue({
      sources: IMPORTED_HISTORY_SOURCES.map((source) =>
        source.sourceId === "cursor_ide"
          ? { source: source.sourceId, buckets: [], error: "disk on fire" }
          : {
              source: source.sourceId,
              buckets: [
                {
                  bucket: "older",
                  sessions:
                    source.sourceId === "codex_app"
                      ? [
                          makeRow(
                            "codexapp-healthy",
                            "2026-07-01T00:00:00Z",
                            "continuation-root"
                          ),
                        ]
                      : [],
                  hasMore: false,
                },
              ],
            }
      ),
    });

    await loadSidebarSessions();

    const pagination = mocks.store?.get(sessionPaginationAtom);
    // The broken source is UNKNOWN, never an authoritative empty page.
    expect(pagination?.["external_history:cursor_ide"].phase).toBe("error");
    expect(pagination?.["external_history:cursor_ide"].generation).toBe(0);
    // Its healthy siblings still publish their rows.
    expect(pagination?.["external_history:codex_app"].sessionIds).toEqual([
      "codexapp-healthy",
    ]);
    expect(
      mocks.store
        ?.get(sessionsAtom)
        .find((session) => session.session_id === "codexapp-healthy")
        ?.continuationLineageId
    ).toBe("continuation-root");
  });

  it("does not publish an authoritative empty page when the whole batch rejects", async () => {
    mocks.sessionAggregateList.mockResolvedValue({ sessions: [] });
    mocks.externalHistorySidebarList.mockRejectedValue(new Error("ipc down"));

    await loadSidebarSessions();

    const pagination = mocks.store?.get(sessionPaginationAtom);
    for (const source of IMPORTED_HISTORY_SOURCES) {
      const state = pagination?.[source.listCategory];
      expect(state?.phase).toBe("error");
      // generation must stay 0 — createSidebarRosterMatcher treats any
      // generation > 0 as authoritative and would hide every imported row.
      expect(state?.generation).toBe(0);
    }
  });

  it("refreshes gateway-created native rows without reloading imported sources", async () => {
    const imported = {
      session_id: "claude-code-imported",
      name: "Imported",
      status: "completed",
      created_at: "2026-07-01T00:00:00Z",
      updated_at: "2026-07-01T00:00:00Z",
    };
    const existing = {
      session_id: "existing-native",
      name: "Existing",
      status: "completed",
      created_at: "2026-07-02T00:00:00Z",
      updated_at: "2026-07-02T00:00:00Z",
    };
    const incoming = {
      session_id: "gateway-native",
      name: "Gateway",
      status: "running",
      created_at: "2026-07-03T00:00:00Z",
      updated_at: "2026-07-03T00:00:00Z",
    };
    mocks.store?.set(sessionsAtom, [existing, imported]);
    mocks.sessionAggregateList.mockResolvedValue({ sessions: [incoming] });

    await refreshRecentNativeSessions();

    expect(mocks.sessionAggregateList).toHaveBeenCalledOnce();
    expect(mocks.sessionAggregateList).toHaveBeenCalledWith({
      includeExternalHistory: false,
      limit: 60,
      sortBy: "updated_at",
      sortOrder: "desc",
    });
    expect(mocks.externalHistorySidebarList).not.toHaveBeenCalled();
    expect(
      mocks.store?.get(sessionsAtom).map((session) => session.session_id)
    ).toEqual(["gateway-native", "existing-native", "claude-code-imported"]);
  });

  it("adds only newly discovered rows ahead of the authoritative roster cursor", async () => {
    const current = mocks.store?.get(sessionPaginationAtom);
    if (!current || !mocks.store) throw new Error("missing test store");
    mocks.store.set(sessionPaginationAtom, {
      ...current,
      standalone_agent: {
        ...current.standalone_agent,
        sessionIds: ["sdeagent-page-10"],
        cursor: {
          updatedAt: "2026-07-30T10:00:00Z",
          sessionId: "sdeagent-page-10",
        },
        phase: "ready",
        generation: 1,
      },
    });
    mocks.sessionAggregateList.mockResolvedValue({
      sessions: [
        {
          session_id: "sdeagent-newer",
          status: "completed",
          created_at: "2026-07-30T11:00:00Z",
          updated_at: "2026-07-30T11:00:00Z",
        },
        {
          session_id: "sdeagent-older-history",
          status: "completed",
          created_at: "2026-07-30T09:00:00Z",
          updated_at: "2026-07-30T09:00:00Z",
        },
      ],
    });

    await refreshRecentNativeSessions();

    expect(
      mocks.store.get(sessionPaginationAtom).standalone_agent.sessionIds
    ).toEqual(["sdeagent-newer", "sdeagent-page-10"]);
  });

  it("single-flights overlapping recent native refreshes", async () => {
    let resolveRefresh:
      | ((value: { sessions: Array<{ session_id: string }> }) => void)
      | undefined;
    mocks.sessionAggregateList.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRefresh = resolve;
        })
    );

    const first = refreshRecentNativeSessions();
    const second = refreshRecentNativeSessions();

    expect(second).toBe(first);
    expect(mocks.sessionAggregateList).toHaveBeenCalledOnce();
    resolveRefresh?.({ sessions: [] });
    await Promise.all([first, second]);
  });

  it("keeps a locally-created native row when an older first page resolves", async () => {
    let resolveStandalone:
      | ((value: {
          sessions: unknown[];
          nextCursor: null;
          hasMore: false;
        }) => void)
      | undefined;
    mocks.nativeSidebarSessionPage.mockImplementation((stream: string) => {
      if (stream !== "standaloneAgent") {
        return Promise.resolve({
          sessions: [],
          nextCursor: null,
          hasMore: false,
        });
      }
      return new Promise((resolve) => {
        resolveStandalone = resolve;
      });
    });
    mocks.externalHistorySidebarList.mockResolvedValue({ sources: [] });

    const loading = loadSessionRoster({ forceRefresh: true });
    await Promise.resolve();
    if (!resolveStandalone || !mocks.store) {
      throw new Error("standalone roster request did not start");
    }

    const created = {
      session_id: "created-during-load",
      name: "Created during load",
      status: "running",
      created_at: "2026-07-30T12:00:00Z",
      updated_at: "2026-07-30T12:00:00Z",
    };
    mocks.store.set(sessionsAtom, [created]);
    registerNewNativeSidebarSession(created);

    resolveStandalone({ sessions: [], nextCursor: null, hasMore: false });
    await loading;

    expect(
      mocks.store.get(sessionPaginationAtom).standalone_agent.sessionIds
    ).toEqual(["created-during-load"]);
  });

  it("pages standalone agents and Agent Org roots with independent cursors", async () => {
    mocks.sessionAggregateList.mockResolvedValue({ sessions: [] });
    mocks.externalHistorySidebarList.mockResolvedValue({ sources: [] });
    mocks.nativeSidebarSessionPage.mockImplementation(
      async (
        stream: string,
        cursor: { updatedAt: string; sessionId: string } | null
      ) => {
        if (stream === "standaloneAgent" && cursor === null) {
          return {
            sessions: [
              {
                session_id: "standalone-1",
                updated_at: "2026-07-30T12:00:00Z",
              },
              {
                session_id: "standalone-2",
                updated_at: "2026-07-30T11:00:00Z",
              },
            ],
            nextCursor: {
              updatedAt: "2026-07-30T11:00:00Z",
              sessionId: "standalone-2",
            },
            hasMore: true,
          };
        }
        if (stream === "standaloneAgent") {
          return {
            sessions: [
              {
                session_id: "standalone-3",
                updated_at: "2026-07-30T10:00:00Z",
              },
            ],
            nextCursor: {
              updatedAt: "2026-07-30T10:00:00Z",
              sessionId: "standalone-3",
            },
            hasMore: false,
          };
        }
        if (stream !== "agentOrgRoot") {
          return { sessions: [], nextCursor: null, hasMore: false };
        }
        return {
          sessions: [
            {
              session_id: "org-root-1",
              agentOrgId: "org-1",
              updated_at: "2026-07-30T09:00:00Z",
            },
          ],
          nextCursor: {
            updatedAt: "2026-07-30T09:00:00Z",
            sessionId: "org-root-1",
          },
          hasMore: true,
        };
      }
    );

    await loadSidebarSessions({ forceRefresh: true, pageSize: 2 });

    expect(mocks.nativeSidebarSessionPage).toHaveBeenCalledWith(
      "standaloneAgent",
      null,
      10
    );
    expect(mocks.nativeSidebarSessionPage).toHaveBeenCalledWith(
      "agentOrgRoot",
      null,
      10
    );
    expect(mocks.store?.get(sessionPaginationAtom).standalone_agent).toEqual(
      expect.objectContaining({
        sessionIds: ["standalone-1", "standalone-2"],
        cursor: {
          updatedAt: "2026-07-30T11:00:00Z",
          sessionId: "standalone-2",
        },
        phase: "ready",
      })
    );
    expect(mocks.store?.get(sessionPaginationAtom).agent_org_root).toEqual(
      expect.objectContaining({
        sessionIds: ["org-root-1"],
        phase: "ready",
      })
    );

    mocks.nativeSidebarSessionPage.mockClear();
    await loadMoreCategory("standalone_agent", 2);

    expect(mocks.nativeSidebarSessionPage).toHaveBeenCalledTimes(1);
    expect(mocks.nativeSidebarSessionPage).toHaveBeenCalledWith(
      "standaloneAgent",
      {
        updatedAt: "2026-07-30T11:00:00Z",
        sessionId: "standalone-2",
      },
      2
    );
    expect(mocks.store?.get(sessionPaginationAtom).standalone_agent).toEqual(
      expect.objectContaining({
        sessionIds: ["standalone-1", "standalone-2", "standalone-3"],
        phase: "exhausted",
      })
    );
    expect(mocks.store?.get(sessionPaginationAtom).agent_org_root).toEqual(
      expect.objectContaining({
        sessionIds: ["org-root-1"],
        phase: "ready",
      })
    );
  });

  it("single-flights a rapid double click for the same stream", async () => {
    const cursor = {
      updatedAt: "2026-07-30T12:00:00Z",
      sessionId: "sdeagent-10",
    };
    const current = mocks.store?.get(sessionPaginationAtom);
    if (!current || !mocks.store) throw new Error("missing test store");
    mocks.store.set(sessionPaginationAtom, {
      ...current,
      standalone_agent: {
        ...current.standalone_agent,
        sessionIds: ["sdeagent-10"],
        cursor,
        phase: "ready",
        generation: 1,
      },
    });

    let resolvePage:
      | ((value: {
          sessions: Array<{ session_id: string; updated_at: string }>;
          nextCursor: null;
          hasMore: false;
        }) => void)
      | undefined;
    mocks.nativeSidebarSessionPage.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePage = resolve;
        })
    );

    const first = loadMoreCategory("standalone_agent");
    const second = loadMoreCategory("standalone_agent");

    expect(mocks.nativeSidebarSessionPage).toHaveBeenCalledOnce();
    await expect(second).resolves.toEqual(
      expect.objectContaining({ phase: "loading", sessions: [] })
    );
    resolvePage?.({
      sessions: [
        {
          session_id: "sdeagent-11",
          updated_at: "2026-07-30T11:00:00Z",
        },
      ],
      nextCursor: null,
      hasMore: false,
    });
    await expect(first).resolves.toEqual(
      expect.objectContaining({
        phase: "exhausted",
        newSessionIds: ["sdeagent-11"],
      })
    );
  });

  it("keeps the cursor on error and retries the same page", async () => {
    const cursor = {
      updatedAt: "2026-07-30T12:00:00Z",
      sessionId: "sdeagent-10",
    };
    const current = mocks.store?.get(sessionPaginationAtom);
    if (!current || !mocks.store) throw new Error("missing test store");
    mocks.store.set(sessionPaginationAtom, {
      ...current,
      standalone_agent: {
        ...current.standalone_agent,
        sessionIds: ["sdeagent-10"],
        cursor,
        phase: "ready",
        generation: 1,
      },
    });
    mocks.nativeSidebarSessionPage
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce({
        sessions: [
          {
            session_id: "sdeagent-11",
            updated_at: "2026-07-30T11:00:00Z",
          },
        ],
        nextCursor: null,
        hasMore: false,
      });

    await expect(loadMoreCategory("standalone_agent")).resolves.toEqual(
      expect.objectContaining({ phase: "error" })
    );
    expect(mocks.store.get(sessionPaginationAtom).standalone_agent).toEqual(
      expect.objectContaining({ cursor, phase: "error" })
    );

    await loadMoreCategory("standalone_agent");
    expect(mocks.nativeSidebarSessionPage).toHaveBeenNthCalledWith(
      2,
      "standaloneAgent",
      cursor,
      10
    );
    expect(mocks.store.get(sessionPaginationAtom).standalone_agent.phase).toBe(
      "exhausted"
    );
  });

  it("treats a duplicate-only page as a retryable contract error", async () => {
    const cursor = {
      updatedAt: "2026-07-30T12:00:00Z",
      sessionId: "sdeagent-10",
    };
    const current = mocks.store?.get(sessionPaginationAtom);
    if (!current || !mocks.store) throw new Error("missing test store");
    mocks.store.set(sessionPaginationAtom, {
      ...current,
      standalone_agent: {
        ...current.standalone_agent,
        sessionIds: ["sdeagent-10"],
        cursor,
        phase: "ready",
        generation: 1,
      },
    });
    mocks.nativeSidebarSessionPage.mockResolvedValue({
      sessions: [
        {
          session_id: "sdeagent-10",
          updated_at: "2026-07-30T12:00:00Z",
        },
      ],
      nextCursor: {
        updatedAt: "2026-07-30T11:00:00Z",
        sessionId: "sdeagent-20",
      },
      hasMore: true,
    });

    await expect(loadMoreCategory("standalone_agent")).resolves.toEqual(
      expect.objectContaining({ phase: "error", newSessionIds: [] })
    );
    expect(mocks.store.get(sessionPaginationAtom).standalone_agent).toEqual(
      expect.objectContaining({
        sessionIds: ["sdeagent-10"],
        cursor,
        phase: "error",
      })
    );
  });

  it("lets a pinned row reach the destination cursor without a duplicate-only error", async () => {
    const pinnedCursor = {
      updatedAt: "2026-07-30T12:00:00Z",
      sessionId: "sdeagent-pinned-page-1",
    };
    const standaloneCursor = {
      updatedAt: "2026-07-30T11:00:00Z",
      sessionId: "sdeagent-moved",
    };
    const current = mocks.store?.get(sessionPaginationAtom);
    if (!current || !mocks.store) throw new Error("missing test store");
    mocks.store.set(sessionPaginationAtom, {
      ...current,
      pinned_native: {
        ...current.pinned_native,
        sessionIds: ["sdeagent-pinned-page-1"],
        cursor: pinnedCursor,
        phase: "ready",
        generation: 1,
      },
      standalone_agent: {
        ...current.standalone_agent,
        sessionIds: ["sdeagent-moved"],
        cursor: standaloneCursor,
        phase: "ready",
        generation: 1,
      },
    });

    syncSidebarSessionRoster({
      session_id: "sdeagent-moved",
      status: "completed",
      created_at: "2026-07-30T10:00:00Z",
      updated_at: "2026-07-30T10:00:00Z",
      pinned: true,
    });
    expect(
      mocks.store.get(sessionPaginationAtom).pinned_native.sessionIds
    ).toEqual(["sdeagent-pinned-page-1"]);

    mocks.nativeSidebarSessionPage.mockResolvedValue({
      sessions: [
        {
          session_id: "sdeagent-moved",
          updated_at: "2026-07-30T10:00:00Z",
          pinned: true,
        },
      ],
      nextCursor: {
        updatedAt: "2026-07-30T10:00:00Z",
        sessionId: "sdeagent-moved",
      },
      hasMore: false,
    });

    await expect(loadMoreCategory("pinned_native")).resolves.toEqual(
      expect.objectContaining({
        phase: "exhausted",
        newSessionIds: ["sdeagent-moved"],
      })
    );
    expect(mocks.nativeSidebarSessionPage).toHaveBeenCalledWith(
      "pinnedNative",
      pinnedCursor,
      10
    );
    expect(mocks.store.get(sessionPaginationAtom).pinned_native).toEqual(
      expect.objectContaining({
        sessionIds: ["sdeagent-pinned-page-1", "sdeagent-moved"],
        phase: "exhausted",
      })
    );
  });

  it("drops a late response from the generation before a forced refresh", async () => {
    const oldCursor = {
      updatedAt: "2026-07-30T12:00:00Z",
      sessionId: "sdeagent-old-10",
    };
    const current = mocks.store?.get(sessionPaginationAtom);
    if (!current || !mocks.store) throw new Error("missing test store");
    mocks.store.set(sessionPaginationAtom, {
      ...current,
      standalone_agent: {
        ...current.standalone_agent,
        sessionIds: ["sdeagent-old-10"],
        cursor: oldCursor,
        phase: "ready",
        generation: 1,
      },
    });
    mocks.externalHistorySidebarList.mockImplementation(
      async (request: {
        requests: Array<{
          source: string;
          buckets: Array<{ bucket: string }>;
        }>;
      }) => ({
        sources: request.requests.map(({ source, buckets }) => ({
          source,
          buckets: buckets.map(({ bucket }) => ({
            bucket,
            sessions: [],
            hasMore: false,
          })),
        })),
      })
    );
    let resolveOldPage:
      | ((value: {
          sessions: Array<{ session_id: string; updated_at: string }>;
          nextCursor: null;
          hasMore: false;
        }) => void)
      | undefined;
    mocks.nativeSidebarSessionPage.mockImplementation(
      (
        stream: string,
        cursor: { updatedAt: string; sessionId: string } | null
      ) => {
        if (
          stream === "standaloneAgent" &&
          cursor?.sessionId === oldCursor.sessionId
        ) {
          return new Promise((resolve) => {
            resolveOldPage = resolve;
          });
        }
        return Promise.resolve({
          sessions: [],
          nextCursor: null,
          hasMore: false,
        });
      }
    );

    const oldPage = loadMoreCategory("standalone_agent");
    await loadSessionRoster({ forceRefresh: true });
    resolveOldPage?.({
      sessions: [
        {
          session_id: "sdeagent-stale-response",
          updated_at: "2026-07-30T11:00:00Z",
        },
      ],
      nextCursor: null,
      hasMore: false,
    });
    await oldPage;

    expect(
      mocks.store.get(sessionPaginationAtom).standalone_agent.sessionIds
    ).toEqual([]);
    expect(
      mocks.store
        .get(sessionsAtom)
        .some((session) => session.session_id === "sdeagent-stale-response")
    ).toBe(false);
  });

  it("replaces a 30-row provisional cache with the first 10-row roster page", async () => {
    const cached = Array.from({ length: 30 }, (_, index) => ({
      session_id: `sdeagent-${index + 1}`,
      status: "completed" as const,
      created_at: `2026-07-30T${String(30 - index).padStart(2, "0")}:00:00Z`,
      updated_at: `2026-07-30T${String(30 - index).padStart(2, "0")}:00:00Z`,
    }));
    mocks.store?.set(sessionsAtom, cached);
    mocks.externalHistorySidebarList.mockImplementation(
      async (request: {
        requests: Array<{
          source: string;
          buckets: Array<{ bucket: string }>;
        }>;
      }) => ({
        sources: request.requests.map(({ source, buckets }) => ({
          source,
          buckets: buckets.map(({ bucket }) => ({
            bucket,
            sessions: [],
            hasMore: false,
          })),
        })),
      })
    );
    mocks.nativeSidebarSessionPage.mockImplementation(async (stream: string) =>
      stream === "standaloneAgent"
        ? {
            sessions: cached.slice(0, 10),
            nextCursor: {
              updatedAt: cached[9].updated_at,
              sessionId: cached[9].session_id,
            },
            hasMore: true,
          }
        : { sessions: [], nextCursor: null, hasMore: false }
    );

    await loadSessionRoster({ forceRefresh: true, pageSize: 10 });

    expect(mocks.store?.get(sessionsAtom)).toHaveLength(30);
    expect(
      mocks.store?.get(sessionPaginationAtom).standalone_agent.sessionIds
    ).toEqual(cached.slice(0, 10).map((session) => session.session_id));

    mocks.nativeSidebarSessionPage.mockResolvedValue({
      sessions: cached.slice(10, 20),
      nextCursor: {
        updatedAt: cached[19].updated_at,
        sessionId: cached[19].session_id,
      },
      hasMore: true,
    });
    const nextPage = await loadMoreCategory("standalone_agent");

    expect(nextPage.newSessionIds).toEqual(
      cached.slice(10, 20).map((session) => session.session_id)
    );
    expect(
      mocks.store?.get(sessionPaginationAtom).standalone_agent.sessionIds
    ).toEqual(cached.slice(0, 20).map((session) => session.session_id));
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
        mocks.store?.get(sessionPaginationAtom)[source.listCategory].sessionIds
          .length
      ).toBe(11);
      expect(
        mocks.store?.get(sessionPaginationAtom)[source.listCategory].dateBuckets
          ?.yesterday
      ).toEqual({ loaded: 1, hasMore: false });
    }
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

  it("batches and single-flights exact historical session hydration", async () => {
    let resolveList:
      | ((value: { sessions: Array<{ session_id: string }> }) => void)
      | undefined;
    mocks.sessionAggregateList.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveList = resolve;
        })
    );

    const first = loadSidebarSessionsByIds(["older-b", "older-a", "older-a"]);
    const second = loadSidebarSessionsByIds(["older-a", "older-b"]);

    expect(mocks.sessionAggregateList).toHaveBeenCalledTimes(1);
    expect(mocks.sessionAggregateList).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionIds: ["older-b", "older-a"],
        includeExternalHistory: true,
        limit: 2,
      })
    );

    resolveList?.({
      sessions: [{ session_id: "older-a" }, { session_id: "older-b" }],
    });
    await expect(first).resolves.toHaveLength(2);
    await expect(second).resolves.toHaveLength(2);
  });

  it("isolates exact hydration single-flight state per Jotai store", async () => {
    mocks.sessionAggregateList.mockResolvedValue({
      sessions: [{ session_id: "shared-id" }],
    });
    const firstStore = mocks.store;
    const first = loadSidebarSessionsByIds(["shared-id"]);

    const secondStore = createStore();
    mocks.store = secondStore;
    const second = loadSidebarSessionsByIds(["shared-id"]);

    await Promise.all([first, second]);
    expect(mocks.sessionAggregateList).toHaveBeenCalledTimes(2);
    expect(firstStore?.get(sessionsAtom)).toContainEqual({
      session_id: "shared-id",
    });
    expect(secondStore.get(sessionsAtom)).toContainEqual({
      session_id: "shared-id",
    });
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
