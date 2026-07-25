import { beforeEach, describe, expect, it, vi } from "vitest";

import { COLLAB_IDENTITY_KIND } from "@src/store/collaboration/types";
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";

import type {
  SessionEventWirePage,
  SessionEventWirePageCursor,
} from "../sync/CollabSyncBackend";
import {
  SESSION_EVENT_WIRE_MAX_PAGE_BYTES,
  SESSION_EVENT_WIRE_MAX_PAGE_SEGMENTS,
} from "../sync/CollabSyncBackend";
import { ingestRemoteSnapshot } from "./collabSnapshotIngest";

const ingestRpc = vi.hoisted(() => ({
  begin: vi.fn(),
  getCursor: vi.fn(),
  apply: vi.fn(),
  commit: vi.fn(),
  abort: vi.fn(),
}));
const logger = vi.hoisted(() => ({
  warn: vi.fn(),
}));

vi.mock("@src/api/tauri/collaborationSnapshotIngest", () => ({
  collaborationSnapshotIngestBegin: ingestRpc.begin,
  collaborationSnapshotIngestGetCursor: ingestRpc.getCursor,
  collaborationSnapshotIngestApplyWirePage: ingestRpc.apply,
  collaborationSnapshotIngestCommit: ingestRpc.commit,
  collaborationSnapshotIngestAbort: ingestRpc.abort,
}));
vi.mock("@src/hooks/logger", () => ({
  createLogger: () => logger,
}));

const HASH = "a".repeat(64);
const TOKEN = "00000000-0000-4000-8000-000000000001";

function makeRemote(
  overrides: Partial<RemoteTeammateSessionMetadata> = {}
): RemoteTeammateSessionMetadata {
  return {
    id: "org-1:m2:remote-1",
    orgId: "org-1",
    ownerMemberId: "m2",
    ownerUserId: "m2",
    ownerDisplayName: "Bob",
    ownerIdentityKind: COLLAB_IDENTITY_KIND.HUMAN,
    sourceSessionId: "remote-1",
    title: "Remote session",
    lastActivityAt: "2026-07-01T00:00:00.000Z",
    eventsEpoch: 3,
    eventsFrozenSeq: 3,
    eventsCount: 4,
    eventsTailHash: HASH,
    ...overrides,
  };
}

function page(
  cursor: SessionEventWirePageCursor,
  overrides: Partial<SessionEventWirePage> = {}
): SessionEventWirePage {
  const seq =
    cursor.direction === "backward"
      ? (cursor.beforeSeq ?? 3)
      : cursor.afterSeq + 1;
  return {
    epoch: 3,
    frozenSeq: 3,
    tailHash: HASH,
    count: 4,
    segments: [
      {
        seq,
        payloadGz: `opaque-${seq}`,
        eventCount: 1,
        segmentHash: HASH,
      },
    ],
    tailIncluded: false,
    hasMore: false,
    nextCursor: null,
    returnedWireBytes: 128,
    ...overrides,
  };
}

function commit(localSessionId = "imported-session-local") {
  return {
    localSessionId,
    epoch: 3,
    frozenSeq: 3,
    eventCount: 4,
    frozenEventCount: 3,
    tailHash: HASH,
    handoffItems: [],
    handoffScannedBytes: 0,
    handoffScannedEvents: 0,
  };
}

