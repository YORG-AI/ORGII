import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import { decodeSegmentEvents } from "../TeamCollaboration/sync/segmentCodec";
import {
  ORG2_CLOUD_OFFICIAL_ANON_KEY,
  ORG2_CLOUD_OFFICIAL_SUPABASE_URL,
  ORG2_CLOUD_POSTGREST_SCHEMA,
} from "./config";
import {
  CloudSessionWirePageContractError,
  Org2CloudSyncError,
  appendSessionEventWires,
  appendSessionEvents,
  getOrgRepoScopes,
  getSessionEvents,
  isOrg2SyncErrorCode,
  listOrgSessions,
  rewriteSessionEventWires,
  rewriteSessionEvents,
  setOrgRepoScopes,
  upsertSessionMetadata,
} from "./org2CloudSyncClient";

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function lastCall(): { url: string; init: RequestInit } {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return { url, init };
}

function lastBody(): Record<string, unknown> {
  return JSON.parse(String(lastCall().init.body)) as Record<string, unknown>;
}

function makeEvent(id: string): SessionEvent {
  return { id, displayStatus: "completed" } as unknown as SessionEvent;
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockResolvedValue(jsonResponse(null));
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe("org2CloudSyncClient headers", () => {
  it("sends JWT bearer + Content-Profile on every sync RPC", async () => {
    await setOrgRepoScopes("jwt-1", "org-1", ["github.com/acme/alpha"]);
    const { url, init } = lastCall();
    expect(url).toBe(
      `${ORG2_CLOUD_OFFICIAL_SUPABASE_URL}/rest/v1/rpc/cloud_set_org_repo_scopes`
    );
    const headers = init.headers as Record<string, string>;
    expect(headers.apikey).toBe(ORG2_CLOUD_OFFICIAL_ANON_KEY);
    expect(headers.authorization).toBe("Bearer jwt-1");
    expect(headers["content-profile"]).toBe(ORG2_CLOUD_POSTGREST_SCHEMA);
    expect(lastBody()).toEqual({
      p_org_id: "org-1",
      scopes: ["github.com/acme/alpha"],
    });
  });
});

describe("cloud_get_org_repo_scopes", () => {
  it("parses the full scope-governance state", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        repoScopes: ["github.com/acme/alpha"],
        used: 2,
        cap: 3,
        cooldownDays: 7,
        coolingDown: [
          {
            scopeKey: "github.com/acme/beta",
            freesAt: "2026-07-11T00:00:00.000Z",
          },
        ],
      })
    );
    const state = await getOrgRepoScopes("jwt-1", "org-1");
    expect(lastBody()).toEqual({ p_org_id: "org-1" });
    expect(state.repoScopes).toEqual(["github.com/acme/alpha"]);
    expect(state.used).toBe(2);
    expect(state.cap).toBe(3);
    expect(state.cooldownDays).toBe(7);
    expect(state.coolingDown[0].scopeKey).toBe("github.com/acme/beta");
  });

  it("tolerates absent cap/cooldownDays (unlimited plan)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ repoScopes: [], used: 0, coolingDown: [] })
    );
    const state = await getOrgRepoScopes("jwt-1", "org-1");
    expect(state.cap).toBeNull();
    expect(state.cooldownDays).toBe(0);
  });
});

describe("cloud_set_org_repo_scopes", () => {
  it("maps ORG2_SCOPE_COOLDOWN (with frees-at suffix) into a coded error", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ message: "ORG2_SCOPE_COOLDOWN 2026-07-11T00:00:00Z" }, 409)
    );
    const error = await setOrgRepoScopes("jwt-1", "org-1", [
      "github.com/acme/beta",
    ]).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Org2CloudSyncError);
    expect(isOrg2SyncErrorCode(error, "ORG2_SCOPE_COOLDOWN")).toBe(true);
    // The suffix must survive into the message for frees-at recovery.
    expect((error as Org2CloudSyncError).message).toContain(
      "2026-07-11T00:00:00Z"
    );
  });
});

describe("cloud_upsert_session_metadata", () => {
  it("ships the exact body key set", async () => {
    const metadata = { id: "row-1", title: "T" } as never;
    await upsertSessionMetadata("jwt-1", "org-1", "s-1", metadata);
    expect(lastBody()).toEqual({
      p_org_id: "org-1",
      p_session_id: "s-1",
      metadata: { id: "row-1", title: "T" },
    });
  });
});

