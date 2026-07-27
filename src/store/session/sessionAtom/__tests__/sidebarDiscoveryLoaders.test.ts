import { createStore } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  dataSourceConfigAtom,
  externalSessionsEnabledAtom,
} from "../../dataSourceConfigAtom";
import { sessionsAtom } from "../atoms";
import {
  sidebarDiscoveryGenerationAtom,
  sidebarPinnedPagesAtom,
  sidebarPinnedScopeKey,
  sidebarSearchResultsAtom,
  sidebarWorkspaceFacetPagesAtom,
  sidebarWorkspaceFacetScopeKey,
} from "../sidebarDiscoveryAtoms";
import {
  beginSidebarSearchRequest,
  invalidateSidebarDiscovery,
  loadMoreSidebarPinnedPage,
  loadMoreSidebarWorkspaceFacetPage,
  loadSidebarSearchResults,
} from "../sidebarDiscoveryLoaders";

const mocks = vi.hoisted(() => ({
  sessionAggregateList: vi.fn(),
  sessionWorkspaceFacets: vi.fn(),
  store: undefined as ReturnType<typeof createStore> | undefined,
}));

vi.mock("@src/api/tauri/session", () => ({
  sessionAggregateList: mocks.sessionAggregateList,
  sessionWorkspaceFacets: mocks.sessionWorkspaceFacets,
  toFrontendSessions: (sessions: unknown[]) => sessions,
}));

vi.mock("@src/util/core/state/instrumentedStore", () => ({
  getInstrumentedStore: () => {
    if (!mocks.store) throw new Error("Test store not initialized");
    return mocks.store;
  },
}));

function testStore(): ReturnType<typeof createStore> {
  if (!mocks.store) throw new Error("Test store not initialized");
  return mocks.store;
}

function session(sessionId: string, updatedAt = "2026-07-01T00:00:00Z") {
  return {
    session_id: sessionId,
    name: sessionId,
    status: "completed" as const,
    created_at: updatedAt,
    updated_at: updatedAt,
  };
}