describe("ingestRemoteSnapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ingestRpc.begin.mockResolvedValue({ token: TOKEN });
    ingestRpc.getCursor.mockResolvedValue(null);
    ingestRpc.apply.mockResolvedValue({
      acceptedPhysicalRows: 1,
      acceptedLogicalEvents: 1,
      complete: true,
    });
    ingestRpc.commit.mockResolvedValue(commit());
    ingestRpc.abort.mockResolvedValue(undefined);
  });

  it("streams a cold snapshot backward in bounded opaque pages", async () => {
    const olderCursor = { direction: "backward", beforeSeq: 2 } as const;
    const getSessionEventWirePage = vi
      .fn()
      .mockResolvedValueOnce(
        page(
          { direction: "backward" },
          {
            tailIncluded: true,
            hasMore: true,
            nextCursor: olderCursor,
          }
        )
      )
      .mockResolvedValueOnce(page(olderCursor));

    const result = await ingestRemoteSnapshot({
      client: { getSessionEventWirePage },
      orgId: "org-1",
      remoteSession: makeRemote(),
      localSessionId: "imported-session-local",
    });

    expect(result).toEqual(commit());
    expect(getSessionEventWirePage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        cursor: { direction: "backward" },
        includeTail: true,
        maxSegments: SESSION_EVENT_WIRE_MAX_PAGE_SEGMENTS,
        maxWireBytes: SESSION_EVENT_WIRE_MAX_PAGE_BYTES,
      })
    );
    expect(getSessionEventWirePage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ cursor: olderCursor, includeTail: false })
    );
    expect(ingestRpc.begin).toHaveBeenCalledWith(
      expect.objectContaining({ replace: true })
    );
    expect(ingestRpc.apply).toHaveBeenCalledTimes(2);
    expect(ingestRpc.abort).not.toHaveBeenCalled();
  });

  it("pins a forward delta to the advertised frozen high-water mark", async () => {
    const getSessionEventWirePage = vi.fn(async ({ cursor }) => page(cursor));
    const previous = {
      epoch: 3,
      frozenSeq: 1,
      count: 2,
      frozenCount: 1,
      tailHash: "b".repeat(64),
    };
    ingestRpc.getCursor.mockResolvedValue(previous);

    await ingestRemoteSnapshot({
      client: { getSessionEventWirePage },
      orgId: "org-1",
      remoteSession: makeRemote(),
      localSessionId: "imported-session-local",
      previous,
    });

    const cursor = { direction: "forward", afterSeq: 1, throughSeq: 3 };
    expect(getSessionEventWirePage).toHaveBeenCalledWith(
      expect.objectContaining({ cursor, includeTail: true })
    );
    expect(ingestRpc.begin).toHaveBeenCalledWith(
      expect.objectContaining({ replace: false, previous })
    );
    expect(ingestRpc.apply).toHaveBeenCalledWith(
      expect.objectContaining({ cursor })
    );
  });

  it("resets with a bounded rebuild when the remote epoch changed", async () => {
    const getSessionEventWirePage = vi
      .fn()
      .mockResolvedValueOnce(
        page({ direction: "forward", afterSeq: 1 }, { epoch: 4 })
      )
      .mockResolvedValueOnce(page({ direction: "backward" }, { epoch: 4 }));

    const previous = {
      epoch: 3,
      frozenSeq: 1,
      count: 2,
      frozenCount: 1,
      tailHash: null,
    };
    ingestRpc.getCursor.mockResolvedValue(previous);
    await ingestRemoteSnapshot({
      client: { getSessionEventWirePage },
      orgId: "org-1",
      remoteSession: makeRemote({ eventsEpoch: 4 }),
      localSessionId: "imported-session-local",
      previous,
    });

    expect(getSessionEventWirePage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ cursor: { direction: "backward" } })
    );
    expect(ingestRpc.begin).toHaveBeenCalledWith(
      expect.objectContaining({ epoch: 4, replace: true })
    );
  });

  it("aborts a failed stage before retrying a bounded replacement", async () => {
    ingestRpc.apply.mockRejectedValueOnce(new Error("local cursor mismatch"));
    const getSessionEventWirePage = vi
      .fn()
      .mockResolvedValueOnce(page({ direction: "forward", afterSeq: 1 }))
      .mockResolvedValueOnce(page({ direction: "backward" }));

    const previous = {
      epoch: 3,
      frozenSeq: 1,
      count: 2,
      frozenCount: 1,
      tailHash: null,
    };
    ingestRpc.getCursor.mockResolvedValue(previous);
    await ingestRemoteSnapshot({
      client: { getSessionEventWirePage },
      orgId: "org-1",
      remoteSession: makeRemote(),
      localSessionId: "imported-session-local",
      previous,
    });

    expect(ingestRpc.abort).toHaveBeenCalledWith(TOKEN);
    expect(ingestRpc.begin).toHaveBeenLastCalledWith(
      expect.objectContaining({ replace: true })
    );
    expect(logger.warn).toHaveBeenCalledWith(
      "bounded Cloud replay delta failed; rebuilding the authoritative snapshot",
      expect.objectContaining({
        localSessionId: "imported-session-local",
        remoteSessionRowId: "org-1:m2:remote-1",
        previousEpoch: 3,
        remoteEpoch: 3,
        error: "local cursor mismatch",
      })
    );
  });

  it("propagates cancellation and never starts a fallback generation", async () => {
    const controller = new AbortController();
    const getSessionEventWirePage = vi.fn(async ({ cursor }) => {
      controller.abort();
      return page(cursor);
    });

    await expect(
      ingestRemoteSnapshot({
        client: { getSessionEventWirePage },
        orgId: "org-1",
        remoteSession: makeRemote(),
        localSessionId: "imported-session-local",
        signal: controller.signal,
      })
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof DOMException && error.name === "AbortError"
    );
    expect(ingestRpc.begin).toHaveBeenCalledTimes(1);
    expect(ingestRpc.apply).not.toHaveBeenCalled();
    expect(ingestRpc.abort).toHaveBeenCalledWith(TOKEN);
  });

  it("returns an intact unchanged cursor with zero Cloud wire reads", async () => {
    const previous = {
      epoch: 3,
      frozenSeq: 3,
      count: 4,
      frozenCount: 3,
      tailHash: HASH,
    };
    ingestRpc.getCursor.mockResolvedValue(previous);
    const getSessionEventWirePage = vi.fn();

    const result = await ingestRemoteSnapshot({
      client: { getSessionEventWirePage },
      orgId: "org-1",
      remoteSession: makeRemote(),
      localSessionId: "imported-session-local",
      previous,
    });

    expect(result).toEqual(commit());
    expect(getSessionEventWirePage).not.toHaveBeenCalled();
    expect(ingestRpc.begin).not.toHaveBeenCalled();
    expect(ingestRpc.apply).not.toHaveBeenCalled();
  });

  it("rebuilds from bounded backward pages when the local cursor is hollow", async () => {
    ingestRpc.getCursor.mockResolvedValue(null);
    const getSessionEventWirePage = vi.fn(async ({ cursor }) => page(cursor));

    await ingestRemoteSnapshot({
      client: { getSessionEventWirePage },
      orgId: "org-1",
      remoteSession: makeRemote(),
      localSessionId: "imported-session-local",
      previous: {
        epoch: 3,
        frozenSeq: 3,
        count: 4,
        frozenCount: 3,
        tailHash: HASH,
      },
    });

    expect(getSessionEventWirePage).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: { direction: "backward" } })
    );
    expect(ingestRpc.begin).toHaveBeenCalledWith(
      expect.objectContaining({ replace: true })
    );
  });

  it("fails atomically if a later page changes snapshot identity", async () => {
    const olderCursor = { direction: "backward", beforeSeq: 2 } as const;
    const getSessionEventWirePage = vi
      .fn()
      .mockResolvedValueOnce(
        page(
          { direction: "backward" },
          {
            hasMore: true,
            nextCursor: olderCursor,
          }
        )
      )
      .mockResolvedValueOnce(page(olderCursor, { count: 5 }));

    await expect(
      ingestRemoteSnapshot({
        client: { getSessionEventWirePage },
        orgId: "org-1",
        remoteSession: makeRemote(),
        localSessionId: "imported-session-local",
      })
    ).rejects.toThrow("snapshot changed while paging");
    expect(ingestRpc.commit).not.toHaveBeenCalled();
    expect(ingestRpc.abort).toHaveBeenCalledWith(TOKEN);
  });
});
