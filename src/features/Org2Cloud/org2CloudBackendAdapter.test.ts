import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import { bytesToBase64 } from "../TeamCollaboration/sync/collabGzip";
import { toFrozenSegmentStorage } from "../TeamCollaboration/sync/segmentCodec";
import {
  buildCloudSessionWirePageClient,
  cloudSessionIdFromRowId,
} from "./org2CloudBackendAdapter";
import { createGuestReplayObjectReader } from "./org2CloudReplaySignedReads";
import { downloadReplayObject } from "./org2CloudStorageClient";
import type { CloudSessionEventWirePage } from "./org2CloudSyncClient";
import { Org2CloudSyncError, isOrg2SyncErrorCode } from "./org2CloudSyncClient";

vi.mock("./org2CloudSyncClient", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return { ...actual, getSessionEvents: vi.fn() };
});

vi.mock("./org2CloudStorageClient", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return { ...actual, downloadReplayObject: vi.fn() };
});

vi.mock("./org2CloudReplaySignedReads", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return { ...actual, createGuestReplayObjectReader: vi.fn() };
});

const { getSessionEvents } = await import("./org2CloudSyncClient");
const getSessionEventsMock = vi.mocked(getSessionEvents);
const downloadReplayObjectMock = vi.mocked(downloadReplayObject);
const createGuestReaderMock = vi.mocked(createGuestReplayObjectReader);

function emptyPage(): CloudSessionEventWirePage {
  return {
    epoch: null,
    frozenSeq: null,
    tailHash: null,
    count: null,
    segments: [],
    tailIncluded: true,
    hasMore: false,
    nextCursor: null,
    returnedWireBytes: 0,
  };
}

function makeEvent(id: string): SessionEvent {
  return {
    id,
    displayStatus: "completed",
    payload: { text: `event ${id}` },
  } as unknown as SessionEvent;
}

