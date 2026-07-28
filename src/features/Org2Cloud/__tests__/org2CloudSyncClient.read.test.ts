import { beforeEach, describe, expect, it } from "vitest";

import {
  CloudSessionWirePageContractError,
  ORG2_CLOUD_OFFICIAL_SUPABASE_URL,
  __SESSION_LISTING_INTERNALS,
  fetchMock,
  getSessionEvents,
  isOrg2SyncErrorCode,
  jsonResponse,
  lastBody,
  lastCall,
  listOrgSessions,
} from "./support/org2CloudSyncClientTestHarness";

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
    expect(lastBody()).toEqual({
      p_org_id: "org-1",
      since: null,
      p_limit: 200,
      p_cursor_updated_at: null,
      p_cursor_session_id: null,
    });
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

  it("passes request cancellation through to the transport", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ sessions: [] }));
    const controller = new AbortController();
    await listOrgSessions("jwt-1", "org-1", undefined, controller.signal);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });
});

describe("cloud_get_session_events", () => {
  it("parses a bounded segments page", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        epoch: 4,
        frozenSeq: 2,
        tailHash: "th",
        count: 3,
        nextAfterSeq: 1,
        hasMore: false,
        segments: [
          { seq: 1, payloadGz: "abc", eventCount: 3, segmentHash: "h1" },
        ],
      })
    );
    const result = await getSessionEvents("jwt-1", "org-1", "s-1");
    expect(lastCall().url).toBe(
      `${ORG2_CLOUD_OFFICIAL_SUPABASE_URL}/rest/v1/rpc/cloud_get_session_events_page`
    );
    expect(lastBody()).toEqual({
      p_org_id: "org-1",
      p_session_id: "s-1",
      p_after_seq: 0,
      p_limit: 64,
    });
    expect(result.epoch).toBe(4);
    expect(result.segments[0].segmentHash).toBe("h1");
  });

  it("walks pages sequentially and pins the epoch after page one", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          epoch: 7,
          frozenSeq: 2,
          tailHash: "tail",
          count: 5,
          nextAfterSeq: 1,
          hasMore: true,
          segments: [
            { seq: 1, payloadGz: "one", eventCount: 2, segmentHash: "h1" },
          ],
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          epoch: 7,
          frozenSeq: 2,
          tailHash: "tail",
          count: 5,
          nextAfterSeq: 2,
          hasMore: false,
          segments: [
            { seq: 2, payloadGz: "two", eventCount: 2, segmentHash: "h2" },
            { seq: 0, payloadGz: "tail", eventCount: 1, segmentHash: "tail" },
          ],
        })
      );

    const result = await getSessionEvents("jwt-1", "org-1", "s-large", {
      shareToken: "share-token",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(
      String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body)
    ) as Record<string, unknown>;
    expect(secondBody).toEqual({
      p_org_id: "org-1",
      p_session_id: "s-large",
      p_after_seq: 1,
      p_limit: 64,
      p_expected_epoch: 7,
      p_share_token: "share-token",
    });
    expect(result.segments.map((segment) => segment.seq)).toEqual([1, 2, 0]);
  });

  it("falls back once for a backend that predates the paged RPC", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ message: "PGRST202 function was not found" }, 404)
      )
      .mockResolvedValueOnce(
        jsonResponse({
          epoch: 1,
          frozenSeq: 0,
          tailHash: null,
          count: 0,
          segments: [],
        })
      );

    const result = await getSessionEvents("jwt-1", "org-1", "s-small");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[1] as [string, RequestInit])[0]).toBe(
      `${ORG2_CLOUD_OFFICIAL_SUPABASE_URL}/rest/v1/rpc/cloud_get_session_events`
    );
    expect(result).toMatchObject({ epoch: 1, count: 0, segments: [] });
  });

  it("parses storagePath segments on the read wire", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        epoch: 4,
        frozenSeq: 1,
        tailHash: "th",
        count: 3,
        nextAfterSeq: 1,
        hasMore: false,
        segments: [
          {
            seq: 1,
            storagePath: "org-1/s-1/4/1-h1.gz",
            payloadGz: null,
            eventCount: 2,
            segmentHash: "h1",
          },
          { seq: 0, payloadGz: "tail", eventCount: 1, segmentHash: "th" },
        ],
      })
    );
    const result = await getSessionEvents("jwt-1", "org-1", "s-1");
    expect(result.segments[0].storagePath).toBe("org-1/s-1/4/1-h1.gz");
    expect(result.segments[0].payloadGz).toBeNull();
    expect(result.segments[1].payloadGz).toBe("tail");
  });

  it("rejects a segment carrying neither payloadGz nor storagePath", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        epoch: 1,
        frozenSeq: 1,
        tailHash: null,
        count: 1,
        nextAfterSeq: 1,
        hasMore: false,
        segments: [{ seq: 1, eventCount: 1, segmentHash: "h1" }],
      })
    );
    await expect(getSessionEvents("jwt-1", "org-1", "s-1")).rejects.toThrow(
      /neither payloadGz nor storagePath/
    );
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
      jsonResponse({
        epoch: null,
        nextAfterSeq: 0,
        hasMore: false,
        segments: [],
      })
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
      "https://db.custom.example.com/rest/v1/rpc/cloud_get_session_events_page"
    );
    expect(lastBody()).toEqual({
      p_org_id: "org-1",
      p_session_id: "s-1",
      p_after_seq: 0,
      p_limit: 64,
    });
  });
});

