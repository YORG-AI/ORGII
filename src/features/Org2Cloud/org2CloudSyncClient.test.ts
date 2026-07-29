import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import { computeSegmentHash } from "../TeamCollaboration/sync/collabGzip";
import {
  decodeSegmentEvents,
  decodeSegmentEventsFromBytes,
} from "../TeamCollaboration/sync/segmentCodec";
import {
  ORG2_CLOUD_OFFICIAL_ANON_KEY,
  ORG2_CLOUD_OFFICIAL_SUPABASE_URL,
  ORG2_CLOUD_POSTGREST_SCHEMA,
} from "./config";
import { getCloudCapabilities } from "./org2CloudCapabilities";
import {
  Org2CloudSyncError,
  __SESSION_LISTING_INTERNALS,
  __STORAGE_SEGMENTS_INTERNALS,
  appendSessionEvents,
  getOrgRepoScopes,
  getSessionEvents,
  isOrg2SyncErrorCode,
  listOrgSessions,
  rewriteSessionEvents,
  setOrgRepoScopes,
  upsertSessionMetadata,
} from "./org2CloudSyncClient";

vi.mock("./org2CloudCapabilities", () => ({
  getCloudCapabilities: vi.fn(),
}));

const capabilitiesMock = vi.mocked(getCloudCapabilities);

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
  capabilitiesMock.mockResolvedValue({
    broadcastSignals: false,
    storageSegments: false,
    homeEndpoints: false,
    teamInboxMentions: false,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  capabilitiesMock.mockReset();
  __STORAGE_SEGMENTS_INTERNALS.resetStorageSupport();
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

describe("storage segment offload (0006)", () => {
  beforeEach(() => {
    capabilitiesMock.mockResolvedValue({
      broadcastSignals: false,
      storageSegments: true,
      homeEndpoints: false,
      teamInboxMentions: false,
    });
  });

  function appendInput(frozen: SessionEvent[], tail: SessionEvent[] | null) {
    return {
      orgId: "org-1",
      sessionId: "s-1",
      expectedEpoch: 2,
      expectedFrozenSeq: 5,
      expectedTailHash: "hash-old-tail",
      newFrozenSegments: frozen.length > 0 ? [{ seq: 6, events: frozen }] : [],
      tail,
      totalCount: 7,
    };
  }

  it("uploads frozen segment objects and ships storagePath wire with an inline tail", async () => {
    const frozen = [makeEvent("f1")];
    const tail = [makeEvent("t1")];
    await appendSessionEvents("jwt-1", appendInput(frozen, tail));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const hash = await computeSegmentHash(frozen);
    const path = `org-1/s-1/2/6-${hash}.gz`;
    const [uploadUrl, uploadInit] = fetchMock.mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(uploadUrl).toBe(
      `${ORG2_CLOUD_OFFICIAL_SUPABASE_URL}/storage/v1/object/replay/${path}`
    );
    expect(uploadInit.method).toBe("POST");
    const uploadHeaders = uploadInit.headers as Record<string, string>;
    expect(uploadHeaders.authorization).toBe("Bearer jwt-1");
    expect(uploadHeaders["content-type"]).toBe("application/gzip");
    expect(uploadHeaders["x-upsert"]).toBeUndefined();
    expect(
      await decodeSegmentEventsFromBytes(uploadInit.body as Uint8Array)
    ).toEqual(frozen);

    expect(lastCall().url).toBe(
      `${ORG2_CLOUD_OFFICIAL_SUPABASE_URL}/rest/v1/rpc/cloud_append_session_events`
    );
    const body = lastBody();
    expect(body.new_frozen_segments).toEqual([
      { seq: 6, storagePath: path, eventCount: 1, segmentHash: hash },
    ]);
    const tailWire = body.tail as Record<string, unknown>;
    expect(typeof tailWire.payloadGz).toBe("string");
    expect(tailWire).not.toHaveProperty("storagePath");
  });

  it("rewrite keys the object paths by the new epoch", async () => {
    const frozen = [makeEvent("f1")];
    await rewriteSessionEvents("jwt-1", {
      orgId: "org-1",
      sessionId: "s-1",
      newEpoch: 4,
      frozenSegments: [{ seq: 1, events: frozen }],
      tail: null,
      totalCount: 1,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const hash = await computeSegmentHash(frozen);
    const path = `org-1/s-1/4/1-${hash}.gz`;
    expect((fetchMock.mock.calls[0] as [string, RequestInit])[0]).toBe(
      `${ORG2_CLOUD_OFFICIAL_SUPABASE_URL}/storage/v1/object/replay/${path}`
    );
    const body = lastBody();
    expect(body.new_epoch).toBe(4);
    expect(body.frozen_segments).toEqual([
      { seq: 1, storagePath: path, eventCount: 1, segmentHash: hash },
    ]);
  });

  it("keeps the legacy inline wire when the capabilities probe says false", async () => {
    capabilitiesMock.mockResolvedValue({
      broadcastSignals: false,
      storageSegments: false,
      homeEndpoints: false,
      teamInboxMentions: false,
    });
    await appendSessionEvents("jwt-1", appendInput([makeEvent("f1")], null));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const segments = lastBody().new_frozen_segments as Array<
      Record<string, unknown>
    >;
    expect(typeof segments[0].payloadGz).toBe("string");
    expect(segments[0]).not.toHaveProperty("storagePath");
  });

  it("skips the probe and uploads entirely for a tail-only append", async () => {
    await appendSessionEvents("jwt-1", appendInput([], [makeEvent("t1")]));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(capabilitiesMock).not.toHaveBeenCalled();
    expect(lastBody().new_frozen_segments).toEqual([]);
  });

  it("falls back to the inline wire on a missing-function rejection and remembers the endpoint", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(null))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            code: "PGRST202",
            message:
              "Could not find the function org2_cloud.cloud_append_session_events in the schema cache",
          },
          404
        )
      )
      .mockResolvedValueOnce(jsonResponse(null));
    await appendSessionEvents("jwt-1", appendInput([makeEvent("f1")], null));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const segments = lastBody().new_frozen_segments as Array<
      Record<string, unknown>
    >;
    expect(typeof segments[0].payloadGz).toBe("string");
    expect(segments[0]).not.toHaveProperty("storagePath");

    fetchMock.mockResolvedValueOnce(jsonResponse(null));
    await appendSessionEvents("jwt-1", appendInput([makeEvent("f2")], null));
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(String(lastCall().url)).toContain("/rest/v1/rpc/");
  });

  it("propagates ORG2_VALIDATION on the storage form without falling back", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(null))
      .mockResolvedValueOnce(jsonResponse({ message: "ORG2_VALIDATION" }, 400));
    const error = await appendSessionEvents(
      "jwt-1",
      appendInput([makeEvent("f1")], null)
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Org2CloudSyncError);
    expect((error as Org2CloudSyncError).message).toContain("ORG2_VALIDATION");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("propagates an upload failure before any RPC is attempted", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 403 }));
    await expect(
      appendSessionEvents("jwt-1", appendInput([makeEvent("f1")], null))
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof Error && error.name === "Org2CloudStorageError"
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
});