describe("cloud_append_session_events", () => {
  it("forwards Rust-prepared segment wires without decoding them", async () => {
    const wire = {
      seq: 9,
      payloadGz: "opaque-rust-gzip",
      eventCount: 1,
      segmentHash: "rust-hash",
    };
    await appendSessionEventWires("jwt-1", {
      orgId: "org-1",
      sessionId: "s-1",
      expectedEpoch: 2,
      expectedFrozenSeq: 8,
      expectedTailHash: null,
      newFrozenSegments: [wire],
      tail: null,
      totalCount: 9,
    });
    expect(lastBody().new_frozen_segments).toEqual([wire]);
  });

  it("fails closed before fetch when any encoded segment exceeds 256 KiB", async () => {
    await expect(
      appendSessionEventWires("jwt-1", {
        orgId: "org-1",
        sessionId: "s-1",
        expectedEpoch: 1,
        expectedFrozenSeq: 0,
        expectedTailHash: null,
        newFrozenSegments: [
          {
            seq: 1,
            payloadGz: "x".repeat(256 * 1024),
            eventCount: 1,
            segmentHash: "oversized",
          },
        ],
        tail: null,
        totalCount: 1,
      })
    ).rejects.toThrow("versioned attachment wire is required");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("builds shared-codec segment wire payloads with OCC anchors", async () => {
    const frozen = [makeEvent("f1")];
    const tail = [makeEvent("t1")];
    await appendSessionEvents("jwt-1", {
      orgId: "org-1",
      sessionId: "s-1",
      expectedEpoch: 2,
      expectedFrozenSeq: 5,
      expectedTailHash: "hash-old-tail",
      newFrozenSegments: [{ seq: 6, events: frozen }],
      tail,
      totalCount: 7,
    });
    const body = lastBody();
    expect(Object.keys(body).sort()).toEqual([
      "expected_epoch",
      "expected_frozen_seq",
      "expected_tail_hash",
      "new_frozen_segments",
      "p_org_id",
      "p_session_id",
      "tail",
      "total_count",
    ]);
    expect(body.expected_epoch).toBe(2);
    expect(body.expected_frozen_seq).toBe(5);
    expect(body.expected_tail_hash).toBe("hash-old-tail");
    expect(body.total_count).toBe(7);
    const segments = body.new_frozen_segments as Array<Record<string, unknown>>;
    expect(segments).toHaveLength(1);
    expect(segments[0].seq).toBe(6);
    expect(segments[0].eventCount).toBe(1);
    expect(await decodeSegmentEvents(String(segments[0].payloadGz))).toEqual(
      frozen
    );
    const tailWire = body.tail as Record<string, unknown>;
    expect(tailWire.eventCount).toBe(1);
    expect(tailWire).not.toHaveProperty("seq");
  });

  it("maps ORG2_CONFLICT into a coded Org2CloudSyncError", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ message: "ORG2_CONFLICT" }, 409)
    );
    const error = await appendSessionEvents("jwt-1", {
      orgId: "org-1",
      sessionId: "s-1",
      expectedEpoch: 1,
      expectedFrozenSeq: 0,
      expectedTailHash: null,
      newFrozenSegments: [],
      tail: null,
      totalCount: 0,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Org2CloudSyncError);
    expect(isOrg2SyncErrorCode(error, "ORG2_CONFLICT")).toBe(true);
    expect(isOrg2SyncErrorCode(error, "ORG2_QUOTA_EXCEEDED")).toBe(false);
  });
});

