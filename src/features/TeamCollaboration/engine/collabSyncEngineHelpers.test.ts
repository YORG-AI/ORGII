import { beforeEach, describe, expect, it, vi } from "vitest";

import { indexOrgtrackCollaborationSession } from "@src/api/tauri/lineage";
import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { COLLAB_IDENTITY_KIND } from "@src/store/collaboration/types";
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";
import { sessionsAtom } from "@src/store/session/sessionAtom/atoms";
import type { Session } from "@src/store/session/sessionAtom/types";
import { createInstrumentedStore } from "@src/util/core/state/instrumentedStore";

import type {
  CollabSyncBackendClient,
  SessionEventSegmentsSnapshot,
} from "../sync/CollabSyncBackend";
import {
  deriveImportedSessionId,
  forkSession,
  importRemoteSession,
  isCollabConflictError,
  splitFrozenIntoSegments,
} from "./collabSyncEngineHelpers";

vi.mock("@src/engines/SessionCore/core/store/EventStoreProxy", () => ({
  eventStoreProxy: {
    subscribe: vi.fn(),
    getEvents: vi.fn(),
    getPersistedEvents: vi.fn(),
    set: vi.fn(),
    saveToCache: vi.fn(),
    clear: vi.fn(),
  },
}));

vi.mock("@src/api/tauri/lineage", () => ({
  indexOrgtrackCollaborationSession: vi.fn(),
}));

const eventStoreMock = vi.mocked(eventStoreProxy);
const indexCollaborationSessionMock = vi.mocked(
  indexOrgtrackCollaborationSession
);

