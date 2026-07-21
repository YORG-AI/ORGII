import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import {
  toFrozenSegmentWire,
  toTailWire,
} from "../TeamCollaboration/sync/segmentCodec";
import {
  buildCloudSessionFetchClient,
  cloudSessionIdFromRowId,
} from "./org2CloudBackendAdapter";
import type { CloudSessionEventsSnapshot } from "./org2CloudSyncClient";
import { Org2CloudSyncError, isOrg2SyncErrorCode } from "./org2CloudSyncClient";

vi.mock("./org2CloudSyncClient", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return { ...actual, getSessionEvents: vi.fn() };
});

const { getSessionEvents } = await import("./org2CloudSyncClient");
const getSessionEventsMock = vi.mocked(getSessionEvents);

function makeEvent(id: string): SessionEvent {
  return {
    id,
    displayStatus: "completed",
    payload: { text: `event ${id}` },
  } as unknown as SessionEvent;
}

const frozen1 = [makeEvent("f1"), makeEvent("f2")];
const frozen2 = [makeEvent("f3")];
const tail = [makeEvent("t1"), makeEvent("t2")];

async function cloudSnapshot(): Promise<CloudSessionEventsSnapshot> {
  const tailWire = await toTailWire(tail);
  return {
    epoch: 2,
    frozenSeq: 2,
    tailHash: tailWire!.segmentHash,
    count: 5,
    segments: [
      await toFrozenSegmentWire({ seq: 1, events: frozen1 }),
      await toFrozenSegmentWire({ seq: 2, events: frozen2 }),
      // Tail is the seq-0 row on the cloud wire (self-hosted marks it with
      // an isTail flag instead).
      { ...tailWire!, seq: 0 },
    ],
  };
}

