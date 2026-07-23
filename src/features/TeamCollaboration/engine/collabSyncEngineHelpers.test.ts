import { beforeEach, describe, expect, it, vi } from "vitest";

import { indexOrgtrackCollaborationSession } from "@src/api/tauri/lineage";
import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { COLLAB_IDENTITY_KIND } from "@src/store/collaboration/types";
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";
import { sessionsAtom } from "@src/store/session/sessionAtom/atoms";
import {
  __GUEST_IMPORT_REGISTRY_INTERNALS,
  mergeGuestImportedSessions,
  removeGuestImportedSession,
} from "@src/store/session/sessionAtom/guestImportRegistry";
import type { Session } from "@src/store/session/sessionAtom/types";
import { createInstrumentedStore } from "@src/util/core/state/instrumentedStore";

import {
  FORK_SNAPSHOT_ERROR_KIND,
  ForkSnapshotIntegrityError,
} from "../forkSnapshotIntegrity";
import {
  deriveImportedSessionId,
  forkSession,
  importRemoteSession,
  isCollabConflictError,
  splitFrozenIntoSegments,
} from "./collabSyncEngineHelpers";

const ingestRemoteSnapshotMock = vi.hoisted(() => vi.fn());

vi.mock("./collabSnapshotIngest", () => ({
  ingestRemoteSnapshot: ingestRemoteSnapshotMock,
}));

vi.mock("@src/engines/SessionCore/core/store/EventStoreProxy", () => ({
  eventStoreProxy: {
    subscribe: vi.fn(),
    getEvents: vi.fn(),
    getPersistedEvents: vi.fn(),
    set: vi.fn(),
    saveToCache: vi.fn(),
    clear: vi.fn(),
    clearPersistedHistory: vi.fn(),
  },
}));

vi.mock("@src/api/tauri/lineage", () => ({
  indexOrgtrackCollaborationSession: vi.fn(),
}));

const eventStoreMock = vi.mocked(eventStoreProxy);
const indexCollaborationSessionMock = vi.mocked(
  indexOrgtrackCollaborationSession
);

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
    repoPath: "/owner/remote/repo",
    lastActivityAt: "2026-07-01T00:00:00.000Z",
    eventsEpoch: 3,
    eventsFrozenSeq: 2,
    eventsCount: 5,
    eventsTailHash: "a".repeat(64),
    ...overrides,
  };
}

function makeCommit(
  localSessionId: string,
  overrides: Record<string, unknown> = {}
) {
  return {
    localSessionId,
    epoch: 3,
    frozenSeq: 2,
    eventCount: 5,
    frozenEventCount: 4,
    tailHash: "a".repeat(64),
    handoffItems: ["User: investigate memory", "Assistant: bounded replay"],
    handoffScannedBytes: 128,
    handoffScannedEvents: 5,
    ...overrides,
  };
}

function makeWireClient() {
  return { getSessionEventWirePage: vi.fn() };
}

describe("isCollabConflictError (both backends' OCC rejection)", () => {
  it("matches both backend conflict markers", () => {
    expect(isCollabConflictError(new Error("ORGII_CONFLICT"))).toBe(true);
    expect(
      isCollabConflictError(new Error("P0001: ORGII_CONFLICT at line 3"))
    ).toBe(true);
    expect(isCollabConflictError(new Error("ORG2_CONFLICT"))).toBe(true);
  });

  it("rejects unrelated errors and non-Error values", () => {
    expect(isCollabConflictError(new Error("ORG2_FORBIDDEN"))).toBe(false);
    expect(isCollabConflictError("ORG2_CONFLICT")).toBe(false);
    expect(isCollabConflictError(undefined)).toBe(false);
  });
});