describe("isCollabConflictError (both backends' OCC rejection)", () => {
  it("matches the self-hosted ORGII_CONFLICT", () => {
    expect(isCollabConflictError(new Error("ORGII_CONFLICT"))).toBe(true);
    // PostgREST wraps the raise message; substring match is deliberate.
    expect(
      isCollabConflictError(new Error("P0001: ORGII_CONFLICT at line 3"))
    ).toBe(true);
  });

  it("matches the managed-cloud ORG2_CONFLICT (cloud-parity Phase B)", () => {
    expect(isCollabConflictError(new Error("ORG2_CONFLICT"))).toBe(true);
  });

  it("rejects other errors and non-Error values", () => {
    expect(isCollabConflictError(new Error("ORG2_FORBIDDEN"))).toBe(false);
    expect(isCollabConflictError(new Error("ORGII_UNAUTHORIZED"))).toBe(false);
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

  it("packs a >256KB event stream into multiple ≤256KB segments that round-trip", () => {
    // ~50KB per event so a handful crosses the 256KB cap and forces >1 segment.
    const bigPayload = "x".repeat(50 * 1024);
    const events = Array.from({ length: 12 }, (_unused, index) =>
      makeEvent(`e${index}`, bigPayload)
    );
    const totalBytes = events.reduce(
      (sum, event) => sum + JSON.stringify(event).length,
      0
    );
    expect(totalBytes).toBeGreaterThan(SEGMENT_MAX_BYTES);

    const segments = splitFrozenIntoSegments(events, 1);

    // More than one frozen segment was produced.
    expect(segments.length).toBeGreaterThan(1);
    // Each segment is within the byte cap (an event's own size can be counted,
    // but no segment packs beyond the cap once it holds >1 event).
    for (const segment of segments) {
      const segmentBytes = segment.events.reduce(
        (sum, event) => sum + JSON.stringify(event).length,
        0
      );
      expect(segmentBytes).toBeLessThanOrEqual(SEGMENT_MAX_BYTES);
    }
    // Seqs are contiguous from the requested start.
    expect(segments.map((segment) => segment.seq)).toEqual(
      segments.map((_unused, index) => 1 + index)
    );
    // Concatenating the segments' events round-trips the full input in order.
    const flattened = segments.flatMap((segment) => segment.events);
    expect(flattened.map((event) => event.id)).toEqual(
      events.map((event) => event.id)
    );
    expect(flattened).toEqual(events);
  });

  it("ships an oversized single event as its own segment (never drops it)", () => {
    // A single event larger than the cap must still ship — at least one event
    // per segment (design §7.3 step 3a).
    const oversized = makeEvent("huge", "y".repeat(SEGMENT_MAX_BYTES + 1_000));
    const segments = splitFrozenIntoSegments([oversized], 5);
    expect(segments).toHaveLength(1);
    expect(segments[0].seq).toBe(5);
    expect(segments[0].events).toHaveLength(1);
    expect(segments[0].events[0].id).toBe("huge");
  });
});

describe("deriveImportedSessionId", () => {
  it("is deterministic per (orgId, sourceSessionId) and keeps the imported-session prefix", async () => {
    const first = await deriveImportedSessionId("org-1", "remote-1");
    const second = await deriveImportedSessionId("org-1", "remote-1");
    const otherSession = await deriveImportedSessionId("org-1", "remote-2");
    const otherOrg = await deriveImportedSessionId("org-2", "remote-1");
    expect(first).toBe(second);
    expect(first).toMatch(/^imported-session-[0-9a-f]{32}$/);
    expect(otherSession).not.toBe(first);
    expect(otherOrg).not.toBe(first);
  });
});

describe("importRemoteSession", () => {
  const store = createInstrumentedStore();

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
      repoPath: "/repo/shared",
      lastActivityAt: "2026-07-01T00:00:00.000Z",
      eventsEpoch: 1,
      eventsFrozenSeq: 1,
      eventsCount: 1,
      eventsTailHash: undefined,
      ...overrides,
    };
  }

  function makeSnapshot(): SessionEventSegmentsSnapshot {
    return {
      epoch: 1,
      frozenSeq: 1,
      tailHash: null,
      count: 1,
      segments: [
        {
          seq: 1,
          isTail: false,
          events: [
            {
              id: "e1",
              sessionId: "remote-1",
              displayStatus: "completed",
            } as unknown as SessionEvent,
          ],
          eventCount: 1,
          segmentHash: "h1",
        },
      ],
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    store.set(sessionsAtom, []);
    eventStoreMock.set.mockResolvedValue(undefined);
    eventStoreMock.clear.mockResolvedValue(undefined);
    eventStoreMock.getPersistedEvents.mockResolvedValue([]);
    eventStoreMock.saveToCache.mockResolvedValue(1);
    indexCollaborationSessionMock.mockResolvedValue(0);
  });

  it("indexes an authorized replay against the viewer's checkout", async () => {
    const client = {
      getSessionEventSegments: vi.fn(async () => makeSnapshot()),
    } satisfies Pick<CollabSyncBackendClient, "getSessionEventSegments">;
    const remote = makeRemote();

    const result = await importRemoteSession({
      client,
      orgId: "org-1",
      remoteSession: remote,
      workspaceRepoPath: "/viewer/ORG2",
    });

    expect(indexCollaborationSessionMock).toHaveBeenCalledWith({
      localSessionId: result?.localSessionId,
      sourceSessionId: remote.sourceSessionId,
      title: remote.title,
      workspacePath: "/viewer/ORG2",
      sourceWorkspacePath: remote.repoPath,
      orgId: "org-1",
      sessionRowId: remote.id,
      ownerMemberId: remote.ownerMemberId,
      ownerDisplayName: remote.ownerDisplayName,
    });
  });

  it("rejects on a failed durable write, clears the orphan, and reuses the deterministic id on retry", async () => {
    const client = {
      getSessionEventSegments: vi.fn(async () => makeSnapshot()),
    } satisfies Pick<CollabSyncBackendClient, "getSessionEventSegments">;
    // The durable cache write fails (transient SQLite lock → swallowed → 0).
    eventStoreMock.saveToCache.mockResolvedValueOnce(0);

    await expect(
      importRemoteSession({
        client,
        orgId: "org-1",
        remoteSession: makeRemote(),
      })
    ).rejects.toThrow(/durably persist/);

    const expectedId = await deriveImportedSessionId("org-1", "remote-1");
    // The events landed on the deterministic id and the orphaned store
    // entry was removed again (no session record points at it).
    expect(eventStoreMock.set).toHaveBeenCalledTimes(1);
    expect(eventStoreMock.set.mock.calls[0][1]).toBe(expectedId);
    expect(eventStoreMock.clear).toHaveBeenCalledWith(expectedId);
    expect(store.get(sessionsAtom)).toHaveLength(0);

    // The retry lands on the SAME id — one orphan slot, not one per cycle.
    const result = await importRemoteSession({
      client,
      orgId: "org-1",
      remoteSession: makeRemote(),
    });
    expect(result?.localSessionId).toBe(expectedId);
    expect(result?.updated).toBe(true);
    expect(eventStoreMock.set).toHaveBeenCalledTimes(2);
    expect(eventStoreMock.set.mock.calls[1][1]).toBe(expectedId);
  });

  it("re-fetches a hollow cache: matching cursor but empty local event store", async () => {
    const client = {
      getSessionEventSegments: vi.fn(async () => makeSnapshot()),
    } satisfies Pick<CollabSyncBackendClient, "getSessionEventSegments">;
    const expectedId = await deriveImportedSessionId("org-1", "remote-1");
    store.set(sessionsAtom, [
      {
        session_id: expectedId,
        name: "Remote session",
        importedFrom: {
          orgId: "org-1",
          sourceSessionId: "remote-1",
          ownerMemberId: "m2",
          ownerDisplayName: "Bob",
          epoch: 1,
          seq: 1,
          count: 1,
          frozenCount: 1,
          tailHash: undefined,
          importedAt: "2026-07-01T00:00:00.000Z",
        },
      } as unknown as Session,
    ]);
    // Event data lost (restart/cleanup churn) while the cursor still matches.
    eventStoreMock.getPersistedEvents.mockResolvedValue([]);

    const result = await importRemoteSession({
      client,
      orgId: "org-1",
      remoteSession: makeRemote(),
    });

    // Not the cursor no-op: the hollow cache must trigger a full refetch.
    expect(result?.updated).toBe(true);
    expect(result?.localSessionId).toBe(expectedId);
    expect(client.getSessionEventSegments).toHaveBeenCalled();
    expect(eventStoreMock.set).toHaveBeenCalledTimes(1);
  });

  it("keeps the cursor no-op when the local event store still holds the events", async () => {
    const client = {
      getSessionEventSegments: vi.fn(async () => makeSnapshot()),
    } satisfies Pick<CollabSyncBackendClient, "getSessionEventSegments">;
    const expectedId = await deriveImportedSessionId("org-1", "remote-1");
    store.set(sessionsAtom, [
      {
        session_id: expectedId,
        name: "Remote session",
        importedFrom: {
          orgId: "org-1",
          sourceSessionId: "remote-1",
          ownerMemberId: "m2",
          ownerDisplayName: "Bob",
          epoch: 1,
          seq: 1,
          count: 1,
          frozenCount: 1,
          tailHash: undefined,
          importedAt: "2026-07-01T00:00:00.000Z",
        },
      } as unknown as Session,
    ]);
    eventStoreMock.getPersistedEvents.mockResolvedValue([
      { id: "e1" } as unknown as SessionEvent,
    ]);

    const result = await importRemoteSession({
      client,
      orgId: "org-1",
      remoteSession: makeRemote(),
    });

    expect(result?.updated).toBe(false);
    expect(client.getSessionEventSegments).not.toHaveBeenCalled();
  });

  it("stamps Session.orgId on a MEMBER import so the sidebar org filter matches", async () => {
    const client = {
      getSessionEventSegments: vi.fn(async () => makeSnapshot()),
    } satisfies Pick<CollabSyncBackendClient, "getSessionEventSegments">;

    // Member context: engine PullLoop / panel replay — org profile, no token.
    const result = await importRemoteSession({
      client,
      orgId: "org-1",
      remoteSession: makeRemote(),
    });

    const record = (store.get(sessionsAtom) as Session[]).find(
      (session) => session.session_id === result!.localSessionId
    )!;
    // Ownership stamp (sidebar filter) AND provenance both carry the org.
    expect(record.orgId).toBe("org-1");
    expect(record.importedFrom?.orgId).toBe("org-1");
    expect(record.importedFrom?.shareToken).toBeUndefined();
  });

  it("preserves an external app source on the local replay provenance", async () => {
    const client = {
      getSessionEventSegments: vi.fn(async () => makeSnapshot()),
    } satisfies Pick<CollabSyncBackendClient, "getSessionEventSegments">;

    const result = await importRemoteSession({
      client,
      orgId: "org-1",
      remoteSession: makeRemote({
        origin: { kind: "external_history", source: "codex_app" },
      }),
    });
    const record = (store.get(sessionsAtom) as Session[]).find(
      (session) => session.session_id === result!.localSessionId
    );

    expect(record?.importedFrom?.externalHistorySource).toBe("codex_app");
  });

  it("leaves Session.orgId unset on a GUEST share-token import (stays under Personal)", async () => {
    const client = {
      getSessionEventSegments: vi.fn(async () => makeSnapshot()),
    } satisfies Pick<CollabSyncBackendClient, "getSessionEventSegments">;

    // Guest context: CollabShareImportDialog — the share token authenticates,
    // there is no local membership of org-1.
    const result = await importRemoteSession({
      client,
      orgId: "org-1",
      remoteSession: makeRemote(),
      shareToken: "share-token",
    });

    const record = (store.get(sessionsAtom) as Session[]).find(
      (session) => session.session_id === result!.localSessionId
    )!;
    // No ownership stamp — the import groups under Personal in the sidebar.
    expect(record.orgId).toBeUndefined();
    // Provenance still records the origin org.
    expect(record.importedFrom?.orgId).toBe("org-1");
    expect(record.importedFrom?.shareToken).toBe("share-token");
  });

  it("preserves a guest capability during a later tokenless re-import", async () => {
    const client = {
      getSessionEventSegments: vi.fn(async () => makeSnapshot()),
    } satisfies Pick<CollabSyncBackendClient, "getSessionEventSegments">;
    const localSessionId = await deriveImportedSessionId("org-1", "remote-1");
    store.set(sessionsAtom, [
      {
        session_id: localSessionId,
        name: "Remote session",
        importedFrom: {
          orgId: "org-1",
          sourceSessionId: "remote-1",
          ownerMemberId: "m2",
          epoch: 1,
          seq: 0,
          count: 0,
          shareToken: "share-token",
        },
      } as unknown as Session,
    ]);

    const result = await importRemoteSession({
      client,
      orgId: "org-1",
      remoteSession: makeRemote(),
    });
    const record = (store.get(sessionsAtom) as Session[]).find(
      (session) => session.session_id === result!.localSessionId
    );
    expect(record?.importedFrom?.shareToken).toBe("share-token");
  });

  it("dedups concurrent imports of the same remote session in flight", async () => {
    let resolveFirstFetch!: (snapshot: SessionEventSegmentsSnapshot) => void;
    const client = {
      getSessionEventSegments: vi
        .fn<() => Promise<SessionEventSegmentsSnapshot>>()
        .mockImplementationOnce(
          () =>
            new Promise<SessionEventSegmentsSnapshot>((resolve) => {
              resolveFirstFetch = resolve;
            })
        )
        .mockResolvedValue({
          ...makeSnapshot(),
          frozenSeq: 2,
          count: 2,
          segments: [
            ...makeSnapshot().segments,
            {
              seq: 2,
              isTail: false,
              events: [
                {
                  id: "e2",
                  sessionId: "remote-1",
                  displayStatus: "completed",
                } as unknown as SessionEvent,
              ],
              eventCount: 1,
              segmentHash: "h2",
            },
          ],
        }),
    } satisfies Pick<CollabSyncBackendClient, "getSessionEventSegments">;

    // Engine PullLoop and a panel replay click race on the same session:
    // the second call must share the first call's in-flight promise.
    const first = importRemoteSession({
      client,
      orgId: "org-1",
      remoteSession: makeRemote(),
    });
    const second = importRemoteSession({
      client,
      orgId: "org-1",
      remoteSession: makeRemote(),
    });
    expect(client.getSessionEventSegments).toHaveBeenCalledTimes(1);

    resolveFirstFetch(makeSnapshot());
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult?.localSessionId).toBe(secondResult?.localSessionId);
    expect(eventStoreMock.set).toHaveBeenCalledTimes(1);

    // The in-flight entry is cleared afterwards: a later call with a newer
    // remote summary fetches again instead of returning the stale promise.
    const third = await importRemoteSession({
      client,
      orgId: "org-1",
      remoteSession: makeRemote({ eventsFrozenSeq: 2, eventsCount: 2 }),
    });
    expect(client.getSessionEventSegments).toHaveBeenCalledTimes(2);
    expect(third?.updated).toBe(true);
  });
});

