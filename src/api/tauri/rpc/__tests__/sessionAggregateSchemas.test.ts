import { describe, expect, it } from "vitest";

import {
  ExternalHistorySidebarBatchResponseSchema,
  ExternalHistorySidebarListInput,
  SessionAggregateRecordSchema,
  SessionWorkspaceFacetResponseSchema,
} from "../schemas/sessionAggregate";

describe("session aggregate category schemas", () => {
  it("maps Human wire rows to the Human dispatch category", () => {
    const parsed = SessionAggregateRecordSchema.parse({
      sessionId: "humansession-1",
      name: "Release verification",
      status: "completed",
      createdAt: "2026-07-22T01:00:00Z",
      updatedAt: "2026-07-22T02:00:00Z",
      category: "human",
      keySource: "own_key",
      totalTokens: 0,
      background: false,
      isActive: false,
    });

    expect(parsed.category).toBe("human_session");
  });
});

describe("external history sidebar schemas", () => {
  it("accepts bounded non-overlapping bucket requests", () => {
    expect(
      ExternalHistorySidebarListInput.parse({
        requests: [
          {
            source: "codex_app",
            buckets: [
              {
                bucket: "today",
                startMs: 200,
                limit: 10,
                offset: 0,
                before: {
                  updatedAtMs: 300,
                  sessionId: "raw-codex-session",
                },
              },
              {
                bucket: "yesterday",
                startMs: 100,
                endMs: 200,
                limit: 10,
                offset: 0,
              },
            ],
          },
        ],
      }).requests[0].buckets
    ).toHaveLength(2);
  });

  it("rejects duplicate buckets and oversized pages", () => {
    expect(() =>
      ExternalHistorySidebarListInput.parse({
        requests: [
          {
            source: "codex_app",
            buckets: [
              { bucket: "today", limit: 10, offset: 0 },
              { bucket: "today", limit: 51, offset: 0 },
            ],
          },
        ],
      })
    ).toThrow();
  });

  it("rejects duplicate sources in one batch", () => {
    const sourceRequest = {
      source: "codex_app",
      buckets: [{ bucket: "today" as const, limit: 10, offset: 0 }],
    };
    expect(() =>
      ExternalHistorySidebarListInput.parse({
        requests: [sourceRequest, sourceRequest],
      })
    ).toThrow();
  });

  it("accepts one workspace scope and rejects conflicting workspace scopes", () => {
    const request = {
      source: "codex_app",
      buckets: [{ bucket: "today" as const, limit: 10, offset: 0 }],
    };
    expect(
      ExternalHistorySidebarListInput.parse({
        requests: [{ ...request, repoPath: "/repo-a" }],
      }).requests[0].repoPath
    ).toBe("/repo-a");
    expect(
      ExternalHistorySidebarListInput.parse({
        requests: [{ ...request, missingRepoPath: true }],
      }).requests[0].missingRepoPath
    ).toBe(true);
    expect(() =>
      ExternalHistorySidebarListInput.parse({
        requests: [{ ...request, repoPath: "/repo-a", missingRepoPath: true }],
      })
    ).toThrow();
  });

  it("validates the lightweight response shape", () => {
    const parsed = ExternalHistorySidebarBatchResponseSchema.parse({
      sources: [
        {
          source: "codex_app",
          buckets: [
            {
              bucket: "yesterday",
              sessions: [
                {
                  sessionId: "codexapp-1",
                  name: "Cached session",
                  createdAt: "2026-07-11T01:00:00Z",
                  updatedAt: "2026-07-11T02:00:00Z",
                },
              ],
              hasMore: false,
              nextCursor: {
                updatedAtMs: 100,
                sessionId: "raw-codex-session",
              },
            },
          ],
        },
      ],
    });

    expect(parsed.sources[0].buckets[0].sessions[0]).toEqual({
      sessionId: "codexapp-1",
      name: "Cached session",
      createdAt: "2026-07-11T01:00:00Z",
      updatedAt: "2026-07-11T02:00:00Z",
    });
    expect(parsed.sources[0].buckets[0].nextCursor).toEqual({
      updatedAtMs: 100,
      sessionId: "raw-codex-session",
    });
  });
});

describe("workspace facet schemas", () => {
  it("accepts the null repoPath emitted for the No Workspace facet", () => {
    const parsed = SessionWorkspaceFacetResponseSchema.parse({
      facets: [
        {
          repoPath: null,
          lastUpdatedAtMs: 1,
          sessionCount: 2,
        },
      ],
      hasMore: false,
    });

    expect(parsed.facets[0].repoPath).toBeNull();
  });
});