describe("cloud_rewrite_session_events", () => {
  it("forwards a bounded Rust rewrite wire unchanged", async () => {
    const wire = {
      seq: 1,
      payloadGz: "opaque-rust-gzip",
      eventCount: 1,
      segmentHash: "rust-hash",
    };
    await rewriteSessionEventWires("jwt-1", {
      orgId: "org-1",
      sessionId: "s-1",
      newEpoch: 4,
      frozenSegments: [wire],
      tail: null,
      totalCount: 1,
    });
    expect(lastBody().frozen_segments).toEqual([wire]);
  });

  it("ships the rewrite body with new_epoch", async () => {
    await rewriteSessionEvents("jwt-1", {
      orgId: "org-1",
      sessionId: "s-1",
      newEpoch: 3,
      frozenSegments: [{ seq: 1, events: [makeEvent("f1")] }],
      tail: null,
      totalCount: 1,
    });
    const body = lastBody();
    expect(Object.keys(body).sort()).toEqual([
      "frozen_segments",
      "new_epoch",
      "p_org_id",
      "p_session_id",
      "tail",
      "total_count",
    ]);
    expect(body.new_epoch).toBe(3);
    expect(body.tail).toBeNull();
  });

  it("surfaces ORG2_QUOTA_EXCEEDED as a coded error", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ message: "ORG2_QUOTA_EXCEEDED" }, 403)
    );
    const error = await rewriteSessionEvents("jwt-1", {
      orgId: "org-1",
      sessionId: "s-1",
      newEpoch: 1,
      frozenSegments: [],
      tail: null,
      totalCount: 0,
    }).catch((caught: unknown) => caught);
    expect(isOrg2SyncErrorCode(error, "ORG2_QUOTA_EXCEEDED")).toBe(true);
  });
});

describe("cloud_list_org_sessions", () => {
  it("parses the retention-windowed listing", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        serverTime: "2026-07-04T00:00:00.000Z",
        sessions: [
          {
            id: "org-1:u-2:s-9",
            orgId: "org-1",
            ownerMemberId: "u-2",
            ownerUserId: "u-2",
            ownerDisplayName: "Bea",
            ownerIdentityKind: "human",
            sourceSessionId: "s-9",
            title: "Fix login",
            lastActivityAt: "2026-07-03T12:00:00.000Z",
            directlySharedWithMe: true,
            // 0014 lateral aggregates (session comments).
            commentCount: 3,
            unresolvedCommentCount: 1,
          },
        ],
      })
    );
    const result = await listOrgSessions("jwt-1", "org-1");
    expect(lastBody()).toEqual({ p_org_id: "org-1", since: null });
    expect(result.serverTime).toBe("2026-07-04T00:00:00.000Z");
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].ownerDisplayName).toBe("Bea");
    expect(result.sessions[0].directlySharedWithMe).toBe(true);
    expect(result.sessions[0].commentCount).toBe(3);
    expect(result.sessions[0].unresolvedCommentCount).toBe(1);
  });

  it("tolerates rows without the 0014 comment counters (pre-0014 backend)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        serverTime: "2026-07-04T00:00:00.000Z",
        sessions: [
          {
            id: "org-1:u-2:s-9",
            orgId: "org-1",
            ownerMemberId: "u-2",
            ownerUserId: "u-2",
            ownerDisplayName: "Bea",
            ownerIdentityKind: "human",
            sourceSessionId: "s-9",
            title: "Fix login",
          },
        ],
      })
    );
    const result = await listOrgSessions("jwt-1", "org-1");
    expect(result.sessions[0].commentCount).toBeUndefined();
    expect(result.sessions[0].unresolvedCommentCount).toBeUndefined();
  });

  it("strips the segment summary on metadata_only rows (access ladder)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        sessions: [
          {
            id: "org-1:u-2:s-9",
            orgId: "org-1",
            ownerMemberId: "u-2",
            ownerUserId: "u-2",
            ownerDisplayName: "Bea",
            ownerIdentityKind: "human",
            sourceSessionId: "s-9",
            title: "Metadata only",
            accessMode: "metadata_only",
            // Cloud column is `events_epoch integer DEFAULT 0 NOT NULL` —
            // the wire always carries the summary even when unreadable.
            eventsEpoch: 0,
            eventsFrozenSeq: 0,
            eventsCount: 0,
            eventsTailHash: "hash",
          },
          {
            id: "org-1:u-2:s-10",
            orgId: "org-1",
            ownerMemberId: "u-2",
            ownerUserId: "u-2",
            ownerDisplayName: "Bea",
            ownerIdentityKind: "human",
            sourceSessionId: "s-10",
            title: "Replayable",
            accessMode: "full_replay",
            eventsEpoch: 1,
            eventsFrozenSeq: 4,
            eventsCount: 12,
            eventsTailHash: "hash",
          },
        ],
      })
    );
    const result = await listOrgSessions("jwt-1", "org-1");
    expect(result.sessions[0].eventsEpoch).toBeUndefined();
    expect(result.sessions[0].eventsCount).toBeUndefined();
    expect(result.sessions[0].eventsTailHash).toBeUndefined();
    expect(result.sessions[1].eventsEpoch).toBe(1);
    expect(result.sessions[1].eventsCount).toBe(12);
  });

  it("passes the since cursor through", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ sessions: [] }));
    await listOrgSessions("jwt-1", "org-1", "2026-07-01T00:00:00.000Z");
    expect(lastBody()).toEqual({
      p_org_id: "org-1",
      since: "2026-07-01T00:00:00.000Z",
    });
  });
});