describe("splitFrozenIntoSegments 256KB packing", () => {
  const SEGMENT_MAX_BYTES = 256 * 1024;

  function makeEvent(id: string, payload = ""): SessionEvent {
    return {
      id,
      sessionId: "session-1",
      displayStatus: "completed",
      payload,
    } as unknown as SessionEvent;
  }

  it("packs a large stream into ordered bounded segments that round-trip", () => {
    const bigPayload = "x".repeat(50 * 1024);
    const events = Array.from({ length: 12 }, (_unused, index) =>
      makeEvent(`e${index}`, bigPayload)
    );
    const segments = splitFrozenIntoSegments(events, 1);

    expect(segments.length).toBeGreaterThan(1);
    for (const segment of segments) {
      const segmentBytes = segment.events.reduce(
        (sum, event) => sum + JSON.stringify(event).length,
        0
      );
      expect(segmentBytes).toBeLessThanOrEqual(SEGMENT_MAX_BYTES);
    }
    expect(segments.map((segment) => segment.seq)).toEqual(
      segments.map((_unused, index) => index + 1)
    );
    expect(segments.flatMap((segment) => segment.events)).toEqual(events);
  });

  it("keeps one oversized event instead of dropping it", () => {
    const oversized = makeEvent("huge", "y".repeat(SEGMENT_MAX_BYTES + 1_000));
    const segments = splitFrozenIntoSegments([oversized], 5);
    expect(segments).toHaveLength(1);
    expect(segments[0].seq).toBe(5);
    expect(segments[0].events[0].id).toBe("huge");
  });

  it("budgets by UTF-8 bytes rather than UTF-16 code units", () => {
    const cjkPayload = "汉".repeat(60 * 1024);
    const events = Array.from({ length: 6 }, (_unused, index) =>
      makeEvent(`cjk${index}`, cjkPayload)
    );
    const encoder = new TextEncoder();
    const segments = splitFrozenIntoSegments(events, 1);

    expect(segments.length).toBeGreaterThanOrEqual(6);
    for (const segment of segments) {
      if (segment.events.length <= 1) continue;
      const segmentBytes = segment.events.reduce(
        (sum, event) => sum + encoder.encode(JSON.stringify(event)).byteLength,
        0
      );
      expect(segmentBytes).toBeLessThanOrEqual(SEGMENT_MAX_BYTES);
    }
  });
});

describe("deriveImportedSessionId", () => {
  it("is deterministic per endpoint/org/source and isolates deployments", async () => {
    const first = await deriveImportedSessionId(
      "org-1",
      "remote-1",
      "https://cloud-a.example.com/"
    );
    const same = await deriveImportedSessionId(
      "org-1",
      "remote-1",
      "https://cloud-a.example.com"
    );
    const otherEndpoint = await deriveImportedSessionId(
      "org-1",
      "remote-1",
      "https://cloud-b.example.com"
    );
    expect(first).toBe(same);
    expect(first).toMatch(/^imported-session-[0-9a-f]{32}$/);
    expect(otherEndpoint).not.toBe(first);
  });
});

