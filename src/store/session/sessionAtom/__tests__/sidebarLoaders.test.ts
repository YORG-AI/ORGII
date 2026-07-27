import { createStore } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { IMPORTED_HISTORY_SOURCES } from "@src/api/tauri/externalHistory";

import { dataSourceConfigAtom } from "../../dataSourceConfigAtom";
import { sessionsAtom } from "../atoms";
import {
  __TESTS_ONLY,
  loadMoreCategory,
  loadMoreSessionScope,
  loadSessionRoster,
  loadSidebarSessionById,
  loadSidebarSessions,
  loadSidebarSessionsByIds,
} from "../loaders";
import {
  resetPaginationState,
  scopedSessionPaginationAtom,
  sessionPaginationAtom,
  sessionPaginationScopeKey,
  sessionRosterGenerationAtom,
} from "../paginationAtoms";

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

function makeNativeRow(sessionId: string, updatedAt: string) {
  return {
    session_id: sessionId,
    name: sessionId,
    status: "completed" as const,
    category: "rust_agent" as const,
    created_at: updatedAt,
    updated_at: updatedAt,
  };
}

describe("loadSidebarSessions", () => {
  beforeEach(() => {
    mocks.store = createStore();
    mocks.externalHistorySidebarList.mockReset();
    mocks.sessionAggregateList.mockReset();
    mocks.persistSessions.mockReset();
  });

  it("keeps legacy sidebar callers on the canonical roster coordinator", () => {
    expect(loadSidebarSessions).toBe(loadSessionRoster);
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

  it("continues each external date bucket from its own seek cursor", async () => {
    mocks.sessionAggregateList.mockResolvedValue({ sessions: [] });
    mocks.externalHistorySidebarList.mockImplementation(
      async (request: {
        requests: Array<{
          source: string;
          buckets: Array<{
            bucket: string;
            offset: number;
            before?: { updatedAtMs: number; sessionId: string };
          }>;
        }>;
      }) => ({
        sources: request.requests.map((sourceRequest) => ({
          source: sourceRequest.source,
          buckets: sourceRequest.buckets.map(
            ({ bucket, offset, before }, bucketIndex) => {
              const pageIndex = before ? 1 : offset;
              return {
                bucket,
                sessions: [
                  makeRow(
                    `${sourceRequest.source}-${bucket}-${pageIndex}`,
                    "2026-07-12T12:00:00Z"
                  ),
                ],
                hasMore: bucket === "today" && !before,
                nextCursor: {
                  updatedAtMs: 1_752_321_600_000 - bucketIndex - pageIndex,
                  sessionId: `${sourceRequest.source}-raw-${bucket}-${pageIndex}`,
                },
              };
            }
          ),
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
      expect.objectContaining({
        bucket: "today",
        offset: 0,
        limit: 10,
        before: {
          updatedAtMs: 1_752_321_600_000,
          sessionId: "codex_app-raw-today-0",
        },
      }),
    ]);
  });

  it("paginates complete native root pages without duplicates or gaps", async () => {
    const nativeRoots = {
      cli: Array.from({ length: 25 }, (_, index) => ({
        session_id: `cliagent-root-${index}`,
        name: `CLI root ${index}`,
        status: "completed" as const,
        created_at: `2026-07-26T12:00:${59 - index}Z`,
        updated_at: `2026-07-26T12:00:${59 - index}Z`,
      })),
      sde: Array.from({ length: 25 }, (_, index) => ({
        session_id: `sdeagent-root-${index}`,
        name: `SDE root ${index}`,
        status: "completed" as const,
        created_at: `2026-07-26T11:00:${59 - index}Z`,
        updated_at: `2026-07-26T11:00:${59 - index}Z`,
      })),
      agent_org: Array.from({ length: 12 }, (_, index) => ({
        session_id: `sdeagent-org-root-${index}`,
        name: `Agent Org root ${index}`,
        status: "completed" as const,
        created_at: `2026-07-26T10:00:${59 - index}Z`,
        updated_at: `2026-07-26T10:00:${59 - index}Z`,
        agentOrgId: "org-alpha",
        agentOrgName: "Alpha Org",
      })),
      os: Array.from({ length: 12 }, (_, index) => ({
        session_id: `osagent-root-${index}`,
        name: `OS root ${index}`,
        status: "completed" as const,
        created_at: `2026-07-26T09:00:${59 - index}Z`,
        updated_at: `2026-07-26T09:00:${59 - index}Z`,
      })),
      wingman: [],
      custom: [],
      human: [],
    };
    mocks.sessionAggregateList.mockImplementation(
      async (filter: {
        category?: keyof typeof nativeRoots;
        limit?: number;
        offset?: number;
        beforeUpdatedAt?: string;
        beforeSessionId?: string;
      }) => {
        const rows = filter.category ? nativeRoots[filter.category] : [];
        const cursorIndex = filter.beforeSessionId
          ? rows.findIndex(
              (row) =>
                row.session_id === filter.beforeSessionId &&
                row.updated_at === filter.beforeUpdatedAt
            )
          : -1;
        const offset =
          cursorIndex >= 0 ? cursorIndex + 1 : (filter.offset ?? 0);
        return {
          sessions: rows.slice(offset, offset + (filter.limit ?? rows.length)),
        };
      }
    );
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

    await loadSidebarSessions({ forceRefresh: true, pageSize: 10 });
    expect(mocks.store?.get(sessionPaginationAtom).cli_agent).toMatchObject({
      loaded: 10,
      hasMore: true,
    });
    expect(
      mocks.store?.get(sessionPaginationAtom)["rust_agent:sde"]
    ).toMatchObject({ loaded: 10, hasMore: true });
    expect(
      mocks.store?.get(sessionPaginationAtom)["rust_agent:agent_org"]
    ).toMatchObject({ loaded: 10, hasMore: true });
    expect(
      mocks.store?.get(sessionPaginationAtom)["rust_agent:os"]
    ).toMatchObject({ loaded: 10, hasMore: true });
    await loadMoreCategory("cli_agent", 10);
    await loadMoreCategory("rust_agent:sde", 10);
    await loadMoreCategory("cli_agent", 10);
    await loadMoreCategory("rust_agent:sde", 10);

    const loadedIds = mocks.store
      ?.get(sessionsAtom)
      .map((session) => session.session_id);
    expect(
      loadedIds?.filter((id) => id.startsWith("cliagent-")).sort()
    ).toEqual(nativeRoots.cli.map((session) => session.session_id).sort());
    expect(
      loadedIds?.filter((id) => id.startsWith("sdeagent-")).sort()
    ).toEqual(
      [...nativeRoots.sde, ...nativeRoots.agent_org]
        .slice(0, 35)
        .map((session) => session.session_id)
        .sort()
    );
    expect(loadedIds?.filter((id) => id.startsWith("osagent-")).sort()).toEqual(
      nativeRoots.os
        .slice(0, 10)
        .map((session) => session.session_id)
        .sort()
    );
    expect(new Set(loadedIds).size).toBe(loadedIds?.length);

    const pagination = mocks.store?.get(sessionPaginationAtom);
    expect(pagination?.cli_agent).toMatchObject({
      loaded: 25,
      hasMore: false,
      loading: false,
    });
    expect(pagination?.["rust_agent:sde"]).toMatchObject({
      loaded: 25,
      hasMore: false,
      loading: false,
    });
    expect(pagination?.["rust_agent:agent_org"]).toMatchObject({
      loaded: 10,
      hasMore: true,
      loading: false,
    });

    for (const category of ["cli", "sde"] as const) {
      expect(
        mocks.sessionAggregateList.mock.calls
          .map(([filter]) => filter)
          .filter((filter) => filter.category === category)
          .map((filter) => ({
            offset: filter.offset,
            beforeUpdatedAt: filter.beforeUpdatedAt,
            beforeSessionId: filter.beforeSessionId,
          }))
      ).toEqual([
        {
          offset: 0,
          beforeUpdatedAt: undefined,
          beforeSessionId: undefined,
        },
        {
          offset: 0,
          beforeUpdatedAt: nativeRoots[category][9]?.updated_at,
          beforeSessionId: nativeRoots[category][9]?.session_id,
        },
        {
          offset: 0,
          beforeUpdatedAt: nativeRoots[category][19]?.updated_at,
          beforeSessionId: nativeRoots[category][19]?.session_id,
        },
      ]);
    }
  });

  it("keeps consecutive By Time pages on one date-scoped native cursor", async () => {
    const now = new Date();
    now.setHours(12, 0, 0, 0);
    const allRows = Array.from({ length: 23 }, (_, index) => ({
      session_id: `sdeagent-today-${index}`,
      name: `Today ${index}`,
      status: "completed" as const,
      category: "rust_agent" as const,
      created_at: new Date(now.getTime() - index * 1_000).toISOString(),
      updated_at: new Date(now.getTime() - index * 1_000).toISOString(),
    }));
    const initial = allRows.slice(0, 10);
    mocks.store?.set(sessionsAtom, initial);
    mocks.store?.set(sessionPaginationAtom, {
      ...resetPaginationState(),
      "rust_agent:sde": {
        loaded: 10,
        hasMore: true,
        loading: false,
        loadedSessionIds: initial.map((session) => session.session_id),
      },
    });
    mocks.sessionAggregateList.mockImplementation(
      async (filter: {
        category?: string;
        offset?: number;
        limit?: number;
        updatedAfterMs?: number;
        beforeUpdatedAt?: string;
        beforeSessionId?: string;
      }) => {
        expect(filter.category).toBe("sde");
        expect(filter.updatedAfterMs).toBeTypeOf("number");
        const cursorIndex = filter.beforeSessionId
          ? allRows.findIndex(
              (row) =>
                row.session_id === filter.beforeSessionId &&
                row.updated_at === filter.beforeUpdatedAt
            )
          : -1;
        const offset =
          cursorIndex >= 0 ? cursorIndex + 1 : (filter.offset ?? 0);
        return {
          sessions: allRows.slice(
            offset,
            offset + (filter.limit ?? allRows.length)
          ),
        };
      }
    );

    const scopeKey = sessionPaginationScopeKey({
      kind: "time",
      bucket: "today",
      orgIds: ["personal-org"],
    });
    await loadMoreSessionScope(scopeKey, 10);
    await loadMoreSessionScope(scopeKey, 10);
    await loadMoreSessionScope(scopeKey, 10);

    expect(
      mocks.sessionAggregateList.mock.calls.map(([filter]) => ({
        offset: filter.offset,
        beforeUpdatedAt: filter.beforeUpdatedAt,
        beforeSessionId: filter.beforeSessionId,
      }))
    ).toEqual([
      {
        offset: 10,
        beforeUpdatedAt: undefined,
        beforeSessionId: undefined,
      },
      {
        offset: 0,
        beforeUpdatedAt: allRows[19]?.updated_at,
        beforeSessionId: allRows[19]?.session_id,
      },
    ]);
    const ids = mocks.store
      ?.get(sessionsAtom)
      .filter((session) => session.session_id.startsWith("sdeagent-today-"))
      .map((session) => session.session_id);
    expect(new Set(ids).size).toBe(23);
    const scoped = mocks.store?.get(scopedSessionPaginationAtom)[scopeKey]
      .categories["rust_agent:sde"];
    expect(scoped).toMatchObject({
      loaded: 23,
      hasMore: false,
      loading: false,
    });
  });

  it("does not turn an exact-loaded atom row into a scoped server offset", async () => {
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    mocks.store?.set(sessionsAtom, [
      {
        session_id: "sdeagent-exact-loaded-middle",
        name: "Exact loaded middle row",
        status: "completed",
        category: "rust_agent",
        created_at: today.toISOString(),
        updated_at: today.toISOString(),
        repoPath: "/repo-a",
      },
    ]);
    mocks.store?.set(sessionPaginationAtom, {
      ...resetPaginationState(),
      "rust_agent:sde": {
        loaded: 0,
        hasMore: true,
        loading: false,
      },
    });
    mocks.sessionAggregateList.mockResolvedValue({
      sessions: [
        {
          session_id: "sdeagent-first-scoped-row",
          name: "First scoped row",
          status: "completed",
          category: "rust_agent",
          created_at: today.toISOString(),
          updated_at: today.toISOString(),
          repoPath: "/repo-a",
        },
      ],
    });
    const scopeKey = sessionPaginationScopeKey({
      kind: "workspace",
      repoPath: "/repo-a",
      orgIds: ["personal-org"],
    });

    await loadMoreSessionScope(scopeKey, 10);

    expect(mocks.sessionAggregateList).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "sde",
        repoPath: "/repo-a",
        repoPathExact: true,
        offset: 0,
      })
    );
    expect(
      mocks.store?.get(scopedSessionPaginationAtom)[scopeKey].categories[
        "rust_agent:sde"
      ]
    ).toMatchObject({
      loaded: 1,
      hasMore: false,
      loadedSessionIds: ["sdeagent-first-scoped-row"],
    });
  });

  it("keeps imported workspace offsets independent and stops at hasMore false", async () => {
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    const makeImportedSession = (sessionId: string, repoPath: string) => ({
      session_id: sessionId,
      name: sessionId,
      status: "completed" as const,
      category: "external_history" as const,
      created_at: today.toISOString(),
      updated_at: today.toISOString(),
      repoPath,
    });
    mocks.store?.set(sessionsAtom, [
      makeImportedSession("codexapp-repo-a-0", "/repo-a"),
      makeImportedSession("codexapp-repo-a-1", "/repo-a"),
      ...Array.from({ length: 5 }, (_, index) =>
        makeImportedSession(`codexapp-repo-b-${index}`, "/repo-b")
      ),
    ]);
    const pagination = resetPaginationState();
    mocks.store?.set(sessionPaginationAtom, {
      ...pagination,
      "external_history:codex_app": {
        loaded: 7,
        hasMore: true,
        loading: false,
        loadedSessionIds: [
          "codexapp-repo-a-0",
          "codexapp-repo-a-1",
          ...Array.from(
            { length: 5 },
            (_, index) => `codexapp-repo-b-${index}`
          ),
        ],
        dateBuckets: {
          today: {
            loaded: 7,
            hasMore: true,
            cursor: {
              updatedAtMs: today.getTime() - 6_000,
              sessionId: "raw-global-row-6",
            },
          },
          yesterday: { loaded: 0, hasMore: false },
          thisWeek: { loaded: 0, hasMore: false },
          older: { loaded: 0, hasMore: false },
        },
      },
    });
    mocks.externalHistorySidebarList.mockImplementation(
      async (request: {
        requests: Array<{
          source: string;
          repoPath?: string;
          buckets: Array<{ bucket: string; offset: number }>;
        }>;
      }) => {
        expect(request.requests).toEqual([
          expect.objectContaining({
            source: "codex_app",
            repoPath: "/repo-a",
            buckets: [
              expect.objectContaining({
                bucket: "today",
                offset: 0,
                before: {
                  updatedAtMs: today.getTime() - 6_000,
                  sessionId: "raw-global-row-6",
                },
              }),
            ],
          }),
        ]);
        return {
          sources: [
            {
              source: "codex_app",
              buckets: [
                {
                  bucket: "today",
                  sessions: [
                    makeRow("codexapp-repo-a-2", today.toISOString()),
                    makeRow("codexapp-repo-a-3", today.toISOString()),
                  ].map((row) => ({ ...row, repoPath: "/repo-a" })),
                  hasMore: false,
                },
              ],
            },
          ],
        };
      }
    );
    const scopeKey = sessionPaginationScopeKey({
      kind: "workspace",
      repoPath: "/repo-a",
      orgIds: ["personal-org"],
    });

    await loadMoreSessionScope(scopeKey, 10);
    await loadMoreSessionScope(scopeKey, 10);

    expect(mocks.externalHistorySidebarList).toHaveBeenCalledTimes(1);
    const repoAIds = mocks.store
      ?.get(sessionsAtom)
      .filter((session) => session.repoPath === "/repo-a")
      .map((session) => session.session_id);
    expect(new Set(repoAIds).size).toBe(4);
    expect(
      mocks.store?.get(scopedSessionPaginationAtom)[scopeKey].categories[
        "external_history:codex_app"
      ]
    ).toMatchObject({
      loaded: 4,
      hasMore: false,
      loading: false,
    });
  });

  it("keeps native category cursors independent across org A, org B, then org A", async () => {
    const rowsByOrg = new Map([
      [
        "cloud:org-a",
        Array.from({ length: 3 }, (_, index) => ({
          session_id: `sdeagent-cloud:org-a-${index}`,
          name: `cloud:org-a ${index}`,
          status: "completed" as const,
          category: "rust_agent" as const,
          orgId: "cloud:org-a",
          created_at: `2026-07-01T00:00:0${2 - index}Z`,
          updated_at: `2026-07-01T00:00:0${2 - index}Z`,
        })),
      ],
      [
        "cloud:org-b",
        [
          {
            session_id: "sdeagent-cloud:org-b-0",
            name: "cloud:org-b 0",
            status: "completed" as const,
            category: "rust_agent" as const,
            orgId: "cloud:org-b",
            created_at: "2026-07-01T00:00:02Z",
            updated_at: "2026-07-01T00:00:02Z",
          },
        ],
      ],
    ]);
    mocks.sessionAggregateList.mockImplementation(
      async (filter: {
        category?: string;
        orgIds?: string[];
        offset?: number;
        limit?: number;
        beforeUpdatedAt?: string;
        beforeSessionId?: string;
      }) => {
        expect(filter.category).toBe("sde");
        const org = filter.orgIds?.[0] ?? "missing";
        const rows = rowsByOrg.get(org) ?? [];
        const cursorIndex = filter.beforeSessionId
          ? rows.findIndex(
              (row) =>
                row.session_id === filter.beforeSessionId &&
                row.updated_at === filter.beforeUpdatedAt
            )
          : -1;
        const offset =
          cursorIndex >= 0 ? cursorIndex + 1 : (filter.offset ?? 0);
        return {
          sessions: rows.slice(offset, offset + (filter.limit ?? rows.length)),
        };
      }
    );
    const scopeA = sessionPaginationScopeKey({
      kind: "category",
      category: "rust_agent:sde",
      orgIds: ["cloud:org-a", "org-a"],
    });
    const scopeB = sessionPaginationScopeKey({
      kind: "category",
      category: "rust_agent:sde",
      orgIds: ["cloud:org-b", "org-b"],
    });

    await loadMoreSessionScope(scopeA, 2);
    await loadMoreSessionScope(scopeB, 2);
    await loadMoreSessionScope(scopeA, 2);

    expect(
      mocks.sessionAggregateList.mock.calls.map(([filter]) => ({
        orgIds: filter.orgIds,
        offset: filter.offset,
        beforeUpdatedAt: filter.beforeUpdatedAt,
        beforeSessionId: filter.beforeSessionId,
      }))
    ).toEqual([
      {
        orgIds: ["cloud:org-a", "org-a"],
        offset: 0,
        beforeUpdatedAt: undefined,
        beforeSessionId: undefined,
      },
      {
        orgIds: ["cloud:org-b", "org-b"],
        offset: 0,
        beforeUpdatedAt: undefined,
        beforeSessionId: undefined,
      },
      {
        orgIds: ["cloud:org-a", "org-a"],
        offset: 0,
        beforeUpdatedAt: "2026-07-01T00:00:01Z",
        beforeSessionId: "sdeagent-cloud:org-a-1",
      },
    ]);
    const scoped = mocks.store?.get(scopedSessionPaginationAtom);
    expect(scoped?.[scopeA].categories["rust_agent:sde"]).toMatchObject({
      loaded: 3,
      hasMore: false,
    });
    expect(scoped?.[scopeB].categories["rust_agent:sde"]).toMatchObject({
      loaded: 1,
      hasMore: false,
    });
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

  it("drops a delayed category page after a forced roster generation", async () => {
    let resolveStale:
      | ((value: { sessions: ReturnType<typeof makeNativeRow>[] }) => void)
      | undefined;
    let firstSdeRequest = true;
    mocks.sessionAggregateList.mockImplementation(
      async (filter: { category?: string }) => {
        if (filter.category === "sde" && firstSdeRequest) {
          firstSdeRequest = false;
          return new Promise((resolve) => {
            resolveStale = resolve;
          });
        }
        return {
          sessions:
            filter.category === "sde"
              ? [
                  makeNativeRow(
                    "sdeagent-fresh-generation",
                    "2026-07-27T00:00:00Z"
                  ),
                ]
              : [],
        };
      }
    );
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
    const pagination = resetPaginationState();
    mocks.store?.set(sessionPaginationAtom, {
      ...pagination,
      "rust_agent:sde": {
        ...pagination["rust_agent:sde"],
        hasMore: true,
      },
    });

    const staleLoad = loadMoreCategory("rust_agent:sde", 2);
    await loadSessionRoster({ forceRefresh: true, pageSize: 2 });
    resolveStale?.({
      sessions: [
        makeNativeRow("sdeagent-stale-generation", "2026-07-01T00:00:00Z"),
      ],
    });
    await staleLoad;

    const ids = mocks.store?.get(sessionsAtom).map((row) => row.session_id);
    expect(ids).toContain("sdeagent-fresh-generation");
    expect(ids).not.toContain("sdeagent-stale-generation");
    expect(mocks.store?.get(sessionRosterGenerationAtom)).toBe(1);
  });

  it("drops a delayed scoped page after a forced roster generation", async () => {
    let resolveStale:
      | ((value: { sessions: ReturnType<typeof makeNativeRow>[] }) => void)
      | undefined;
    mocks.sessionAggregateList.mockImplementation(
      async (filter: { orgIds?: string[] }) => {
        if (filter.orgIds?.includes("cloud:org-a")) {
          return new Promise((resolve) => {
            resolveStale = resolve;
          });
        }
        return { sessions: [] };
      }
    );
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
    const scopeKey = sessionPaginationScopeKey({
      kind: "category",
      category: "rust_agent:sde",
      orgIds: ["cloud:org-a", "org-a"],
    });

    const staleLoad = loadMoreSessionScope(scopeKey, 2);
    await loadSessionRoster({ forceRefresh: true, pageSize: 2 });
    resolveStale?.({
      sessions: [
        makeNativeRow("sdeagent-stale-scoped", "2026-07-01T00:00:00Z"),
      ],
    });
    await staleLoad;

    expect(
      mocks.store?.get(scopedSessionPaginationAtom)[scopeKey]
    ).toBeUndefined();
    expect(
      mocks.store
        ?.get(sessionsAtom)
        .some((row) => row.session_id === "sdeagent-stale-scoped")
    ).toBe(false);
  });

  it("cannot revive a disabled imported source from a delayed page", async () => {
    let resolveStale:
      | ((value: {
          sources: Array<{
            source: string;
            buckets: Array<{
              bucket: string;
              sessions: ReturnType<typeof makeRow>[];
              hasMore: boolean;
            }>;
          }>;
        }) => void)
      | undefined;
    let firstExternalRequest = true;
    mocks.sessionAggregateList.mockResolvedValue({ sessions: [] });
    mocks.externalHistorySidebarList.mockImplementation(
      async (request: {
        requests: Array<{ source: string; buckets: Array<{ bucket: string }> }>;
      }) => {
        if (firstExternalRequest) {
          firstExternalRequest = false;
          return new Promise((resolve) => {
            resolveStale = resolve;
          });
        }
        return {
          sources: request.requests.map(({ source, buckets }) => ({
            source,
            buckets: buckets.map(({ bucket }) => ({
              bucket,
              sessions: [],
              hasMore: false,
            })),
          })),
        };
      }
    );
    const pagination = resetPaginationState();
    mocks.store?.set(sessionPaginationAtom, {
      ...pagination,
      "external_history:warp": {
        ...pagination["external_history:warp"],
        hasMore: true,
        dateBuckets: {
          today: { loaded: 0, hasMore: true },
          yesterday: { loaded: 0, hasMore: false },
          thisWeek: { loaded: 0, hasMore: false },
          older: { loaded: 0, hasMore: false },
        },
      },
    });

    const staleLoad = loadMoreCategory("external_history:warp", 2);
    mocks.store?.set(dataSourceConfigAtom, {
      warp: { enabled: false, frequency: "default", lastScannedAt: null },
    });
    await loadSessionRoster({ forceRefresh: true, pageSize: 2 });
    resolveStale?.({
      sources: [
        {
          source: "warp",
          buckets: [
            {
              bucket: "today",
              sessions: [
                makeRow("warpapp-stale-disabled", "2026-07-01T00:00:00Z"),
              ],
              hasMore: false,
            },
          ],
        },
      ],
    });
    await staleLoad;

    expect(
      mocks.store
        ?.get(sessionsAtom)
        .some((row) => row.session_id === "warpapp-stale-disabled")
    ).toBe(false);
    expect(
      mocks.store?.get(sessionPaginationAtom)["external_history:warp"]
    ).toMatchObject({ loaded: 0, hasMore: false, loading: false });
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
