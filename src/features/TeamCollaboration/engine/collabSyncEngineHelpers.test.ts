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
  SegmentIntegrityError,
} from "../forkSnapshotIntegrity";
import type {
  CollabSyncBackendClient,
  SessionEventSegmentsSnapshot,
} from "../sync/CollabSyncBackend";
import { computeSegmentHash } from "../sync/collabGzip";
import {
  computeFrozenEventCount,
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
    persistEventsBatch: vi.fn(),
    finalizePersistedImport: vi.fn(),
    loadInitialTurnWindow: vi.fn(),
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

async function sealSnapshot(
  snapshot: SessionEventSegmentsSnapshot
): Promise<SessionEventSegmentsSnapshot> {
  const segments = await Promise.all(
    snapshot.segments.map(async (segment) => ({
      ...segment,
      segmentHash: await computeSegmentHash(segment.events),
    }))
  );
  const tailHash =
    segments.find((segment) => segment.isTail)?.segmentHash ??
    snapshot.tailHash;
  return { ...snapshot, tailHash, segments };
}

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

describe("computeFrozenEventCount frozen line + stuck-sentinel skip-over", () => {
  function event(overrides: Partial<SessionEvent>): SessionEvent {
    return {
      id: `evt-${Math.random().toString(36).slice(2)}`,
      sessionId: "session-1",
      functionName: "",
      uiCanonical: "",
      source: "assistant",
      args: {},
      result: {},
      displayStatus: "completed",
      ...overrides,
    } as SessionEvent;
  }

  function pendingPlanCard(revision: string): SessionEvent {
    return event({
      id: revision,
      functionName: "plan_approval",
      uiCanonical: "plan_approval",
      callId: revision,
      args: { planRevisionId: revision },
      result: { status: "pending", planRevisionId: revision },
      displayStatus: "awaiting_user",
    });
  }

  function resolutionSibling(
    revision: string,
    status: "approved" | "archived" | "cancelled"
  ): SessionEvent {
    return event({
      id: `${revision}-${status}`,
      functionName: "plan_approval",
      uiCanonical: "plan_approval",
      callId: revision,
      args: { planRevisionId: revision },
      result: { status, planRevisionId: revision },
      displayStatus: "completed",
    });
  }

  it("cuts the frozen line at the first still-mutable non-terminal event", () => {
    const events = [
      event({}),
      event({ displayStatus: "running", functionName: "run_shell" }),
      event({}),
    ];
    expect(computeFrozenEventCount(events)).toBe(1);
  });

  it("counts a missing displayStatus as terminal (hash chain catches mutation)", () => {
    const events = [event({ displayStatus: undefined as never }), event({})];
    expect(computeFrozenEventCount(events)).toBe(2);
  });

  it("freezes past an awaiting_user plan card whose revision was resolved", () => {
    const events = [
      event({}),
      pendingPlanCard("rev-1"),
      event({}),
      resolutionSibling("rev-1", "archived"),
      event({}),
    ];
    expect(computeFrozenEventCount(events)).toBe(5);
  });

  it("accepts a resolution marker that precedes the dangling card", () => {
    const events = [
      resolutionSibling("rev-1", "approved"),
      pendingPlanCard("rev-1"),
      event({}),
    ];
    expect(computeFrozenEventCount(events)).toBe(3);
  });

  it("freezes past a plan card superseded by a later pending revision, which itself still blocks", () => {
    const superseded = pendingPlanCard("rev-1");
    const latest = pendingPlanCard("rev-2");
    const events = [superseded, event({}), latest, event({})];
    expect(computeFrozenEventCount(events)).toBe(2);
  });

  it("keeps a genuinely pending latest plan card in the tail", () => {
    const events = [event({}), pendingPlanCard("rev-1"), event({})];
    expect(computeFrozenEventCount(events)).toBe(1);
  });

  it("freezes past a dangling create_plan tool call once its revision resolved", () => {
    const createPlanCall = event({
      id: "tool-call-rev-1",
      functionName: "create_plan",
      uiCanonical: "create_plan",
      callId: "rev-1",
      displayStatus: "awaiting_user",
    });
    const events = [
      createPlanCall,
      pendingPlanCard("rev-1"),
      resolutionSibling("rev-1", "approved"),
      event({}),
    ];
    expect(computeFrozenEventCount(events)).toBe(4);
  });

  it("freezes past a running synchronous tool zombie once a later user event exists", () => {
    const zombie = event({
      displayStatus: "running",
      functionName: "read_file",
      uiCanonical: "read_file",
    });
    const events = [event({}), zombie, event({}), event({ source: "user" })];
    expect(computeFrozenEventCount(events)).toBe(4);
  });

  it("keeps a running synchronous tool in the tail while its turn may still be live", () => {
    const running = event({
      displayStatus: "running",
      functionName: "read_file",
      uiCanonical: "read_file",
    });
    const events = [event({ source: "user" }), event({}), running, event({})];
    expect(computeFrozenEventCount(events)).toBe(2);
  });

  it("never freezes a running backgroundable tool, even after later user events", () => {
    const backgroundable = event({
      displayStatus: "running",
      functionName: "agent",
      uiCanonical: "subagent",
    });
    const events = [backgroundable, event({}), event({ source: "user" })];
    expect(computeFrozenEventCount(events)).toBe(0);
  });

  it("keeps a non-plan awaiting_user interaction in the tail", () => {
    const question = event({
      displayStatus: "awaiting_user",
      functionName: "ask_user_questions",
      uiCanonical: "ask_user_questions",
    });
    const events = [event({}), question, event({}), event({ source: "user" })];
    expect(computeFrozenEventCount(events)).toBe(1);
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

  it("budgets by UTF-8 bytes, not UTF-16 length (CJK regression)", () => {
    // Each CJK char is 1 UTF-16 code unit but 3 UTF-8 bytes. A length-based
    // budget would pack ~3× over the wire cap for CJK-heavy transcripts.
    const cjkPayload = "汉".repeat(60 * 1024); // ~180 KiB UTF-8, 60 K length
    const events = Array.from({ length: 6 }, (_unused, index) =>
      makeEvent(`cjk${index}`, cjkPayload)
    );
    const encoder = new TextEncoder();

    const segments = splitFrozenIntoSegments(events, 1);

    // UTF-16 budgeting would fit 4 events per segment (~240K length) and
    // produce 2 segments; UTF-8 budgeting fits 1 per segment.
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
  it("is deterministic per (endpoint, orgId, sourceSessionId) and keeps the imported-session prefix", async () => {
    const first = await deriveImportedSessionId(
      "org-1",
      "remote-1",
      "https://cloud-a.example.com/"
    );
    const second = await deriveImportedSessionId(
      "org-1",
      "remote-1",
      "https://cloud-a.example.com"
    );
    const otherSession = await deriveImportedSessionId("org-1", "remote-2");
    const otherOrg = await deriveImportedSessionId("org-2", "remote-1");
    const otherEndpoint = await deriveImportedSessionId(
      "org-1",
      "remote-1",
      "https://cloud-b.example.com"
    );
    expect(first).toBe(second);
    expect(first).toMatch(/^imported-session-[0-9a-f]{32}$/);
    expect(otherSession).not.toBe(first);
    expect(otherOrg).not.toBe(first);
    expect(otherEndpoint).not.toBe(first);
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
    localStorage.removeItem(
      __GUEST_IMPORT_REGISTRY_INTERNALS.GUEST_IMPORT_REGISTRY_STORAGE_KEY
    );
    eventStoreMock.set.mockResolvedValue(undefined);
    eventStoreMock.clear.mockResolvedValue(undefined);
    eventStoreMock.clearPersistedHistory.mockResolvedValue(undefined);
    eventStoreMock.getPersistedEvents.mockResolvedValue([]);
    eventStoreMock.persistEventsBatch.mockImplementation(
      async (events: SessionEvent[]) => events.length
    );
    eventStoreMock.finalizePersistedImport.mockResolvedValue(3);
    eventStoreMock.loadInitialTurnWindow.mockResolvedValue(1);
    eventStoreMock.saveToCache.mockResolvedValue(1);
    indexCollaborationSessionMock.mockResolvedValue(0);
  });

  it("indexes an authorized replay against the viewer's checkout", async () => {
    const client = {
      getSessionEventSegments: vi.fn(async () => sealSnapshot(makeSnapshot())),
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

  it("streams a fresh replay into bounded durable batches without assembling the full history", async () => {
    const pageOne = await sealSnapshot({
      epoch: 3,
      frozenSeq: 2,
      tailHash: null,
      count: 3,
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
          segmentHash: "",
        },
      ],
    });
    const pageTwo = await sealSnapshot({
      epoch: 3,
      frozenSeq: 2,
      tailHash: null,
      count: 3,
      segments: [
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
          segmentHash: "",
        },
        {
          seq: 0,
          isTail: true,
          events: [
            {
              id: "e3",
              sessionId: "remote-1",
              displayStatus: "completed",
            } as unknown as SessionEvent,
          ],
          eventCount: 1,
          segmentHash: "",
        },
      ],
    });
    const client = {
      getSessionEventSegments: vi.fn(),
      streamSessionEventSegments: vi.fn(
        async (
          _input: unknown,
          onPage: (page: SessionEventSegmentsSnapshot) => Promise<void>
        ) => {
          await onPage(pageOne);
          await onPage(pageTwo);
          return {
            epoch: 3,
            frozenSeq: 2,
            count: 3,
            tailHash: pageTwo.tailHash,
          };
        }
      ),
    } satisfies Pick<
      CollabSyncBackendClient,
      "getSessionEventSegments" | "streamSessionEventSegments"
    >;

    const result = await importRemoteSession({
      client,
      orgId: "org-1",
      remoteSession: makeRemote({
        eventsEpoch: 3,
        eventsFrozenSeq: 2,
        eventsCount: 3,
        eventsTailHash: pageTwo.tailHash ?? undefined,
      }),
      workspaceRepoPath: "/viewer/ORG2",
    });

    expect(result).toMatchObject({ updated: true, deferIndex: true });
    expect(client.getSessionEventSegments).not.toHaveBeenCalled();
    expect(eventStoreMock.persistEventsBatch).toHaveBeenCalledTimes(2);
    expect(
      eventStoreMock.persistEventsBatch.mock.calls.map(([events]) =>
        events.map((event) => event.id)
      )
    ).toEqual([
      [expect.stringContaining("e1")],
      [expect.stringContaining("e2"), expect.stringContaining("e3")],
    ]);
    expect(eventStoreMock.set).not.toHaveBeenCalled();
    expect(eventStoreMock.saveToCache).not.toHaveBeenCalled();
    expect(eventStoreMock.finalizePersistedImport).toHaveBeenCalledWith(
      result?.localSessionId
    );
    expect(eventStoreMock.loadInitialTurnWindow).toHaveBeenCalledWith(
      result?.localSessionId,
      0
    );
    expect(indexCollaborationSessionMock).not.toHaveBeenCalled();
  });

  it("rejects on a failed durable write, clears the orphan, and reuses the deterministic id on retry", async () => {
    const client = {
      getSessionEventSegments: vi.fn(async () => sealSnapshot(makeSnapshot())),
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
      getSessionEventSegments: vi.fn(async () => sealSnapshot(makeSnapshot())),
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
      getSessionEventSegments: vi.fn(async () => sealSnapshot(makeSnapshot())),
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

  it("refreshes source display metadata without refetching unchanged events", async () => {
    const client = {
      getSessionEventSegments: vi.fn(async () => sealSnapshot(makeSnapshot())),
    } satisfies Pick<CollabSyncBackendClient, "getSessionEventSegments">;
    const expectedId = await deriveImportedSessionId("org-1", "remote-1");
    store.set(sessionsAtom, [
      {
        session_id: expectedId,
        status: "completed",
        created_at: "2026-07-01T00:00:00.000Z",
        updated_at: "2026-07-01T00:00:00.000Z",
        name: "Remote session",
        model: undefined,
        agentIconId: "archive",
        agentDisplayName: "Collaboration Snapshot",
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
      },
    ]);
    eventStoreMock.getPersistedEvents.mockResolvedValue([
      { id: "e1" } as unknown as SessionEvent,
    ]);

    const result = await importRemoteSession({
      client,
      orgId: "org-1",
      remoteSession: makeRemote({
        cliAgentType: "codex",
        agentDisplayName: "Codex App",
        model: "gpt-5.6-sol",
        origin: { kind: "external_history", source: "codex_app" },
      }),
    });
    const record = (store.get(sessionsAtom) as Session[]).find(
      (session) => session.session_id === expectedId
    );

    expect(result?.updated).toBe(false);
    expect(client.getSessionEventSegments).not.toHaveBeenCalled();
    expect(record?.model).toBeUndefined();
    expect(record?.importedFrom).toMatchObject({
      externalHistorySource: "codex_app",
      sourceDisplay: {
        cliAgentType: "codex",
        agentDisplayName: "Codex App",
        model: "gpt-5.6-sol",
      },
    });
    expect(record).toMatchObject({
      agentDisplayName: "Codex App",
      agentIconId: "codex",
    });
  });

  it("stamps Session.orgId on a MEMBER import so the sidebar org filter matches", async () => {
    const client = {
      getSessionEventSegments: vi.fn(async () => sealSnapshot(makeSnapshot())),
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
    // Ownership stamp is a SCOPE SELECTOR value (what the sidebar filter and
    // the engine's ownedByOrg gate compare against); provenance keeps the
    // bare org id.
    expect(record.orgId).toBe("cloud:org-1");
    expect(record.importedFrom?.orgId).toBe("org-1");
    expect(record.importedFrom?.shareToken).toBeUndefined();
  });

  it("preserves an external app source on the local replay provenance", async () => {
    const client = {
      getSessionEventSegments: vi.fn(async () => sealSnapshot(makeSnapshot())),
    } satisfies Pick<CollabSyncBackendClient, "getSessionEventSegments">;

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
    });
    const record = (store.get(sessionsAtom) as Session[]).find(
      (session) => session.session_id === result!.localSessionId
    );

    expect(record?.importedFrom?.externalHistorySource).toBe("codex_app");
    expect(record?.importedFrom?.sourceDisplay).toEqual({
      cliAgentType: "codex",
      agentDisplayName: "Codex App",
      agentDefinitionId: "codex-app",
      model: "gpt-5.6-sol",
    });
    expect(record).toMatchObject({
      agentDisplayName: "Codex App",
      agentIconId: "codex",
    });
    expect(record?.model).toBeUndefined();
  });

  it("keeps a named ORGII agent identity when opening creates the local replay", async () => {
    const client = {
      getSessionEventSegments: vi.fn(async () => sealSnapshot(makeSnapshot())),
    } satisfies Pick<CollabSyncBackendClient, "getSessionEventSegments">;

    const result = await importRemoteSession({
      client,
      orgId: "org-1",
      remoteSession: makeRemote({
        agentDisplayName: "Agent Architect",
        agentDefinitionId: "builtin:agent-architect",
        model: "gpt-5.6-sol",
        origin: { kind: "orgii" },
      }),
    });
    const record = (store.get(sessionsAtom) as Session[]).find(
      (session) => session.session_id === result!.localSessionId
    );

    expect(record).toMatchObject({
      agentDisplayName: "ORG2",
      agentIconId: "orgii",
      model: undefined,
      importedFrom: {
        sourceDisplay: {
          agentDisplayName: "Agent Architect",
          agentDefinitionId: "builtin:agent-architect",
          model: "gpt-5.6-sol",
        },
      },
    });
  });

  it("leaves Session.orgId unset on a GUEST share-token import (stays under Personal)", async () => {
    const client = {
      getSessionEventSegments: vi.fn(async () => sealSnapshot(makeSnapshot())),
    } satisfies Pick<CollabSyncBackendClient, "getSessionEventSegments">;

    // Guest context: CollabShareImportDialog — the share token authenticates,
    // there is no local membership of org-1.
    const result = await importRemoteSession({
      client,
      orgId: "org-1",
      remoteSession: makeRemote(),
      shareToken: "share-token",
      shareEndpointUrl: "https://cloud.example.com",
    });

    const record = (store.get(sessionsAtom) as Session[]).find(
      (session) => session.session_id === result!.localSessionId
    )!;
    // No ownership stamp — the import groups under Personal in the sidebar.
    expect(record.orgId).toBeUndefined();
    // Provenance still records the origin org.
    expect(record.importedFrom?.orgId).toBe("org-1");
    expect(record.importedFrom?.shareToken).toBe("share-token");
    expect(record.importedFrom?.shareEndpointUrl).toBe(
      "https://cloud.example.com"
    );
  });

  it("guest import survives an authoritative list replace via the registry", async () => {
    const client = {
      getSessionEventSegments: vi.fn(async () => sealSnapshot(makeSnapshot())),
    } satisfies Pick<CollabSyncBackendClient, "getSessionEventSegments">;

    const result = await importRemoteSession({
      client,
      orgId: "org-1",
      remoteSession: makeRemote(),
      shareToken: "share-token",
      shareEndpointUrl: "https://cloud.example.com",
    });

    const restored = mergeGuestImportedSessions([]).find(
      (session) => session.session_id === result!.localSessionId
    );
    expect(restored?.importedFrom?.shareToken).toBe("share-token");
    expect(restored?.importedFrom?.shareEndpointUrl).toBe(
      "https://cloud.example.com"
    );
    expect(restored?.importedFrom?.orgId).toBe("org-1");
    expect(restored?.importedFrom?.sourceSessionId).toBe("remote-1");

    removeGuestImportedSession(result!.localSessionId);
    expect(mergeGuestImportedSessions([])).toEqual([]);
  });

  it("member imports never enter the guest registry", async () => {
    const client = {
      getSessionEventSegments: vi.fn(async () => sealSnapshot(makeSnapshot())),
    } satisfies Pick<CollabSyncBackendClient, "getSessionEventSegments">;

    await importRemoteSession({
      client,
      orgId: "org-1",
      remoteSession: makeRemote(),
    });

    expect(mergeGuestImportedSessions([])).toEqual([]);
  });

  it("fails closed when decoded segment content disagrees with its hash", async () => {
    const snapshot = await sealSnapshot(makeSnapshot());
    const tampered = {
      ...snapshot,
      segments: snapshot.segments.map((segment) => ({
        ...segment,
        events: [
          {
            ...(segment.events[0] as unknown as Record<string, unknown>),
            id: "tampered",
          } as unknown as SessionEvent,
          ...segment.events.slice(1),
        ],
      })),
    };
    const client = {
      getSessionEventSegments: vi.fn(async () => tampered),
    } satisfies Pick<CollabSyncBackendClient, "getSessionEventSegments">;

    await expect(
      importRemoteSession({
        client,
        orgId: "org-1",
        remoteSession: makeRemote(),
      })
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof SegmentIntegrityError &&
        error.mismatch === "content_hash" &&
        error.seq === 1 &&
        !error.isTail
    );
    expect(eventStoreMock.set).not.toHaveBeenCalled();
  });

  it("an aborted import stops before any durable write", async () => {
    const controller = new AbortController();
    const client = {
      getSessionEventSegments: vi.fn(
        async (input: { signal?: AbortSignal }) => {
          expect(input.signal).toBe(controller.signal);
          controller.abort();
          return sealSnapshot(makeSnapshot());
        }
      ),
    } satisfies Pick<CollabSyncBackendClient, "getSessionEventSegments">;

    await expect(
      importRemoteSession({
        client,
        orgId: "org-1",
        remoteSession: makeRemote(),
        signal: controller.signal,
      })
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof DOMException && error.name === "AbortError"
    );
    expect(eventStoreMock.set).not.toHaveBeenCalled();
    expect(eventStoreMock.saveToCache).not.toHaveBeenCalled();
  });

  it("rolls back durable history when cancellation arrives before the session-row commit", async () => {
    const controller = new AbortController();
    const client = {
      getSessionEventSegments: vi.fn(async () => sealSnapshot(makeSnapshot())),
    } satisfies Pick<CollabSyncBackendClient, "getSessionEventSegments">;
    eventStoreMock.saveToCache.mockImplementationOnce(async () => {
      controller.abort();
      return 1;
    });

    await expect(
      importRemoteSession({
        client,
        orgId: "org-1",
        remoteSession: makeRemote(),
        signal: controller.signal,
      })
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof DOMException && error.name === "AbortError"
    );

    const expectedId = await deriveImportedSessionId("org-1", "remote-1");
    expect(eventStoreMock.set).toHaveBeenCalledTimes(1);
    expect(eventStoreMock.clearPersistedHistory).toHaveBeenCalledWith(
      expectedId
    );
    expect(eventStoreMock.clear).toHaveBeenCalledWith(expectedId);
    expect(store.get(sessionsAtom)).toHaveLength(0);
  });

  it("keeps identically named remote sessions from different endpoints isolated", async () => {
    const client = {
      getSessionEventSegments: vi.fn(async () => sealSnapshot(makeSnapshot())),
    } satisfies Pick<CollabSyncBackendClient, "getSessionEventSegments">;

    const cloudA = await importRemoteSession({
      client,
      orgId: "org-1",
      remoteSession: makeRemote(),
      sourceEndpointUrl: "https://cloud-a.example.com",
    });
    const cloudB = await importRemoteSession({
      client,
      orgId: "org-1",
      remoteSession: makeRemote(),
      sourceEndpointUrl: "https://cloud-b.example.com",
    });

    expect(cloudA?.localSessionId).not.toBe(cloudB?.localSessionId);
    const records = store.get(sessionsAtom) as Session[];
    expect(records).toHaveLength(2);
    expect(
      records.map((record) => record.importedFrom?.sourceEndpointUrl).sort()
    ).toEqual(["https://cloud-a.example.com", "https://cloud-b.example.com"]);
  });

  it("fails closed when a segment's eventCount disagrees with its payload", async () => {
    const snapshot = await sealSnapshot(makeSnapshot());
    const tampered = {
      ...snapshot,
      segments: snapshot.segments.map((segment) => ({
        ...segment,
        eventCount: segment.eventCount + 1,
      })),
    };
    const client = {
      getSessionEventSegments: vi.fn(async () => tampered),
    } satisfies Pick<CollabSyncBackendClient, "getSessionEventSegments">;

    await expect(
      importRemoteSession({
        client,
        orgId: "org-1",
        remoteSession: makeRemote(),
      })
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof SegmentIntegrityError &&
        error.mismatch === "event_count"
    );
    expect(eventStoreMock.set).not.toHaveBeenCalled();
  });

  it("preserves a guest capability during a later tokenless re-import", async () => {
    const client = {
      getSessionEventSegments: vi.fn(async () => sealSnapshot(makeSnapshot())),
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
          shareEndpointUrl: "https://cloud.example.com",
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
    expect(record?.importedFrom?.shareEndpointUrl).toBe(
      "https://cloud.example.com"
    );
  });

  it("serializes concurrent imports without sharing a caller's promise", async () => {
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
        .mockImplementation(async () =>
          sealSnapshot({
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
          })
        ),
    } satisfies Pick<CollabSyncBackendClient, "getSessionEventSegments">;

    // Engine PullLoop and a panel replay click race on the same session. The
    // second attempt waits instead of sharing the first caller's cancellation.
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
    for (let flush = 0; flush < 5; flush += 1) await Promise.resolve();
    expect(client.getSessionEventSegments).toHaveBeenCalledTimes(1);

    resolveFirstFetch(await sealSnapshot(makeSnapshot()));
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult?.localSessionId).toBe(secondResult?.localSessionId);
    expect(client.getSessionEventSegments).toHaveBeenCalledTimes(2);
    expect(eventStoreMock.set).toHaveBeenCalledTimes(2);

    // The in-flight entry is cleared afterwards: a later call with a newer
    // remote summary fetches again instead of returning the stale promise.
    const third = await importRemoteSession({
      client,
      orgId: "org-1",
      remoteSession: makeRemote({ eventsFrozenSeq: 2, eventsCount: 2 }),
    });
    expect(client.getSessionEventSegments).toHaveBeenCalledTimes(3);
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

  it("preserves every frozen segment plus the mutable tail in source order", async () => {
    const snapshot = await sealSnapshot({
      epoch: 3,
      frozenSeq: 2,
      tailHash: "tail-hash",
      count: 5,
      segments: [
        {
          seq: 1,
          isTail: false,
          events: [
            { id: "turn-1-user", sessionId: "remote-1" },
            { id: "turn-1-agent", sessionId: "remote-1" },
          ] as SessionEvent[],
          eventCount: 2,
          segmentHash: "h1",
        },
        {
          seq: 2,
          isTail: false,
          events: [
            { id: "turn-2-user", sessionId: "remote-1" },
            { id: "turn-2-agent", sessionId: "remote-1" },
          ] as SessionEvent[],
          eventCount: 2,
          segmentHash: "h2",
        },
        {
          seq: 0,
          isTail: true,
          events: [
            { id: "turn-3-user", sessionId: "remote-1" },
          ] as SessionEvent[],
          eventCount: 1,
          segmentHash: "tail-hash",
        },
      ],
    });
    const client = {
      getSessionEventSegments: vi.fn(async () => snapshot),
    } satisfies Pick<CollabSyncBackendClient, "getSessionEventSegments">;

    const result = await forkSession({
      client,
      orgId: "org-1",
      remoteSession: makeRemote({
        eventsEpoch: 3,
        eventsFrozenSeq: 2,
        eventsCount: 5,
        eventsTailHash: snapshot.tailHash ?? undefined,
      }),
    });

    expect(result?.eventCount).toBe(5);
    const [written, forkId] = eventStoreMock.set.mock.calls[0];
    // Inherited event ids are namespaced by the fork's local session id so
    // they cannot collide (PK id) with the source or a sibling import copy.
    expect((written as SessionEvent[]).map((event) => event.id)).toEqual([
      `${forkId}~turn-1-user`,
      `${forkId}~turn-1-agent`,
      `${forkId}~turn-2-user`,
      `${forkId}~turn-2-agent`,
      `${forkId}~turn-3-user`,
    ]);
  });

  it("fails closed when a tail-only snapshot contradicts the list summary", async () => {
    const snapshot = await sealSnapshot({
      epoch: 4,
      frozenSeq: 0,
      tailHash: "tail-only",
      count: 1,
      segments: [
        {
          seq: 0,
          isTail: true,
          events: [
            { id: "latest-only", sessionId: "remote-1" },
          ] as SessionEvent[],
          eventCount: 1,
          segmentHash: "tail-only",
        },
      ],
    });
    const client = {
      getSessionEventSegments: vi.fn(async () => snapshot),
    } satisfies Pick<CollabSyncBackendClient, "getSessionEventSegments">;

    await expect(
      forkSession({
        client,
        orgId: "org-1",
        remoteSession: makeRemote({
          eventsEpoch: 4,
          eventsFrozenSeq: 2,
          eventsCount: 5,
          eventsTailHash: snapshot.tailHash ?? undefined,
        }),
      })
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ForkSnapshotIntegrityError &&
        error.kind === FORK_SNAPSHOT_ERROR_KIND.SNAPSHOT_INCOMPLETE
    );
    expect(eventStoreMock.set).not.toHaveBeenCalled();
  });

  it("creates a WRITABLE session with forkedFrom provenance and persisted events", async () => {
    const client = {
      getSessionEventSegments: vi.fn(async () => sealSnapshot(makeSnapshot())),
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
    // Selector value, not a bare org id — a bare value resolves to no owning
    // org and strips every ownership-derived affordance (share dialog).
    expect(record!.orgId).toBe("cloud:org-1");
  });

  it("uses the resolved LOCAL workspace over the owner's absolute path when provided", async () => {
    const client = {
      getSessionEventSegments: vi.fn(async () => sealSnapshot(makeSnapshot())),
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
      getSessionEventSegments: vi.fn(async () => sealSnapshot(makeSnapshot())),
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
      getSessionEventSegments: vi.fn(async () => sealSnapshot(makeSnapshot())),
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
      getSessionEventSegments: vi.fn(async () => sealSnapshot(makeSnapshot())),
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

  it("throws a typed replay error for metadata-only sessions without fetching", async () => {
    const client = {
      getSessionEventSegments: vi.fn(async () => sealSnapshot(makeSnapshot())),
    } satisfies Pick<CollabSyncBackendClient, "getSessionEventSegments">;

    await expect(
      forkSession({
        client,
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
    expect(client.getSessionEventSegments).not.toHaveBeenCalled();
    expect(store.get(sessionsAtom)).toHaveLength(0);
  });

  it("throws on a failed durable write and leaves no session record behind", async () => {
    const client = {
      getSessionEventSegments: vi.fn(async () => sealSnapshot(makeSnapshot())),
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