describe("importRemoteSession bounded snapshot publication", () => {
  const store = createInstrumentedStore();

  beforeEach(() => {
    vi.clearAllMocks();
    store.set(sessionsAtom, []);
    localStorage.removeItem(
      __GUEST_IMPORT_REGISTRY_INTERNALS.GUEST_IMPORT_REGISTRY_STORAGE_KEY
    );
    eventStoreMock.clearPersistedHistory.mockResolvedValue(undefined);
    indexCollaborationSessionMock.mockResolvedValue(0);
    ingestRemoteSnapshotMock.mockImplementation(
      async ({ localSessionId }: { localSessionId: string }) =>
        makeCommit(localSessionId)
    );
  });

  it("publishes a deterministic read-only row after Rust commits the snapshot", async () => {
    const client = makeWireClient();
    const onBeforeWrite = vi.fn();
    const result = await importRemoteSession({
      client,
      orgId: "org-1",
      remoteSession: makeRemote({
        cliAgentType: "codex",
        agentDisplayName: "Codex App",
        agentDefinitionId: "codex-app",
        model: "gpt-5.6-sol",
        origin: { kind: "external_history", source: "codex_app" },
      }),
      sourceEndpointUrl: "https://cloud.example.com/",
      onBeforeWrite,
    });

    expect(result?.updated).toBe(true);
    expect(result?.localSessionId).toMatch(/^imported-session-/);
    expect(onBeforeWrite).toHaveBeenCalledWith(result?.localSessionId);
    expect(ingestRemoteSnapshotMock).toHaveBeenCalledWith(
      expect.objectContaining({
        client,
        localSessionId: result?.localSessionId,
      })
    );
    const row = (store.get(sessionsAtom) as Session[])[0];
    expect(row.category).toBe("external_history");
    expect(row.orgId).toBe("org-1");
    expect(row.importedFrom).toMatchObject({
      sourceSessionId: "remote-1",
      sourceEndpointUrl: "https://cloud.example.com",
      externalHistorySource: "codex_app",
      sourceDisplay: {
        cliAgentType: "codex",
        agentDisplayName: "Codex App",
        agentDefinitionId: "codex-app",
        model: "gpt-5.6-sol",
      },
      epoch: 3,
      seq: 2,
      count: 5,
      frozenCount: 4,
    });
    expect(row.model).toBeUndefined();
    expect(eventStoreMock.getPersistedEvents).not.toHaveBeenCalled();
  });

  it("passes the compact cursor for a delta and reports an unchanged commit", async () => {
    const client = makeWireClient();
    const localSessionId = await deriveImportedSessionId(
      "org-1",
      "remote-1",
      "https://cloud.example.com"
    );
    store.set(sessionsAtom, [
      {
        session_id: localSessionId,
        created_at: "2026-07-01T00:00:00.000Z",
        importedFrom: {
          orgId: "org-1",
          sourceSessionId: "remote-1",
          sourceEndpointUrl: "https://cloud.example.com",
          ownerMemberId: "m2",
          ownerDisplayName: "Bob",
          epoch: 3,
          seq: 2,
          count: 5,
          frozenCount: 4,
          tailHash: "a".repeat(64),
          importedAt: "2026-07-01T00:00:00.000Z",
        },
      } as Session,
    ]);

    const result = await importRemoteSession({
      client,
      orgId: "org-1",
      remoteSession: makeRemote(),
      sourceEndpointUrl: "https://cloud.example.com",
    });

    expect(result).toEqual({ localSessionId, updated: false });
    expect(ingestRemoteSnapshotMock).toHaveBeenCalledWith(
      expect.objectContaining({
        previous: {
          epoch: 3,
          frozenSeq: 2,
          count: 5,
          frozenCount: 4,
          tailHash: "a".repeat(64),
        },
      })
    );
    expect(eventStoreMock.getPersistedEvents).not.toHaveBeenCalled();
  });

  it("keeps guest imports personal and restores their capability registry", async () => {
    const result = await importRemoteSession({
      client: makeWireClient(),
      orgId: "org-1",
      remoteSession: makeRemote(),
      shareToken: "share-token",
      shareEndpointUrl: "https://cloud.example.com",
    });

    const row = (store.get(sessionsAtom) as Session[])[0];
    expect(row.orgId).toBeUndefined();
    expect(row.importedFrom?.shareToken).toBe("share-token");
    const restored = mergeGuestImportedSessions([]).find(
      (session) => session.session_id === result?.localSessionId
    );
    expect(restored?.importedFrom?.shareEndpointUrl).toBe(
      "https://cloud.example.com"
    );
    removeGuestImportedSession(result!.localSessionId);
    expect(mergeGuestImportedSessions([])).toEqual([]);
  });

  it("indexes the committed replay against the viewer-local checkout", async () => {
    const remoteSession = makeRemote();
    const result = await importRemoteSession({
      client: makeWireClient(),
      orgId: "org-1",
      remoteSession,
      workspaceRepoPath: "/viewer/ORG2",
    });

    expect(indexCollaborationSessionMock).toHaveBeenCalledWith({
      localSessionId: result?.localSessionId,
      sourceSessionId: "remote-1",
      title: "Remote session",
      workspacePath: "/viewer/ORG2",
      sourceWorkspacePath: "/owner/remote/repo",
      orgId: "org-1",
      sessionRowId: remoteSession.id,
      ownerMemberId: "m2",
      ownerDisplayName: "Bob",
    });
  });

  it("does not create a row when no replay snapshot was published", async () => {
    const result = await importRemoteSession({
      client: makeWireClient(),
      orgId: "org-1",
      remoteSession: makeRemote({
        eventsEpoch: undefined,
        eventsFrozenSeq: undefined,
        eventsCount: undefined,
      }),
    });

    expect(result).toBeNull();
    expect(ingestRemoteSnapshotMock).not.toHaveBeenCalled();
    expect(store.get(sessionsAtom)).toEqual([]);
  });

  it("serializes concurrent imports without sharing caller cancellation", async () => {
    let releaseFirst!: () => void;
    ingestRemoteSnapshotMock
      .mockImplementationOnce(
        ({ localSessionId }: { localSessionId: string }) =>
          new Promise((resolve) => {
            releaseFirst = () => resolve(makeCommit(localSessionId));
          })
      )
      .mockImplementation(
        async ({ localSessionId }: { localSessionId: string }) =>
          makeCommit(localSessionId)
      );
    const options = {
      client: makeWireClient(),
      orgId: "org-1",
      remoteSession: makeRemote(),
    };

    const first = importRemoteSession(options);
    const second = importRemoteSession(options);
    await vi.waitFor(() =>
      expect(ingestRemoteSnapshotMock).toHaveBeenCalledTimes(1)
    );
    releaseFirst();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult?.localSessionId).toBe(secondResult?.localSessionId);
    expect(ingestRemoteSnapshotMock).toHaveBeenCalledTimes(2);
  });

  it("leaves the session list untouched when staged ingest fails", async () => {
    ingestRemoteSnapshotMock.mockRejectedValueOnce(new Error("wire rejected"));
    await expect(
      importRemoteSession({
        client: makeWireClient(),
        orgId: "org-1",
        remoteSession: makeRemote(),
      })
    ).rejects.toThrow("wire rejected");
    expect(store.get(sessionsAtom)).toEqual([]);
  });
});

