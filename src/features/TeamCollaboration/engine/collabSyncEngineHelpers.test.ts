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
  computeFrozenEventCount,
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

  it("holds recently-terminal events inside the mutation horizon in the tail", () => {
    // Terminal ≠ immutable while the ingest can still amend (tool-result
    // backfill): freezing them made every amendment a full epoch rewrite.
    const now = Date.parse("2026-07-25T12:00:00Z");
    const old = { createdAt: "2026-07-25T11:00:00Z" };
    const recent = { createdAt: "2026-07-25T11:55:00Z" };
    const events = [event(old), event(old), event(recent), event(recent)];
    expect(computeFrozenEventCount(events, now)).toBe(2);
  });

  it("freezes everything once the session is quiescent past the horizon", () => {
    const now = Date.parse("2026-07-25T12:00:00Z");
    const old = { createdAt: "2026-07-25T11:00:00Z" };
    const events = [event(old), event(old), event(old)];
    expect(computeFrozenEventCount(events, now)).toBe(3);
  });

  it("caps horizon holdback so a busy span cannot grow the tail unbounded", () => {
    const now = Date.parse("2026-07-25T12:00:00Z");
    const recent = { createdAt: "2026-07-25T11:59:00Z" };
    const events = Array.from({ length: 60 }, () => event(recent));
    expect(computeFrozenEventCount(events, now)).toBe(20);
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
    expect(row.orgId).toBe("cloud:org-1");
    expect(row).toMatchObject({
      agentDisplayName: "Codex App",
      agentIconId: "codex",
    });
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
    expect(
      (store.get(sessionsAtom) as Session[]).find(
        (session) => session.session_id === localSessionId
      )?.orgId
    ).toBe("cloud:org-1");
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

  it("accepts a bounded snapshot that grew past the list summary", async () => {
    ingestRemoteSnapshotMock.mockImplementationOnce(
      async ({ localSessionId }: { localSessionId: string }) =>
        makeCommit(localSessionId, {
          eventCount: 6,
          tailHash: "fresh-tail",
        })
    );

    const result = await forkSession({
      client: makeWireClient(),
      orgId: "org-1",
      remoteSession: makeRemote({
        eventsCount: 5,
        eventsTailHash: "stale-tail",
      }),
    });

    expect(result?.eventCount).toBe(6);
    expect(eventStoreMock.clearPersistedHistory).not.toHaveBeenCalled();
  });

  it("accepts a bounded snapshot whose generation advanced", async () => {
    ingestRemoteSnapshotMock.mockImplementationOnce(
      async ({ localSessionId }: { localSessionId: string }) =>
        makeCommit(localSessionId, {
          epoch: 4,
          frozenSeq: 1,
          eventCount: 2,
          frozenEventCount: 1,
          tailHash: "rewritten-tail",
        })
    );

    const result = await forkSession({
      client: makeWireClient(),
      orgId: "org-1",
      remoteSession: makeRemote({
        eventsEpoch: 3,
        eventsFrozenSeq: 9,
        eventsCount: 12,
        eventsTailHash: "old-tail",
      }),
    });

    expect(result?.eventCount).toBe(2);
    expect(eventStoreMock.clearPersistedHistory).not.toHaveBeenCalled();
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
