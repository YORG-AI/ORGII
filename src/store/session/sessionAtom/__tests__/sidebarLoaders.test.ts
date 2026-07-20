import { createStore } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { IMPORTED_HISTORY_SOURCES } from "@src/api/tauri/externalHistory";

import { dataSourceConfigAtom } from "../../dataSourceConfigAtom";
import { sessionsAtom } from "../atoms";
import { loadMoreCategory, loadSidebarSessions } from "../loaders";
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
        source: string;
        buckets: Array<{ bucket: string; limit: number; offset: number }>;
      }) => {
        const source = IMPORTED_HISTORY_SOURCES.find(
          (candidate) => candidate.sourceId === request.source
        );
        if (!source) throw new Error("unknown source");
        return {
          source: request.source,
          buckets: request.buckets.map(({ bucket, offset }) => ({
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
      }
    );

    await loadSidebarSessions({ forceRefresh: true, pageSize: 10 });

    const externalCalls = mocks.externalHistorySidebarList.mock.calls.map(
      ([request]) => request
    );
    expect(externalCalls).toHaveLength(IMPORTED_HISTORY_SOURCES.length);
    expect(externalCalls.map((request) => request.source).sort()).toEqual(
      IMPORTED_HISTORY_SOURCES.map((source) => source.sourceId).sort()
    );
    expect(
      externalCalls.every(
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

    const loadedIds = new Set(
      mocks.store?.get(sessionsAtom).map((session) => session.session_id)
    );
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

  it("continues each external date bucket from its own offset", async () => {
    mocks.sessionAggregateList.mockResolvedValue({ sessions: [] });
    mocks.externalHistorySidebarList.mockImplementation(
      async (request: {
        source: string;
        buckets: Array<{ bucket: string; offset: number }>;
      }) => ({
        source: request.source,
        buckets: request.buckets.map(({ bucket, offset }) => ({
          bucket,
          sessions: [
            makeRow(
              `${request.source}-${bucket}-${offset}`,
              "2026-07-12T12:00:00Z"
            ),
          ],
          hasMore: bucket === "today" && offset === 0,
        })),
      })
    );

    await loadSidebarSessions({ forceRefresh: true, pageSize: 10 });
    const codexCategory = "external_history:codex_app" as const;
    await loadMoreCategory(codexCategory, 10);

    const lastRequest = mocks.externalHistorySidebarList.mock.calls.at(-1)?.[0];
    expect(lastRequest.source).toBe("codex_app");
    expect(lastRequest.buckets).toEqual([
      expect.objectContaining({ bucket: "today", offset: 1, limit: 10 }),
    ]);
  });

  it("gates a disabled Warp source out of sidebar loading", async () => {
    mocks.store?.set(dataSourceConfigAtom, {
      warp: { enabled: false, frequency: "default", lastScannedAt: null },
    });
    mocks.sessionAggregateList.mockResolvedValue({ sessions: [] });
    mocks.externalHistorySidebarList.mockResolvedValue({
      source: "unused",
      buckets: [],
    });

    await loadSidebarSessions({ forceRefresh: true, pageSize: 10 });

    const requestedSources = mocks.externalHistorySidebarList.mock.calls.map(
      ([request]) => request.source
    );
    expect(requestedSources).not.toContain("warp");
    expect(requestedSources).toHaveLength(IMPORTED_HISTORY_SOURCES.length - 1);
  });

  it("gates a disabled Qoder source out of sidebar loading", async () => {
    mocks.store?.set(dataSourceConfigAtom, {
      qoder: { enabled: false, frequency: "default", lastScannedAt: null },
    });
    mocks.sessionAggregateList.mockResolvedValue({ sessions: [] });
    mocks.externalHistorySidebarList.mockResolvedValue({
      source: "unused",
      buckets: [],
    });

    await loadSidebarSessions({ forceRefresh: true, pageSize: 10 });

    const requestedSources = mocks.externalHistorySidebarList.mock.calls.map(
      ([request]) => request.source
    );
    expect(requestedSources).not.toContain("qoder");
    expect(requestedSources).toHaveLength(IMPORTED_HISTORY_SOURCES.length - 1);
  });
});
