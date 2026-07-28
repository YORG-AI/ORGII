import { beforeEach, describe, expect, it } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import {
  ORG2_CLOUD_OFFICIAL_SUPABASE_URL,
  Org2CloudSyncError,
  appendSessionEvents,
  bytesToBase64,
  capabilitiesMock,
  computeSegmentHash,
  decodeSegmentEventsFromBytes,
  fetchMock,
  jsonResponse,
  lastBody,
  lastCall,
  makeEvent,
  rewriteSessionEvents,
  uploadSessionEventWires,
} from "./support/org2CloudSyncClientTestHarness";

describe("storage segment offload (0006)", () => {
  beforeEach(() => {
    capabilitiesMock.mockResolvedValue({
      broadcastSignals: false,
      storageSegments: true,
      homeEndpoints: false,
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

  it("uploads opaque Rust wires and returns compact epoch references", async () => {
    const gzip = new Uint8Array([31, 139, 8, 0, 1, 2, 3, 4]);
    const stored = await uploadSessionEventWires("jwt-1", {
      orgId: "org-1",
      sessionId: "s-1",
      epoch: 9,
      frozenSegments: [
        {
          seq: 7,
          payloadGz: bytesToBase64(gzip),
          eventCount: 1,
          segmentHash: "opaque-hash",
        },
      ],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0] as [string, RequestInit])[0]).toBe(
      `${ORG2_CLOUD_OFFICIAL_SUPABASE_URL}/storage/v1/object/replay/org-1/s-1/9/7-opaque-hash.gz`
    );
    expect(
      Array.from(
        (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as Uint8Array
      )
    ).toEqual(Array.from(gzip));
    expect(stored).toEqual([
      {
        seq: 7,
        storagePath: "org-1/s-1/9/7-opaque-hash.gz",
        eventCount: 1,
        segmentHash: "opaque-hash",
      },
    ]);
  });

  it("fails before publication when storage segments are unavailable", async () => {
    capabilitiesMock.mockResolvedValue({
      broadcastSignals: false,
      storageSegments: false,
      homeEndpoints: false,
    });
    await expect(
      uploadSessionEventWires("jwt-1", {
        orgId: "org-1",
        sessionId: "s-1",
        epoch: 9,
        frozenSegments: [
          {
            seq: 1,
            payloadGz: bytesToBase64(new Uint8Array([31, 139])),
            eventCount: 1,
            segmentHash: "hash",
          },
        ],
      })
    ).rejects.toThrow(/storage-segment support/);
    expect(fetchMock).not.toHaveBeenCalled();
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