describe("forkSession (design §16.11, fork & continue)", () => {
  const store = createInstrumentedStore();

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
      repoPath: "/repo/shared",
      lastActivityAt: "2026-07-01T00:00:00.000Z",
      eventsEpoch: 1,
      eventsFrozenSeq: 1,
      eventsCount: 2,
      eventsTailHash: undefined,
      ...overrides,
    };
  }

  function makeSnapshot(): SessionEventSegmentsSnapshot {
    return {
      epoch: 1,
      frozenSeq: 1,
      tailHash: null,
      count: 2,
      segments: [
        {
          seq: 1,
          isTail: false,
          events: [
            {
              id: "e1",
              sessionId: "remote-1",
              displayStatus: "completed",
            } as unknown as SessionEvent,
            {
              id: "e2",
              sessionId: "remote-1",
              displayStatus: "completed",
            } as unknown as SessionEvent,
          ],
          eventCount: 2,
          segmentHash: "h1",
        },
      ],
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    store.set(sessionsAtom, []);
    eventStoreMock.set.mockResolvedValue(undefined);
    eventStoreMock.clear.mockResolvedValue(undefined);
    eventStoreMock.getPersistedEvents.mockResolvedValue([]);
    eventStoreMock.saveToCache.mockResolvedValue(1);
  });

  it("creates a WRITABLE session with forkedFrom provenance and persisted events", async () => {
    const client = {
      getSessionEventSegments: vi.fn(async () => makeSnapshot()),
    } satisfies Pick<CollabSyncBackendClient, "getSessionEventSegments">;

    const result = await forkSession({
      client,
      orgId: "org-1",
      remoteSession: makeRemote(),
    });

    expect(result).not.toBeNull();
    // A fresh NORMAL runnable id — not the read-only import namespace.
    expect(result!.localSessionId).toMatch(/^agentsession-/);
    expect(result!.localSessionId).not.toMatch(/^imported-session-/);
    expect(result!.eventCount).toBe(2);

    // Events were rewritten onto the fork id and durably cached.
    expect(eventStoreMock.set).toHaveBeenCalledTimes(1);
    const [writtenEvents, writtenId] = eventStoreMock.set.mock.calls[0];
    expect(writtenId).toBe(result!.localSessionId);
    expect(
      (writtenEvents as SessionEvent[]).map((event) => event.sessionId)
    ).toEqual([result!.localSessionId, result!.localSessionId]);
    expect(eventStoreMock.saveToCache).toHaveBeenCalledWith(
      result!.localSessionId
    );

    const record = (store.get(sessionsAtom) as Session[]).find(
      (session) => session.session_id === result!.localSessionId
    );
    expect(record).toBeDefined();
    // Writable, runnable, NOT a read-only replay copy.
    expect(record!.category).toBe("rust_agent");
    expect(record!.importedFrom).toBeUndefined();
    expect(record!.forkedFrom).toEqual({
      orgId: "org-1",
      sourceSessionId: "remote-1",
      ownerMemberId: "m2",
      ownerDisplayName: "Bob",
      atCount: 2,
      forkedAt: expect.any(String),
      // Source is not itself a fork ⇒ it IS the thread root.
      rootSessionId: "remote-1",
    });
    expect(record!.repoPath).toBe("/repo/shared");
    expect(record!.name).toBe("⑂ Remote session");
    // Ownership stamp (member fork context): the fork files under the source
    // org so the sidebar org filter lists it alongside the org's sessions.
    expect(record!.orgId).toBe("org-1");
  });

  it("uses the resolved LOCAL workspace over the owner's absolute path when provided", async () => {
    const client = {
      getSessionEventSegments: vi.fn(async () => makeSnapshot()),
    } satisfies Pick<CollabSyncBackendClient, "getSessionEventSegments">;

    const result = await forkSession({
      client,
      orgId: "org-1",
      remoteSession: makeRemote(), // owner's repoPath: /repo/shared
      workspaceRepoPath: "/my/checkout/shared",
    });
    const record = (store.get(sessionsAtom) as Session[]).find(
      (session) => session.session_id === result!.localSessionId
    )!;
    expect(record.repoPath).toBe("/my/checkout/shared");
    expect(result!.repoPath).toBe("/my/checkout/shared");
  });

  it("drops the owner's dead path entirely when no local checkout resolved (null override)", async () => {
    const client = {
      getSessionEventSegments: vi.fn(async () => makeSnapshot()),
    } satisfies Pick<CollabSyncBackendClient, "getSessionEventSegments">;

    const result = await forkSession({
      client,
      orgId: "org-1",
      remoteSession: makeRemote(),
      workspaceRepoPath: null,
    });
    const record = (store.get(sessionsAtom) as Session[]).find(
      (session) => session.session_id === result!.localSessionId
    )!;
    // Better NO workspace than the owner's path from another machine.
    expect(record.repoPath).toBeUndefined();
    expect(result!.repoPath).toBeUndefined();
  });

  it("inherits the thread root when forking a fork (relay chain)", async () => {
    const client = {
      getSessionEventSegments: vi.fn(async () => makeSnapshot()),
    } satisfies Pick<CollabSyncBackendClient, "getSessionEventSegments">;

    const result = await forkSession({
      client,
      orgId: "org-1",
      // The source session is ITSELF a fork: its wire lineage points at the
      // original root. The new fork must keep pointing at that root, not at
      // the intermediate parent.
      remoteSession: makeRemote({
        forkedFrom: {
          sourceSessionId: "root-0",
          rootSessionId: "root-0",
          ownerDisplayName: "Alice",
        },
      }),
    });

    expect(result).not.toBeNull();
    const record = (store.get(sessionsAtom) as Session[]).find(
      (session) => session.session_id === result!.localSessionId
    );
    expect(record!.forkedFrom!.sourceSessionId).toBe("remote-1");
    expect(record!.forkedFrom!.rootSessionId).toBe("root-0");
  });

  it("is push-eligible (unlike an import): the continuation syncs back as MY session", async () => {
    const client = {
      getSessionEventSegments: vi.fn(async () => makeSnapshot()),
    } satisfies Pick<CollabSyncBackendClient, "getSessionEventSegments">;

    const result = await forkSession({
      client,
      orgId: "org-1",
      remoteSession: makeRemote(),
    });
    const record = (store.get(sessionsAtom) as Session[]).find(
      (session) => session.session_id === result!.localSessionId
    )!;

    // Push eligibility (§16.11): the engines exclude exactly
    // category==='external_history' and importedFrom-bearing sessions — a
    // fork has neither, so the continuation syncs back under MY identity.
    expect(record.category).not.toBe("external_history");
    expect(record.importedFrom).toBeUndefined();

    // Contrast: the read-only import of the SAME remote session carries both
    // exclusion markers (echo-loop guard P6) — the fork deliberately not.
    const imported = await importRemoteSession({
      client,
      orgId: "org-1",
      remoteSession: makeRemote(),
    });
    const importedRecord = (store.get(sessionsAtom) as Session[]).find(
      (session) => session.session_id === imported!.localSessionId
    )!;
    expect(importedRecord.category).toBe("external_history");
    expect(importedRecord.importedFrom).toBeDefined();
  });

  it("returns null for a metadata-only session without fetching anything", async () => {
    const client = {
      getSessionEventSegments: vi.fn(async () => makeSnapshot()),
    } satisfies Pick<CollabSyncBackendClient, "getSessionEventSegments">;

    const result = await forkSession({
      client,
      orgId: "org-1",
      remoteSession: makeRemote({
        eventsEpoch: undefined,
        eventsFrozenSeq: undefined,
        eventsCount: undefined,
      }),
    });

    expect(result).toBeNull();
    expect(client.getSessionEventSegments).not.toHaveBeenCalled();
    expect(store.get(sessionsAtom)).toHaveLength(0);
  });

  it("throws on a failed durable write and leaves no session record behind", async () => {
    const client = {
      getSessionEventSegments: vi.fn(async () => makeSnapshot()),
    } satisfies Pick<CollabSyncBackendClient, "getSessionEventSegments">;
    // The durable cache write fails (swallowed error → 0 rows saved).
    eventStoreMock.saveToCache.mockResolvedValueOnce(0);

    await expect(
      forkSession({
        client,
        orgId: "org-1",
        remoteSession: makeRemote(),
      })
    ).rejects.toThrow(/durably persist/);

    // The orphaned event-store entry was dropped again and no record claims
    // the fork exists (events-first ordering, mirroring the importer).
    const forkId = eventStoreMock.set.mock.calls[0][1];
    expect(eventStoreMock.clear).toHaveBeenCalledWith(forkId);
    expect(store.get(sessionsAtom)).toHaveLength(0);
  });
});