describe("cloud_get_session_events", () => {
  it("parses the segments snapshot", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        epoch: 4,
        frozenSeq: 2,
        tailHash: "th",
        segments: [
          { seq: 1, payloadGz: "abc", eventCount: 3, segmentHash: "h1" },
        ],
      })
    );
    const result = await getSessionEvents("jwt-1", "org-1", "s-1");
    expect(lastBody()).toEqual({ p_org_id: "org-1", p_session_id: "s-1" });
    expect(result.epoch).toBe(4);
    expect(result.segments[0].segmentHash).toBe("h1");
  });

  it("maps ORG2_RETENTION_EXPIRED into a coded error", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ message: "ORG2_RETENTION_EXPIRED" }, 403)
    );
    const error = await getSessionEvents("jwt-1", "org-1", "s-old").catch(
      (caught: unknown) => caught
    );
    expect(isOrg2SyncErrorCode(error, "ORG2_RETENTION_EXPIRED")).toBe(true);
  });

  it("uses an explicit endpoint without leaking it into the RPC body", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ epoch: null, segments: [] })
    );
    await getSessionEvents("jwt-1", "org-1", "s-1", {
      endpoint: {
        webOrigin: "https://app.custom.example.com",
        supabaseUrl: "https://db.custom.example.com",
        anonKey: "custom-anon",
        isOfficial: false,
      },
    });
    expect(lastCall().url).toBe(
      "https://db.custom.example.com/rest/v1/rpc/cloud_get_session_events"
    );
    expect(lastBody()).toEqual({ p_org_id: "org-1", p_session_id: "s-1" });
  });

  it("requests a byte-bounded latest page without decoding its wires", async () => {
    const frozen = {
      seq: 7,
      payloadGz: "frozen-wire",
      eventCount: 1,
      segmentHash: "frozen-hash",
    };
    const tail = {
      seq: 0,
      payloadGz: "tail-wire",
      eventCount: 2,
      segmentHash: "tail-hash",
    };
    const returnedWireBytes = [frozen, tail].reduce(
      (total, segment) =>
        total + new TextEncoder().encode(JSON.stringify(segment)).byteLength,
      0
    );
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        epoch: 4,
        frozenSeq: 9,
        tailHash: "tail-hash",
        count: 12,
        segments: [frozen, tail],
        direction: "backward",
        tailIncluded: true,
        hasMore: true,
        nextCursor: { direction: "backward", beforeSeq: 7 },
        returnedWireBytes,
      })
    );

    const page = await getSessionEvents("jwt-1", "org-1", "s-1", {
      boundedWirePage: true,
      cursor: { direction: "backward" },
      includeTail: true,
      maxSegments: 16,
      maxWireBytes: 1024 * 1024,
    });

    expect(lastBody()).toEqual({
      p_org_id: "org-1",
      p_session_id: "s-1",
      p_direction: "backward",
      p_include_tail: true,
      p_max_segments: 16,
      p_max_wire_bytes: 1024 * 1024,
    });
    expect(page.segments).toEqual([frozen, tail]);
    expect(page.nextCursor).toEqual({
      direction: "backward",
      beforeSeq: 7,
    });
  });

  it("passes the backward continuation cursor for older frozen rows", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        epoch: 4,
        frozenSeq: 9,
        tailHash: null,
        count: 12,
        segments: [],
        direction: "backward",
        tailIncluded: false,
        hasMore: false,
        nextCursor: null,
        returnedWireBytes: 0,
      })
    );

    await getSessionEvents("jwt-1", "org-1", "s-1", {
      boundedWirePage: true,
      cursor: { direction: "backward", beforeSeq: 7 },
      includeTail: false,
      maxSegments: 16,
      maxWireBytes: 1024,
    });

    expect(lastBody()).toMatchObject({
      p_direction: "backward",
      p_before_seq: 7,
      p_include_tail: false,
      p_max_segments: 16,
      p_max_wire_bytes: 1024,
    });
  });

  it("pins a multi-page forward cursor while accepting V2 eventCount zero rows", async () => {
    const continuation = {
      seq: 1,
      payloadGz: "v2-part-1",
      eventCount: 0,
      segmentHash: "part-1-hash",
    };
    const finalPart = {
      seq: 2,
      payloadGz: "v2-part-2",
      eventCount: 1,
      segmentHash: "part-2-hash",
    };
    const bytes = (segment: typeof continuation): number =>
      new TextEncoder().encode(JSON.stringify(segment)).byteLength;
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          epoch: 8,
          frozenSeq: 2,
          tailHash: null,
          count: 1,
          segments: [continuation],
          direction: "forward",
          tailIncluded: false,
          hasMore: true,
          nextCursor: {
            direction: "forward",
            afterSeq: 1,
            throughSeq: 2,
          },
          returnedWireBytes: bytes(continuation),
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          epoch: 8,
          frozenSeq: 2,
          tailHash: null,
          count: 1,
          segments: [finalPart],
          direction: "forward",
          tailIncluded: false,
          hasMore: false,
          nextCursor: null,
          returnedWireBytes: bytes(finalPart),
        })
      );

    const first = await getSessionEvents("jwt-1", "org-1", "s-1", {
      boundedWirePage: true,
      cursor: { direction: "forward", afterSeq: 0 },
      includeTail: false,
      maxSegments: 1,
      maxWireBytes: 1024,
    });
    expect(first.segments[0].eventCount).toBe(0);
    expect(first.nextCursor).toEqual({
      direction: "forward",
      afterSeq: 1,
      throughSeq: 2,
    });

    await getSessionEvents("jwt-1", "org-1", "s-1", {
      boundedWirePage: true,
      cursor: first.nextCursor!,
      includeTail: false,
      maxSegments: 1,
      maxWireBytes: 1024,
    });
    expect(lastBody()).toMatchObject({
      p_direction: "forward",
      p_after_seq: 1,
      p_through_seq: 2,
      p_max_segments: 1,
      p_max_wire_bytes: 1024,
    });
  });

  it("fails closed when an old server omits bounded pagination metadata", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ epoch: 1, frozenSeq: 0, segments: [] })
    );

    await expect(
      getSessionEvents("jwt-1", "org-1", "s-1", {
        boundedWirePage: true,
        cursor: { direction: "backward" },
        includeTail: true,
        maxSegments: 16,
        maxWireBytes: 1024,
      })
    ).rejects.toThrow();
  });

  it("stops reading when a legacy/full response exceeds the HTTP body cap", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        epoch: 1,
        frozenSeq: 1,
        segments: [
          {
            seq: 1,
            payloadGz: "x".repeat(100 * 1024),
            eventCount: 1,
            segmentHash: "legacy-full-response",
          },
        ],
      })
    );

    await expect(
      getSessionEvents("jwt-1", "org-1", "s-1", {
        boundedWirePage: true,
        cursor: { direction: "backward" },
        includeTail: true,
        maxSegments: 1,
        maxWireBytes: 1024,
      })
    ).rejects.toThrow(/response exceeded/);
  });

  it("fails closed when the server exceeds the physical wire budget", async () => {
    const oversized = {
      seq: 1,
      payloadGz: "x".repeat(257 * 1024),
      eventCount: 0,
      segmentHash: "oversized",
    };
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        epoch: 1,
        frozenSeq: 1,
        tailHash: null,
        count: 0,
        segments: [oversized],
        direction: "forward",
        tailIncluded: false,
        hasMore: false,
        nextCursor: null,
        returnedWireBytes: new TextEncoder().encode(JSON.stringify(oversized))
          .byteLength,
      })
    );

    await expect(
      getSessionEvents("jwt-1", "org-1", "s-1", {
        boundedWirePage: true,
        cursor: { direction: "forward", afterSeq: 0 },
        includeTail: false,
        maxSegments: 16,
        maxWireBytes: 1024 * 1024,
      })
    ).rejects.toBeInstanceOf(CloudSessionWirePageContractError);
  });
});
