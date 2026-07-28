import { describe, expect, it } from "vitest";

import {
  ORG2_CLOUD_OFFICIAL_ANON_KEY,
  ORG2_CLOUD_OFFICIAL_SUPABASE_URL,
  ORG2_CLOUD_POSTGREST_SCHEMA,
  Org2CloudSyncError,
  appendSessionEventWires,
  appendSessionEvents,
  decodeSegmentEvents,
  fetchMock,
  getOrgRepoScopes,
  isOrg2SyncErrorCode,
  jsonResponse,
  lastBody,
  lastCall,
  makeEvent,
  rewriteSessionEventWires,
  rewriteSessionEvents,
  setOrgRepoScopes,
  upsertSessionMetadata,
} from "./support/org2CloudSyncClientTestHarness";

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

  it("publishes a complete stored-reference epoch in one rewrite RPC", async () => {
    const stored = Array.from({ length: 32 }, (_, index) => ({
      seq: index + 1,
      storagePath: `org-1/s-1/5/${index + 1}-hash-${index}.gz`,
      eventCount: 1,
      segmentHash: `hash-${index}`,
    }));
    await rewriteSessionEventWires("jwt-1", {
      orgId: "org-1",
      sessionId: "s-1",
      newEpoch: 5,
      frozenSegments: stored,
      tail: null,
      totalCount: stored.length,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lastBody().frozen_segments).toEqual(stored);
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
