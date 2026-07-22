import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildCloudSessionWirePageClient,
  cloudSessionIdFromRowId,
} from "./org2CloudBackendAdapter";
import type { CloudSessionEventWirePage } from "./org2CloudSyncClient";
import { Org2CloudSyncError, isOrg2SyncErrorCode } from "./org2CloudSyncClient";

vi.mock("./org2CloudSyncClient", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return { ...actual, getSessionEvents: vi.fn() };
});

const { getSessionEvents } = await import("./org2CloudSyncClient");
const getSessionEventsMock = vi.mocked(getSessionEvents);

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

describe("cloud bounded replay adapter", () => {
  beforeEach(() => {
    getSessionEventsMock.mockReset();
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
    expect(result).toBe(page);
    expect(result.segments[0]).toBe(wire);
    expect(result.segments[0]).not.toHaveProperty("events");
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
    const page = emptyPage();
    getSessionEventsMock.mockResolvedValue(page);
    const client = buildCloudSessionWirePageClient("jwt-token");

    const result = await client.getSessionEventWirePage({
      orgId: "org-1",
      sessionRowId: "agentsession-bare-id",
      cursor: { direction: "backward" },
      includeTail: true,
      maxSegments: 16,
      maxWireBytes: 1024,
    });

    expect(result).toEqual(page);
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