describe("cloud_list_org_sessions keyset pagination (0005)", () => {
  const row = (sessionId: string) => ({
    id: `org-1:u-2:${sessionId}`,
    orgId: "org-1",
    ownerMemberId: "u-2",
    ownerUserId: "u-2",
    ownerDisplayName: "Bea",
    ownerIdentityKind: "human",
    sourceSessionId: sessionId,
    title: sessionId,
  });

  beforeEach(() => {
    __SESSION_LISTING_INTERNALS.resetPaginationSupport();
  });

  it("walks pages until the cursor disappears and concatenates rows", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        serverTime: "2026-07-23T00:00:00.000Z",
        sessions: [row("s-1"), row("s-2")],
        nextCursor: { updatedAt: "2026-07-22T00:00:00.000Z", sessionId: "s-2" },
      })
    );
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        serverTime: "2026-07-23T00:00:01.000Z",
        sessions: [row("s-3")],
      })
    );

    const result = await listOrgSessions("jwt-1", "org-1");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(
      String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body)
    );
    expect(secondBody.p_cursor_updated_at).toBe("2026-07-22T00:00:00.000Z");
    expect(secondBody.p_cursor_session_id).toBe("s-2");
    expect(result.sessions.map((s) => s.sourceSessionId)).toEqual([
      "s-1",
      "s-2",
      "s-3",
    ]);
  });

  it("falls back to the legacy call on a pre-0005 backend and remembers it", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          message:
            "Could not find the function org2_cloud.cloud_list_org_sessions",
        },
        404
      )
    );
    fetchMock.mockResolvedValueOnce(jsonResponse({ sessions: [row("s-1")] }));

    const result = await listOrgSessions("jwt-1", "org-1");
    expect(result.sessions).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(lastBody()).toEqual({ p_org_id: "org-1", since: null });

    fetchMock.mockResolvedValueOnce(jsonResponse({ sessions: [] }));
    await listOrgSessions("jwt-1", "org-1");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(lastBody()).toEqual({ p_org_id: "org-1", since: null });
  });

  it("keeps delta pulls single-shot with the legacy body", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ sessions: [] }));
    await listOrgSessions("jwt-1", "org-1", "2026-07-22T00:00:00.000Z");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lastBody()).toEqual({
      p_org_id: "org-1",
      since: "2026-07-22T00:00:00.000Z",
    });
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

  it("stops reading when a response exceeds the legacy migration body cap", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("{}", {
        headers: {
          "content-type": "application/json",
          "content-length": String(70 * 1024 * 1024),
        },
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
    ).rejects.toThrow(/response (declares|exceeded)/);
  });

  it("admits one oversized legacy V1 candidate for Rust verification", async () => {
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

    const page = await getSessionEvents("jwt-1", "org-1", "s-1", {
      boundedWirePage: true,
      cursor: { direction: "forward", afterSeq: 0 },
      includeTail: false,
      maxSegments: 16,
      maxWireBytes: 1024 * 1024,
    });
    expect(page.segments).toEqual([oversized]);
  });

  it("rejects pages with two oversized legacy candidates", async () => {
    const oversized = (seq: number) => ({
      seq,
      payloadGz: "x".repeat(257 * 1024),
      eventCount: 1,
      segmentHash: `oversized-${seq}`,
    });
    const segments = [oversized(1), oversized(2)];
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        epoch: 1,
        frozenSeq: 2,
        tailHash: null,
        count: 2,
        segments,
        direction: "forward",
        tailIncluded: false,
        hasMore: false,
        nextCursor: null,
        returnedWireBytes: segments.reduce(
          (total, segment) =>
            total +
            new TextEncoder().encode(JSON.stringify(segment)).byteLength,
          0
        ),
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