describe("forkSession bounded snapshot publication", () => {
  const store = createInstrumentedStore();

  beforeEach(() => {
    vi.clearAllMocks();
    store.set(sessionsAtom, []);
    eventStoreMock.clearPersistedHistory.mockResolvedValue(undefined);
    ingestRemoteSnapshotMock.mockImplementation(
      async ({ localSessionId }: { localSessionId: string }) =>
        makeCommit(localSessionId)
    );
  });

  it("creates a runnable native session and returns the bounded handoff", async () => {
    const client = makeWireClient();
    const result = await forkSession({
      client,
      orgId: "org-1",
      remoteSession: makeRemote(),
    });

    expect(result?.localSessionId).toMatch(/^agentsession-/);
    expect(result?.handoffItems).toEqual([
      "User: investigate memory",
      "Assistant: bounded replay",
    ]);
    expect(ingestRemoteSnapshotMock).toHaveBeenCalledWith(
      expect.objectContaining({
        client,
        localSessionId: result?.localSessionId,
      })
    );
    const row = (store.get(sessionsAtom) as Session[])[0];
    expect(row.category).toBe("rust_agent");
    expect(row.importedFrom).toBeUndefined();
    expect(row.forkedFrom).toMatchObject({
      sourceSessionId: "remote-1",
      rootSessionId: "remote-1",
      atCount: 5,
    });
    expect(eventStoreMock.getPersistedEvents).not.toHaveBeenCalled();
  });

  it("fails closed and clears an atomically committed summary mismatch", async () => {
    ingestRemoteSnapshotMock.mockImplementationOnce(
      async ({ localSessionId }: { localSessionId: string }) =>
        makeCommit(localSessionId, { eventCount: 4 })
    );

    await expect(
      forkSession({
        client: makeWireClient(),
        orgId: "org-1",
        remoteSession: makeRemote(),
      })
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ForkSnapshotIntegrityError &&
        error.kind === FORK_SNAPSHOT_ERROR_KIND.SNAPSHOT_INCOMPLETE
    );
    expect(eventStoreMock.clearPersistedHistory).toHaveBeenCalledWith(
      expect.stringMatching(/^agentsession-/)
    );
    expect(store.get(sessionsAtom)).toEqual([]);
  });

  it("uses a viewer-local workspace and preserves the original relay root", async () => {
    const result = await forkSession({
      client: makeWireClient(),
      orgId: "org-1",
      remoteSession: makeRemote({
        forkedFrom: {
          sourceSessionId: "parent",
          rootSessionId: "root-0",
          ownerDisplayName: "Alice",
        },
      }),
      workspaceRepoPath: "/viewer/ORG2",
    });

    const row = (store.get(sessionsAtom) as Session[]).find(
      (session) => session.session_id === result?.localSessionId
    );
    expect(row?.repoPath).toBe("/viewer/ORG2");
    expect(row?.forkedFrom?.rootSessionId).toBe("root-0");
  });

  it("drops an owner's unusable absolute path when no local checkout exists", async () => {
    const result = await forkSession({
      client: makeWireClient(),
      orgId: "org-1",
      remoteSession: makeRemote(),
      workspaceRepoPath: null,
    });
    const row = (store.get(sessionsAtom) as Session[]).find(
      (session) => session.session_id === result?.localSessionId
    );
    expect(row?.repoPath).toBeUndefined();
    expect(result?.repoPath).toBeUndefined();
  });

  it("rejects metadata-only sessions before opening the wire reader", async () => {
    await expect(
      forkSession({
        client: makeWireClient(),
        orgId: "org-1",
        remoteSession: makeRemote({
          eventsEpoch: undefined,
          eventsFrozenSeq: undefined,
          eventsCount: undefined,
        }),
      })
    ).rejects.toMatchObject({
      kind: "replay_unavailable",
      sourceSessionId: "remote-1",
    });
    expect(ingestRemoteSnapshotMock).not.toHaveBeenCalled();
  });
});
