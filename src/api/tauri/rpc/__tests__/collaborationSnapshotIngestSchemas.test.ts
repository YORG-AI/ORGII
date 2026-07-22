import { describe, expect, it } from "vitest";

import * as schemas from "../schemas/collaborationSnapshotIngest";

const HASH = "a".repeat(64);

describe("collaboration snapshot ingest RPC contracts", () => {
  it("exposes read-only cursors only for imported snapshots", () => {
    expect(
      schemas.CollaborationSnapshotIngestGetCursorInputSchema.safeParse({
        request: { localSessionId: "imported-session-cloud-copy" },
      }).success
    ).toBe(true);
    expect(
      schemas.CollaborationSnapshotIngestGetCursorInputSchema.safeParse({
        request: { localSessionId: "agentsession-native-fork" },
      }).success
    ).toBe(false);
    expect(
      schemas.CollaborationSnapshotCursorSchema.nullable().parse(null)
    ).toBeNull();
  });

  it("allows a full native fork target but rejects native incremental ingest", () => {
    const fullFork = {
      localSessionId: "agentsession-cloud-fork",
      epoch: 1,
      expectedCount: 1,
      expectedFrozenSeq: 1,
      tailHash: null,
      replace: true,
    };
    expect(
      schemas.CollaborationSnapshotIngestBeginRequestSchema.safeParse(fullFork)
        .success
    ).toBe(true);
    expect(
      schemas.CollaborationSnapshotIngestBeginRequestSchema.safeParse({
        ...fullFork,
        replace: false,
        previous: {
          epoch: 1,
          frozenSeq: 0,
          count: 0,
          frozenCount: 0,
          tailHash: null,
        },
      }).success
    ).toBe(false);
  });

  it("exposes the secondary capability probe only for native Agent sessions", () => {
    expect(
      schemas.CollaborationSnapshotSecondaryProbeInputSchema.safeParse({
        request: { sessionId: "agentsession-cloud-fork" },
      }).success
    ).toBe(true);
    expect(
      schemas.CollaborationSnapshotSecondaryProbeInputSchema.safeParse({
        request: { sessionId: "sdeagent-native" },
      }).success
    ).toBe(false);
    expect(
      schemas.CollaborationSnapshotSecondaryProbeInputSchema.safeParse({
        request: { sessionId: "imported-session-cloud-copy" },
      }).success
    ).toBe(false);
  });

  it("accepts a bounded physical-wire page without SessionEvent arrays", () => {
    const parsed = schemas.CollaborationSnapshotIngestPageRequestSchema.parse({
      token: "00000000-0000-4000-8000-000000000001",
      epoch: 3,
      frozenSeq: 1,
      count: 1,
      tailHash: null,
      cursor: { direction: "forward", afterSeq: 0, throughSeq: 1 },
      nextCursor: null,
      tailIncluded: false,
      hasMore: false,
      returnedWireBytes: 128,
      segments: [
        {
          seq: 1,
          payloadGz: "opaque-compressed-base64",
          eventCount: 1,
          segmentHash: HASH,
        },
      ],
    });

    expect(parsed.segments[0]).not.toHaveProperty("events");
  });

  it("rejects unbounded pages and broken continuation symmetry", () => {
    const oversized =
      schemas.CollaborationSnapshotIngestPageRequestSchema.safeParse({
        token: "00000000-0000-4000-8000-000000000001",
        epoch: 3,
        frozenSeq: 0,
        count: 0,
        tailHash: null,
        cursor: { direction: "backward" },
        nextCursor: null,
        tailIncluded: false,
        hasMore: true,
        returnedWireBytes: 4 * 1024 * 1024 + 1,
        segments: [],
      });

    expect(oversized.success).toBe(false);
  });
});