describe("cloud bounded replay adapter", () => {
  beforeEach(() => {
    getSessionEventsMock.mockReset();
    downloadReplayObjectMock.mockReset();
    createGuestReaderMock.mockReset();
  });

  it("passes through a bounded raw page without renderer decoding", async () => {
    const wire = {
      seq: 42,
      payloadGz: "opaque-v2-continuation",
      eventCount: 0,
      segmentHash: "physical-hash",
    };
    const page: CloudSessionEventWirePage = {
      epoch: 3,
      frozenSeq: 100,
      tailHash: null,
      count: 80,
      segments: [wire],
      tailIncluded: true,
      hasMore: true,
      nextCursor: { direction: "backward", beforeSeq: 42 },
      returnedWireBytes: new TextEncoder().encode(JSON.stringify(wire))
        .byteLength,
    };
    getSessionEventsMock.mockResolvedValue(page);
    const client = buildCloudSessionWirePageClient("jwt-token");

    const result = await client.getSessionEventWirePage({
      orgId: "org-1",
      sessionRowId: "org-1:user-1:agentsession-abc",
      cursor: { direction: "backward" },
      includeTail: true,
      maxSegments: 16,
      maxWireBytes: 1024 * 1024,
    });

    expect(getSessionEventsMock).toHaveBeenCalledWith(
      "jwt-token",
      "org-1",
      "agentsession-abc",
      {
        boundedWirePage: true,
        cursor: { direction: "backward" },
        includeTail: true,
        maxSegments: 16,
        maxWireBytes: 1024 * 1024,
      }
    );
    expect(result).toMatchObject({
      epoch: 3,
      frozenSeq: 100,
      segments: [wire],
      nextCursor: { direction: "backward", beforeSeq: 42 },
    });
    expect(result.segments[0]).not.toHaveProperty("events");
    expect(downloadReplayObjectMock).not.toHaveBeenCalled();
  });

  it("passes one oversized legacy candidate through for Rust verification", async () => {
    const wire = {
      seq: 1,
      payloadGz: "x".repeat(257 * 1024),
      eventCount: 1,
      segmentHash: "legacy-hash",
    };
    getSessionEventsMock.mockResolvedValue({
      ...emptyPage(),
      epoch: 1,
      frozenSeq: 1,
      count: 1,
      segments: [wire],
      returnedWireBytes: 100,
    } as CloudSessionEventWirePage);
    const client = buildCloudSessionWirePageClient("jwt-token");

    const result = await client.getSessionEventWirePage({
      orgId: "org-1",
      sessionRowId: "agentsession-legacy",
      cursor: { direction: "backward" },
      includeTail: true,
      maxSegments: 16,
      maxWireBytes: 1024 * 1024,
    });

    expect(result.segments).toEqual([wire]);
  });

  it("rejects two oversized legacy candidates in one materialized page", async () => {
    const segments = [1, 2].map((seq) => ({
      seq,
      payloadGz: "x".repeat(257 * 1024),
      eventCount: 1,
      segmentHash: `legacy-${seq}`,
    }));
    getSessionEventsMock.mockResolvedValue({
      ...emptyPage(),
      epoch: 1,
      frozenSeq: 2,
      count: 2,
      segments,
      returnedWireBytes: 200,
    } as CloudSessionEventWirePage);
    const client = buildCloudSessionWirePageClient("jwt-token");

    await expect(
      client.getSessionEventWirePage({
        orgId: "org-1",
        sessionRowId: "agentsession-legacy",
        cursor: { direction: "backward" },
        includeTail: true,
        maxSegments: 16,
        maxWireBytes: 1024 * 1024,
      })
    ).rejects.toThrow(/more than one oversized legacy V1 candidate/);
  });

  it("materializes a storage row as opaque gzip without parsing events", async () => {
    const stored = await toFrozenSegmentStorage({
      seq: 7,
      events: [makeEvent("stored")],
    });
    const storagePath = `org-1/session/1/7-${stored.segmentHash}.gz`;
    getSessionEventsMock.mockResolvedValue({
      epoch: 1,
      frozenSeq: 7,
      tailHash: null,
      count: 1,
      segments: [
        {
          seq: 7,
          storagePath,
          eventCount: stored.eventCount,
          segmentHash: stored.segmentHash,
        },
      ],
      tailIncluded: false,
      hasMore: false,
      nextCursor: null,
      returnedWireBytes: 64,
    } as CloudSessionEventWirePage);
    downloadReplayObjectMock.mockResolvedValue(stored.bytes);
    const endpoint = {
      webOrigin: "https://app.custom.example.com",
      supabaseUrl: "https://db.custom.example.com",
      anonKey: "custom-anon",
      isOfficial: false,
    };
    const controller = new AbortController();
    const client = buildCloudSessionWirePageClient("jwt-token", endpoint);

    const result = await client.getSessionEventWirePage({
      orgId: "org-1",
      sessionRowId: "org-1:user-1:session",
      cursor: { direction: "forward", afterSeq: 6 },
      includeTail: false,
      maxSegments: 1,
      maxWireBytes: 1024 * 1024,
      signal: controller.signal,
    });

    expect(downloadReplayObjectMock).toHaveBeenCalledWith(
      "jwt-token",
      storagePath,
      endpoint,
      controller.signal
    );
    expect(result.segments).toEqual([
      {
        seq: 7,
        payloadGz: bytesToBase64(stored.bytes),
        eventCount: stored.eventCount,
        segmentHash: stored.segmentHash,
      },
    ]);
    expect(result.segments[0]).not.toHaveProperty("events");
    expect(createGuestReaderMock).not.toHaveBeenCalled();
  });

  it("reads share-token storage rows through the signed-url flow", async () => {
    const stored = await toFrozenSegmentStorage({
      seq: 1,
      events: [makeEvent("shared")],
    });
    const storagePath = `org-1/agentsession-abc/1/1-${stored.segmentHash}.gz`;
    getSessionEventsMock.mockResolvedValue({
      ...emptyPage(),
      epoch: 1,
      frozenSeq: 1,
      count: 1,
      segments: [
        {
          seq: 1,
          storagePath,
          eventCount: stored.eventCount,
          segmentHash: stored.segmentHash,
        },
      ],
    });
    const download = vi.fn(async () => stored.bytes);
    createGuestReaderMock.mockReturnValue({ download });
    const endpoint = {
      webOrigin: "https://app.custom.example.com",
      supabaseUrl: "https://db.custom.example.com",
      anonKey: "custom-anon",
      isOfficial: false,
    };
    const client = buildCloudSessionWirePageClient("jwt-guest", endpoint);
    const input = {
      orgId: "org-1",
      sessionRowId: "org-1:user-1:agentsession-abc",
      cursor: { direction: "backward" as const },
      includeTail: true,
      maxSegments: 16,
      maxWireBytes: 1024 * 1024,
      shareToken: "t".repeat(64),
    };

    const first = await client.getSessionEventWirePage(input);
    const second = await client.getSessionEventWirePage(input);

    expect(createGuestReaderMock).toHaveBeenCalledTimes(1);
    expect(createGuestReaderMock).toHaveBeenCalledWith({
      orgId: "org-1",
      sessionId: "agentsession-abc",
      shareToken: "t".repeat(64),
      endpoint,
    });
    expect(download).toHaveBeenCalledTimes(2);
    expect(download).toHaveBeenCalledWith(storagePath, undefined);
    expect(downloadReplayObjectMock).not.toHaveBeenCalled();
    expect(first.segments[0]).toEqual({
      seq: 1,
      payloadGz: bytesToBase64(stored.bytes),
      eventCount: stored.eventCount,
      segmentHash: stored.segmentHash,
    });
    expect(second.segments[0]).not.toHaveProperty("events");
  });

  it("falls back to the member storage read when signer RPC is missing", async () => {
    const stored = await toFrozenSegmentStorage({
      seq: 1,
      events: [makeEvent("fallback")],
    });
    const storagePath = `org-1/agentsession-abc/1/1-${stored.segmentHash}.gz`;
    getSessionEventsMock.mockResolvedValue({
      ...emptyPage(),
      epoch: 1,
      frozenSeq: 1,
      count: 1,
      segments: [
        {
          seq: 1,
          storagePath,
          eventCount: stored.eventCount,
          segmentHash: stored.segmentHash,
        },
      ],
    });
    createGuestReaderMock.mockReturnValue({
      download: vi.fn(async () => {
        throw new Org2CloudSyncError("Could not find the function", 404);
      }),
    });
    downloadReplayObjectMock.mockResolvedValue(stored.bytes);
    const client = buildCloudSessionWirePageClient("jwt-guest");

    const result = await client.getSessionEventWirePage({
      orgId: "org-1",
      sessionRowId: "org-1:user-1:agentsession-abc",
      cursor: { direction: "backward" },
      includeTail: true,
      maxSegments: 16,
      maxWireBytes: 1024 * 1024,
      shareToken: "t".repeat(64),
    });

    expect(downloadReplayObjectMock).toHaveBeenCalledWith(
      "jwt-guest",
      storagePath,
      undefined,
      undefined
    );
    expect(result.segments[0].payloadGz).toBe(bytesToBase64(stored.bytes));
  });

  it("propagates signed-read authorization failures without member fallback", async () => {
    const storagePath = "org-1/agentsession-abc/1/1-hash.gz";
    getSessionEventsMock.mockResolvedValue({
      ...emptyPage(),
      epoch: 1,
      frozenSeq: 1,
      count: 1,
      segments: [
        {
          seq: 1,
          storagePath,
          eventCount: 1,
          segmentHash: "hash",
        },
      ],
    });
    createGuestReaderMock.mockReturnValue({
      download: vi.fn(async () => {
        throw new Org2CloudSyncError("ORG2_FORBIDDEN", 403);
      }),
    });
    const client = buildCloudSessionWirePageClient("jwt-guest");

    await expect(
      client.getSessionEventWirePage({
        orgId: "org-1",
        sessionRowId: "org-1:user-1:agentsession-abc",
        cursor: { direction: "backward" },
        includeTail: true,
        maxSegments: 16,
        maxWireBytes: 1024 * 1024,
        shareToken: "t".repeat(64),
      })
    ).rejects.toSatisfy((error: unknown) =>
      isOrg2SyncErrorCode(error, "ORG2_FORBIDDEN")
    );
    expect(downloadReplayObjectMock).not.toHaveBeenCalled();
  });

  it("threads share capability, endpoint and cancellation on the raw path", async () => {
    getSessionEventsMock.mockResolvedValue(emptyPage());
    const endpoint = {
      webOrigin: "https://app.custom.example.com",
      supabaseUrl: "https://db.custom.example.com",
      anonKey: "custom-anon",
      isOfficial: false,
    };
    const controller = new AbortController();
    const client = buildCloudSessionWirePageClient("jwt-guest", endpoint);

    await client.getSessionEventWirePage({
      orgId: "org-1",
      sessionRowId: "org-1:user-1:agentsession-abc",
      cursor: { direction: "forward", afterSeq: 4, throughSeq: 8 },
      includeTail: true,
      maxSegments: 16,
      maxWireBytes: 1024,
      shareToken: "share-token",
      signal: controller.signal,
    });

    expect(getSessionEventsMock).toHaveBeenCalledWith(
      "jwt-guest",
      "org-1",
      "agentsession-abc",
      expect.objectContaining({
        boundedWirePage: true,
        cursor: { direction: "forward", afterSeq: 4, throughSeq: 8 },
        endpoint,
        shareToken: "share-token",
        signal: controller.signal,
      })
    );
  });

  it("fails closed when a row has neither inline nor storage payload", async () => {
    getSessionEventsMock.mockResolvedValue({
      ...emptyPage(),
      segments: [{ seq: 1, eventCount: 1, segmentHash: "hash" }],
    } as unknown as CloudSessionEventWirePage);
    const client = buildCloudSessionWirePageClient("jwt-token");

    await expect(
      client.getSessionEventWirePage({
        orgId: "org-1",
        sessionRowId: "agentsession-bare-id",
        cursor: { direction: "backward" },
        includeTail: true,
        maxSegments: 16,
        maxWireBytes: 1024,
      })
    ).rejects.toThrow(/neither payloadGz nor storagePath/);
  });

  it("propagates retention errors without a decoded fallback", async () => {
    getSessionEventsMock.mockRejectedValue(
      new Org2CloudSyncError("ORG2_RETENTION_EXPIRED", 400)
    );
    const client = buildCloudSessionWirePageClient("jwt-token");

    const attempt = client.getSessionEventWirePage({
      orgId: "org-1",
      sessionRowId: "agentsession-bare-id",
      cursor: { direction: "backward" },
      includeTail: true,
      maxSegments: 16,
      maxWireBytes: 1024,
    });

    await expect(attempt).rejects.toSatisfy((error: unknown) =>
      isOrg2SyncErrorCode(error, "ORG2_RETENTION_EXPIRED")
    );
    expect(getSessionEventsMock).toHaveBeenCalledTimes(1);
  });

  it("passes through a never-published bounded summary", async () => {
    getSessionEventsMock.mockResolvedValue(emptyPage());
    const client = buildCloudSessionWirePageClient("jwt-token");

    const result = await client.getSessionEventWirePage({
      orgId: "org-1",
      sessionRowId: "agentsession-bare-id",
      cursor: { direction: "backward" },
      includeTail: true,
      maxSegments: 16,
      maxWireBytes: 1024,
    });

    expect(result).toEqual(emptyPage());
  });
});

describe("cloudSessionIdFromRowId", () => {
  it("extracts the bare id while preserving colons inside session ids", () => {
    expect(cloudSessionIdFromRowId("org:user:agentsession-x")).toBe(
      "agentsession-x"
    );
    expect(cloudSessionIdFromRowId("org:user:a:b")).toBe("a:b");
    expect(cloudSessionIdFromRowId("agentsession-x")).toBe("agentsession-x");
  });
});