describe("buildCloudSessionFetchClient", () => {
  beforeEach(() => {
    getSessionEventsMock.mockReset();
  });

  it("maps the cloud response into the self-hosted snapshot shape", async () => {
    getSessionEventsMock.mockResolvedValue(await cloudSnapshot());
    const client = buildCloudSessionFetchClient("jwt-token");

    const snapshot = await client.getSessionEventSegments({
      orgId: "org-1",
      sessionRowId: "org-1:user-1:agentsession-abc",
    });

    // JWT + bare cloud session id (not the composite row id) on the wire;
    // no shareToken → no options (member path stays byte-identical).
    expect(getSessionEventsMock).toHaveBeenCalledWith(
      "jwt-token",
      "org-1",
      "agentsession-abc",
      undefined
    );

    expect(snapshot.epoch).toBe(2);
    expect(snapshot.frozenSeq).toBe(2);
    expect(snapshot.count).toBe(5);
    expect(snapshot.tailHash).toBe((await toTailWire(tail))!.segmentHash);
    expect(snapshot.segments).toHaveLength(3);

    const [seg1, seg2, tailSeg] = snapshot.segments;
    expect(seg1).toMatchObject({ seq: 1, isTail: false, eventCount: 2 });
    expect(seg1.events).toEqual(frozen1);
    expect(seg2).toMatchObject({ seq: 2, isTail: false, eventCount: 1 });
    expect(seg2.events).toEqual(frozen2);
    expect(tailSeg).toMatchObject({ seq: 0, isTail: true, eventCount: 2 });
    expect(tailSeg.events).toEqual(tail);
  });

  it("passes afterSeq to the server range read and drops any smuggled prefix", async () => {
    getSessionEventsMock.mockResolvedValue(await cloudSnapshot());
    const client = buildCloudSessionFetchClient("jwt-token");

    const snapshot = await client.getSessionEventSegments({
      orgId: "org-1",
      sessionRowId: "org-1:user-1:agentsession-abc",
      afterSeq: 1,
    });

    // The cursor rides the wire (p_after_seq server-side range read).
    expect(getSessionEventsMock).toHaveBeenCalledWith(
      "jwt-token",
      "org-1",
      "agentsession-abc",
      { afterSeq: 1 }
    );
    // Defense in depth: a legacy/full response must still be filtered so an
    // already-held frozen prefix never re-enters the incremental splice.
    expect(snapshot.segments.map((s) => s.seq)).toEqual([2, 0]);
    expect(snapshot.segments.map((s) => s.isTail)).toEqual([false, true]);
  });

  it("registered non-member path threads JWT and share token (0012)", async () => {
    getSessionEventsMock.mockResolvedValue({
      epoch: 1,
      frozenSeq: 0,
      tailHash: null,
      count: 0,
      segments: [],
    });
    const client = buildCloudSessionFetchClient("jwt-non-member");

    await client.getSessionEventSegments({
      orgId: "org-1",
      sessionRowId: "org-1:user-1:agentsession-abc",
      shareToken: "t".repeat(64),
    });

    expect(getSessionEventsMock).toHaveBeenCalledWith(
      "jwt-non-member",
      "org-1",
      "agentsession-abc",
      { shareToken: "t".repeat(64) }
    );
  });

  it("pins registered-link segment reads to the endpoint used for resolve", async () => {
    getSessionEventsMock.mockResolvedValue({
      epoch: 1,
      frozenSeq: 0,
      tailHash: null,
      count: 0,
      segments: [],
    });
    const endpoint = {
      webOrigin: "https://app.custom.example.com",
      supabaseUrl: "https://db.custom.example.com",
      anonKey: "custom-anon",
      isOfficial: false,
    };
    const client = buildCloudSessionFetchClient("jwt-non-member", endpoint);

    await client.getSessionEventSegments({
      orgId: "org-1",
      sessionRowId: "org-1:user-1:agentsession-abc",
      shareToken: "t".repeat(64),
    });

    expect(getSessionEventsMock).toHaveBeenCalledWith(
      "jwt-non-member",
      "org-1",
      "agentsession-abc",
      { shareToken: "t".repeat(64), endpoint }
    );
  });

  it("propagates ORG2_RETENTION_EXPIRED unswallowed", async () => {
    getSessionEventsMock.mockRejectedValue(
      new Org2CloudSyncError("ORG2_RETENTION_EXPIRED", 400)
    );
    const client = buildCloudSessionFetchClient("jwt-token");

    const attempt = client.getSessionEventSegments({
      orgId: "org-1",
      sessionRowId: "org-1:user-1:agentsession-abc",
    });

    await expect(attempt).rejects.toSatisfy((error: unknown) =>
      isOrg2SyncErrorCode(error, "ORG2_RETENTION_EXPIRED")
    );
  });

  it("passes an empty (never-published) summary through as nulls", async () => {
    getSessionEventsMock.mockResolvedValue({
      epoch: null,
      frozenSeq: null,
      tailHash: null,
      count: null,
      segments: [],
    });
    const client = buildCloudSessionFetchClient("jwt-token");

    const snapshot = await client.getSessionEventSegments({
      orgId: "org-1",
      sessionRowId: "agentsession-bare-id",
    });

    expect(getSessionEventsMock).toHaveBeenCalledWith(
      "jwt-token",
      "org-1",
      "agentsession-bare-id",
      undefined
    );
    expect(snapshot).toEqual({
      epoch: null,
      frozenSeq: null,
      tailHash: null,
      count: null,
      segments: [],
    });
  });
});

describe("cloudSessionIdFromRowId", () => {
  it("extracts the bare session id from a composite row id", () => {
    expect(cloudSessionIdFromRowId("org:user:agentsession-x")).toBe(
      "agentsession-x"
    );
    // Session ids may themselves contain colons — everything after the
    // second colon belongs to the id.
    expect(cloudSessionIdFromRowId("org:user:a:b")).toBe("a:b");
    expect(cloudSessionIdFromRowId("agentsession-x")).toBe("agentsession-x");
  });
});