describe("independent sidebar discovery loaders", () => {
  beforeEach(() => {
    mocks.store = createStore();
    testStore().set(sessionsAtom, [session("ordinary-roster-row")]);
    mocks.sessionAggregateList.mockReset();
    mocks.sessionWorkspaceFacets.mockReset();
  });

  it("ignores the first A result after an A to B to A query cycle", async () => {
    let resolveFirst:
      | ((value: { sessions: ReturnType<typeof session>[] }) => void)
      | undefined;
    mocks.sessionAggregateList
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          })
      )
      .mockResolvedValueOnce({ sessions: [session("second-result")] })
      .mockResolvedValueOnce({ sessions: [session("fresh-third-result")] });

    const firstRequest = {
      query: "first",
      orgIds: ["personal-org"],
      includeExternal: true,
    };
    const firstToken = beginSidebarSearchRequest(firstRequest);
    const firstLoad = loadSidebarSearchResults(firstRequest, firstToken);

    const secondRequest = { ...firstRequest, query: "second" };
    const secondToken = beginSidebarSearchRequest(secondRequest);
    await loadSidebarSearchResults(secondRequest, secondToken);
    const thirdToken = beginSidebarSearchRequest(firstRequest);
    await loadSidebarSearchResults(firstRequest, thirdToken);
    resolveFirst?.({ sessions: [session("late-first-result")] });
    await firstLoad;

    expect(testStore().get(sidebarSearchResultsAtom)).toMatchObject({
      requestToken: thirdToken,
      loading: false,
      sessions: [session("fresh-third-result")],
    });
    expect(testStore().get(sessionsAtom)).toEqual([
      session("ordinary-roster-row"),
    ]);
  });

  it("clearing search invalidates the in-flight result without touching the roster", async () => {
    let resolveSearch:
      | ((value: { sessions: ReturnType<typeof session>[] }) => void)
      | undefined;
    mocks.sessionAggregateList.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSearch = resolve;
        })
    );
    const request = {
      query: "needle",
      orgIds: ["personal-org"],
      includeExternal: true,
    };
    const requestToken = beginSidebarSearchRequest(request);
    const load = loadSidebarSearchResults(request, requestToken);

    beginSidebarSearchRequest({ ...request, query: "" });
    resolveSearch?.({ sessions: [session("stale-result")] });
    await load;

    expect(testStore().get(sidebarSearchResultsAtom)).toMatchObject({
      queryKey: "",
      loading: false,
      sessions: [],
    });
    expect(testStore().get(sessionsAtom)).toEqual([
      session("ordinary-roster-row"),
    ]);
  });

  it("keeps pinned offsets independent for org A, org B, then org A", async () => {
    const rowsByOrg = new Map([
      [
        "org-a",
        [
          session("org-a-pinned-0", "2026-07-03T00:00:00Z"),
          session("org-a-pinned-1", "2026-07-02T00:00:00Z"),
          session("org-a-pinned-2", "2026-07-01T00:00:00Z"),
        ],
      ],
      ["org-b", [session("org-b-pinned-0", "2026-07-03T00:00:00Z")]],
    ]);
    mocks.sessionAggregateList.mockImplementation(
      async (filter: {
        orgIds: string[];
        offset: number;
        limit: number;
        pinnedOnly: boolean;
        beforeUpdatedAt?: string;
        beforeSessionId?: string;
      }) => {
        expect(filter.pinnedOnly).toBe(true);
        const org = filter.orgIds[0];
        const rows = rowsByOrg.get(org) ?? [];
        const cursorIndex = filter.beforeSessionId
          ? rows.findIndex(
              (row) =>
                row.session_id === filter.beforeSessionId &&
                row.updated_at === filter.beforeUpdatedAt
            )
          : -1;
        const offset = cursorIndex >= 0 ? cursorIndex + 1 : filter.offset;
        return {
          sessions: rows.slice(offset, offset + filter.limit),
        };
      }
    );

    await loadMoreSidebarPinnedPage({ orgIds: ["org-a"], pageSize: 2 });
    await loadMoreSidebarPinnedPage({ orgIds: ["org-b"], pageSize: 2 });
    await loadMoreSidebarPinnedPage({ orgIds: ["org-a"], pageSize: 2 });

    expect(
      mocks.sessionAggregateList.mock.calls.map(([filter]) => ({
        orgIds: filter.orgIds,
        offset: filter.offset,
        beforeUpdatedAt: filter.beforeUpdatedAt,
        beforeSessionId: filter.beforeSessionId,
      }))
    ).toEqual([
      {
        orgIds: ["org-a"],
        offset: 0,
        beforeUpdatedAt: undefined,
        beforeSessionId: undefined,
      },
      {
        orgIds: ["org-b"],
        offset: 0,
        beforeUpdatedAt: undefined,
        beforeSessionId: undefined,
      },
      {
        orgIds: ["org-a"],
        offset: 0,
        beforeUpdatedAt: "2026-07-02T00:00:00Z",
        beforeSessionId: "org-a-pinned-1",
      },
    ]);
    const pages = testStore().get(sidebarPinnedPagesAtom);
    expect(pages[sidebarPinnedScopeKey(["org-a"])]).toMatchObject({
      loaded: 3,
      hasMore: false,
    });
    expect(pages[sidebarPinnedScopeKey(["org-b"])]).toMatchObject({
      loaded: 1,
      hasMore: false,
    });
    expect(testStore().get(sessionsAtom)).toEqual([
      session("ordinary-roster-row"),
    ]);
  });

  it("paginates old-only workspace facets without hydrating sessions", async () => {
    testStore().set(dataSourceConfigAtom, {
      warp: { enabled: false, frequency: "default", lastScannedAt: null },
    });
    mocks.sessionWorkspaceFacets
      .mockResolvedValueOnce({
        facets: [
          {
            repoPath: "/recent",
            lastUpdatedAtMs: 200,
            sessionCount: 3,
          },
          {
            repoPath: "/old-only",
            lastUpdatedAtMs: 100,
            sessionCount: 1,
          },
        ],
        hasMore: true,
      })
      .mockResolvedValueOnce({
        facets: [
          {
            lastUpdatedAtMs: 50,
            sessionCount: 2,
          },
        ],
        hasMore: false,
      });

    const request = {
      orgIds: ["personal-org"],
      includeExternal: true,
      pageSize: 2,
    };
    await loadMoreSidebarWorkspaceFacetPage(request);
    await loadMoreSidebarWorkspaceFacetPage(request);

    expect(
      mocks.sessionWorkspaceFacets.mock.calls.map(([input]) => ({
        offset: input.offset,
        disabled: input.disabledExternalHistorySources,
        before: input.before,
      }))
    ).toEqual([
      { offset: 0, disabled: ["warp"], before: undefined },
      {
        offset: 0,
        disabled: ["warp"],
        before: {
          lastUpdatedAtMs: 100,
          repoPath: "/old-only",
        },
      },
    ]);
    const scopeKey = sidebarWorkspaceFacetScopeKey({
      orgIds: ["personal-org"],
      includeExternalHistory: true,
      disabledExternalHistorySources: ["warp"],
    });
    expect(
      testStore()
        .get(sidebarWorkspaceFacetPagesAtom)
        [scopeKey].facets.map((facet) => facet.repoPath)
    ).toEqual(["/recent", "/old-only", null]);
    expect(testStore().get(sessionsAtom)).toEqual([
      session("ordinary-roster-row"),
    ]);
  });

  it("drops delayed pinned and workspace pages after discovery invalidation", async () => {
    let resolvePinned:
      | ((value: { sessions: ReturnType<typeof session>[] }) => void)
      | undefined;
    let resolveFacets:
      | ((value: {
          facets: Array<{
            repoPath: string;
            lastUpdatedAtMs: number;
            sessionCount: number;
          }>;
          hasMore: boolean;
        }) => void)
      | undefined;
    mocks.sessionAggregateList.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePinned = resolve;
        })
    );
    mocks.sessionWorkspaceFacets.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFacets = resolve;
        })
    );

    const pinnedLoad = loadMoreSidebarPinnedPage({
      orgIds: ["personal-org"],
      pageSize: 2,
    });
    const facetLoad = loadMoreSidebarWorkspaceFacetPage({
      orgIds: ["personal-org"],
      includeExternal: true,
      pageSize: 2,
    });
    const generation = invalidateSidebarDiscovery();
    resolvePinned?.({ sessions: [session("stale-pinned")] });
    resolveFacets?.({
      facets: [
        {
          repoPath: "/stale",
          lastUpdatedAtMs: 1,
          sessionCount: 1,
        },
      ],
      hasMore: false,
    });
    await Promise.all([pinnedLoad, facetLoad]);

    expect(generation).toBe(1);
    expect(testStore().get(sidebarDiscoveryGenerationAtom)).toBe(1);
    expect(testStore().get(sidebarPinnedPagesAtom)).toEqual({});
    expect(testStore().get(sidebarWorkspaceFacetPagesAtom)).toEqual({});
  });

  it("derives search policy from the live external-history master switch", async () => {
    mocks.sessionAggregateList.mockResolvedValue({ sessions: [] });
    const request = {
      query: "needle",
      orgIds: ["personal-org"],
      includeExternal: true,
    };

    const enabledToken = beginSidebarSearchRequest(request);
    await loadSidebarSearchResults(request, enabledToken);
    testStore().set(externalSessionsEnabledAtom, false);
    const disabledToken = beginSidebarSearchRequest(request);
    await loadSidebarSearchResults(request, disabledToken);

    expect(
      mocks.sessionAggregateList.mock.calls.map(
        ([filter]) => filter.includeExternalHistory
      )
    ).toEqual([true, false]);
  });
});
