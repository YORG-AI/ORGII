import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CollabOutboxPushItem } from "@src/api/http/project";
import { getImportedHistorySourceBySessionId } from "@src/api/tauri/externalHistory";
import Message from "@src/components/Message";
import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import type {
  EventDisplayStatus,
  SessionEvent,
} from "@src/engines/SessionCore/core/types";
import { processChunksRust } from "@src/engines/SessionCore/ingestion/rustBridge";
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";
import { sessionsAtom } from "@src/store/session/sessionAtom/atoms";
import type { Session } from "@src/store/session/sessionAtom/types";
import { createInstrumentedStore } from "@src/util/core/state/instrumentedStore";

import { stableStringify } from "../TeamCollaboration/collabSyncUtils";
import { __FORK_RELAY_INTERNALS } from "../TeamCollaboration/forkSession";
import {
  peekShareableScopeKeys,
  primeShareableScopeKey,
} from "../TeamCollaboration/repoScopeResolver";
import {
  cloudOrgToken,
  sessionOrgTagsAtom,
} from "../TeamCollaboration/sessionOrgTagsAtom";
import {
  ORG2_CLOUD_ENDPOINT_OVERRIDE_STORAGE_KEY,
  ORG2_CLOUD_EXPECTED_SCHEMA_VERSION,
  ORG2_CLOUD_OFFICIAL_SUPABASE_URL,
} from "./config";
import { org2CloudAccessSettingsAtom } from "./org2CloudAccessSettings";
import type { Org2CloudAuthState } from "./org2CloudAuthAtom";
import { org2CloudAuthAtom } from "./org2CloudAuthAtom";
import { org2CloudCommentTasksAtom } from "./org2CloudCommentTasksAtom";
import type {
  CloudCommentTask,
  ListCommentTasksResult,
} from "./org2CloudCommentTasksClient";
import { Org2CloudTaskError } from "./org2CloudCommentTasksClient";
import { org2CloudOrgsAtom } from "./org2CloudOrgsAtom";
import { ensureProjectOrgForCloudOrg } from "./org2CloudProjectOrgAlias";
import type { CloudOrgCollabState } from "./org2CloudProjectsClient";
import { Org2CloudProjectsError } from "./org2CloudProjectsClient";
import {
  org2CloudCollabStateCursorsAtom,
  org2CloudCommentTaskCursorsAtom,
  org2CloudPushCursorsAtom,
  org2CloudPushedMetadataAtom,
  org2CloudRepoScopesAtom,
  org2CloudSyncEnabledAtom,
} from "./org2CloudSyncAtoms";
import type {
  CloudAppendSessionEventsInput,
  CloudOrgScopeState,
  CloudRewriteSessionEventsInput,
  CloudSessionEventsSnapshot,
} from "./org2CloudSyncClient";
import { Org2CloudSyncError } from "./org2CloudSyncClient";
import {
  DATA_CHANGED_DEBOUNCE_MS,
  HIDDEN_PASS_INTERVAL_MS,
  ORG_BACKOFF_COOLDOWN_MS,
  Org2CloudSyncEngine,
  PASS_INTERVAL_MS,
  PROJECT_PUSH_RETRY_DELAY_MS,
  buildCloudSessionMetadata,
  isCloudPushCandidate,
} from "./org2CloudSyncEngine";

const { tauriEventListeners } = vi.hoisted(() => ({
  tauriEventListeners: new Map<string, Set<(event: unknown) => void>>(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: unknown) => void) => {
    let handlers = tauriEventListeners.get(name);
    if (!handlers) {
      handlers = new Set();
      tauriEventListeners.set(name, handlers);
    }
    handlers.add(handler);
    return () => handlers.delete(handler);
  }),
}));

vi.mock("@src/engines/SessionCore/core/store/EventStoreProxy", () => ({
  eventStoreProxy: {
    subscribe: vi.fn(() => () => undefined),
    getPersistedEvents: vi.fn(),
  },
}));

vi.mock("@src/engines/SessionCore/ingestion/rustBridge", () => ({
  processChunksRust: vi.fn(),
}));

// Scope keys resolve through git-remote IPC in production; stubbed to a
// synchronous map here so scope matching is deterministic.
vi.mock("../TeamCollaboration/repoScopeResolver", () => ({
  peekShareableScopeKeys: vi.fn(),
  primeShareableScopeKey: vi.fn(),
}));

vi.mock("@src/components/Message", () => ({
  default: { warning: vi.fn(), success: vi.fn(), error: vi.fn() },
}));

vi.mock("@src/i18n", () => ({
  default: { t: (key: string) => key },
}));

vi.mock("./org2CloudClient", () => ({
  ensureFreshSession: vi.fn(async (state: unknown) => state),
  schemaVersion: vi.fn(async () => null),
}));

// The alias helper reads local SQLite through projectApi; the engine only
// consumes the returned project-org id.
vi.mock("./org2CloudProjectOrgAlias", () => ({
  ensureProjectOrgForCloudOrg: vi.fn(async (org: { orgId: string }) => ({
    id: `porg-${org.orgId}`,
  })),
}));

const eventStoreMock = vi.mocked(eventStoreProxy);
const processChunksRustMock = vi.mocked(processChunksRust);
const peekMock = vi.mocked(peekShareableScopeKeys);
const primeMock = vi.mocked(primeShareableScopeKey);
const messageMock = vi.mocked(Message);

/**
 * The node test environment has no `document` (the engine's visibility
 * gating treats that as always-visible). Install a minimal EventTarget
 * stub BEFORE the engine starts so the visibility paths — listener
 * registration in start()/stop() and the hidden 5-minute cadence — are
 * exercisable; tests flip `visibilityState` directly.
 */
class DocumentStub extends EventTarget {
  visibilityState: DocumentVisibilityState = "visible";
}
const documentStub = new DocumentStub();
Object.defineProperty(globalThis, "document", {
  value: documentStub,
  configurable: true,
  writable: true,
});

const REPO_PATH = "/repo/alpha";
const SCOPE_KEY = "github.com/acme/alpha";

/** Custom-deployment URL used by the Phase C endpoint-override tests. */
const CUSTOM_SUPABASE_URL = "https://supabase.acme.dev";

const AUTH: Org2CloudAuthState = {
  kind: "org2_cloud",
  // These tests run against the official endpoint (no localStorage
  // override), so the auth carries the official URL — exactly what a real
  // official-endpoint sign-in records. The engine's endpoint-identity guard
  // bails the pass whenever getCloudEndpoint() diverges from this.
  supabaseUrl: ORG2_CLOUD_OFFICIAL_SUPABASE_URL,
  supabaseAnonKey: "anon",
  userId: "user-1",
  accessToken: "jwt-1",
  refreshToken: "rt-1",
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
  profile: { displayName: "Me" },
};

const SESSION: Session = {
  session_id: "session-1",
  status: "completed",
  created_at: "2026-07-01T00:00:00.000Z",
  updated_at: "2026-07-01T00:00:00.000Z",
  name: "Local session",
  orgId: "cloud:corg-1",
  repoPath: REPO_PATH,
  category: "rust_agent",
};

function makeEvent(
  id: string,
  displayStatus: EventDisplayStatus = "completed"
): SessionEvent {
  return {
    id,
    sessionId: "session-1",
    displayStatus,
  } as unknown as SessionEvent;
}

function conflictError(): Org2CloudSyncError {
  return new Org2CloudSyncError("ORG2_CONFLICT", 409);
}

function makeClient() {
  return {
    upsertSessionMetadata: vi.fn(
      async (
        _token: string,
        _orgId: string,
        _sessionId: string,
        _metadata: RemoteTeammateSessionMetadata
      ) => undefined
    ),
    appendSessionEvents: vi.fn(
      async (_token: string, _input: CloudAppendSessionEventsInput) => undefined
    ),
    rewriteSessionEvents: vi.fn(
      async (_token: string, _input: CloudRewriteSessionEventsInput) =>
        undefined
    ),
    getSessionEvents: vi.fn(
      async (
        _token: string | null,
        _orgId: string,
        _sessionId: string
      ): Promise<CloudSessionEventsSnapshot> => ({
        epoch: null,
        frozenSeq: null,
        tailHash: null,
        count: null,
        segments: [],
      })
    ),
    getOrgRepoScopes: vi.fn(
      async (_token: string, _orgId: string): Promise<CloudOrgScopeState> => ({
        repoScopes: [],
        used: 0,
        cap: null,
        cooldownDays: 0,
        coolingDown: [],
      })
    ),
    deleteSession: vi.fn(
      async (_token: string, _orgId: string, _sessionId: string) => undefined
    ),
  };
}

function makeProjectsClient() {
  return {
    listOrgCollabState: vi.fn(
      async (
        _token: string,
        _orgId: string,
        _since?: string
      ): Promise<CloudOrgCollabState> => ({
        serverTime: "2026-07-01T12:00:00.000Z",
        projects: [],
        workItems: [],
      })
    ),
    upsertProject: vi.fn(async () => ({ id: "p-1", version: 1 })),
    upsertWorkItem: vi.fn(async () => ({ id: "AAA-0001", version: 1 })),
    deleteProject: vi.fn(async () => undefined),
    deleteWorkItem: vi.fn(async () => undefined),
  };
}

function makeTasksClient() {
  return {
    listCommentTasks: vi.fn(
      async (
        _token: string,
        _orgId: string,
        _since: string | null
      ): Promise<ListCommentTasksResult> => ({
        serverTime: "2026-07-01T12:00:00.000Z",
        tasks: [],
      })
    ),
  };
}

function makeTask(
  id: string,
  overrides: Partial<CloudCommentTask> = {}
): CloudCommentTask {
  return {
    id,
    sessionId: "session-1",
    commentId: `comment-${id}`,
    state: "open",
    leaseExpired: false,
    attempt: 0,
    createdAt: "2026-07-01T10:00:00.000Z",
    updatedAt: "2026-07-01T10:00:00.000Z",
    ...overrides,
  };
}

function makeBridge() {
  return {
    drainOutbox: vi.fn(async () => [] as CollabOutboxPushItem[]),
    ackOutbox: vi.fn(async () => undefined),
    applyRemote: vi.fn(async () => 0),
    notifyDataChanged: vi.fn(async () => undefined),
    notifyOutboxFlushed: vi.fn(async () => undefined),
  };
}

/** Fire the engine's eventStore subscription as an `es:changed` envelope
 * for one session (production: EventStoreProxy notifies on every write). */
/** Fire the engine's `orgii-data-changed` Tauri subscription (production:
 * every local project/work-item mutation site + the bridge's
 * notifyDataChanged emit this). */
function emitDataChanged(): void {
  for (const handler of tauriEventListeners.get("orgii-data-changed") ?? []) {
    handler({ payload: undefined });
  }
}

function notifySessionEvents(sessionId: string): void {
  for (const [listener] of eventStoreMock.subscribe.mock.calls) {
    (listener as (snapshot: unknown, sessionId: string) => void)(
      undefined,
      sessionId
    );
  }
}

describe("Org2CloudSyncEngine", () => {
  const store = createInstrumentedStore();
  let client: ReturnType<typeof makeClient>;
  let projectsClient: ReturnType<typeof makeProjectsClient>;
  let tasksClient: ReturnType<typeof makeTasksClient>;
  let bridge: ReturnType<typeof makeBridge>;
  let engine: Org2CloudSyncEngine;

  beforeEach(() => {
    tauriEventListeners.clear();
    client = makeClient();
    projectsClient = makeProjectsClient();
    tasksClient = makeTasksClient();
    bridge = makeBridge();
    engine = new Org2CloudSyncEngine(
      client,
      projectsClient,
      tasksClient,
      bridge
    );
    store.set(org2CloudAuthAtom, AUTH);
    store.set(org2CloudOrgsAtom, [
      { orgId: "corg-1", name: "Cloud Team", role: "member" },
    ]);
    store.set(org2CloudRepoScopesAtom, { "corg-1": [SCOPE_KEY] });
    store.set(org2CloudSyncEnabledAtom, {});
    store.set(org2CloudPushCursorsAtom, {});
    store.set(org2CloudPushedMetadataAtom, {});
    store.set(org2CloudCollabStateCursorsAtom, {});
    store.set(org2CloudCommentTaskCursorsAtom, {});
    store.set(org2CloudCommentTasksAtom, {});
    store.set(sessionOrgTagsAtom, {});
    // Access ladder (§13.4): the DEFAULT default is OFF (nothing uploads).
    // Most push-flow tests predate the ladder, so they opt the org into
    // full_replay here; ladder-specific tests override per case.
    store.set(org2CloudAccessSettingsAtom, {
      "corg-1": {
        defaultMode: "full_replay",
        sessionModes: {},
        sessionVisibility: {},
      },
    });
    store.set(sessionsAtom, [SESSION]);
    peekMock.mockImplementation((path: string) =>
      path === REPO_PATH ? [SCOPE_KEY] : null
    );
    // Default hydration echoes the current local mirror so tests that seed
    // the scopes atom directly keep their semantics; hydration-specific
    // tests override this per case.
    client.getOrgRepoScopes.mockImplementation(
      async (_token: string, orgId: string) => ({
        repoScopes: store.get(org2CloudRepoScopesAtom)[orgId] ?? [],
        used: 0,
        cap: null,
        cooldownDays: 0,
        coolingDown: [],
      })
    );
    eventStoreMock.getPersistedEvents.mockResolvedValue([
      makeEvent("e1"),
      makeEvent("e2", "running"),
    ]);
    processChunksRustMock.mockResolvedValue([]);
    // start() schedules a 0ms pass; drive passes manually instead.
    vi.useFakeTimers();
    engine.start(store);
  });

  it("publishes Cursor from the full source transcript, never its preview window or event cache", async () => {
    const source = getImportedHistorySourceBySessionId("cursoride-thread-1");
    expect(source).toBeDefined();
    const fullChunks = [{ id: "full-cursor-chunk" }] as never;
    const fullLoader = vi
      .spyOn(source!, "loadFullTranscriptChunks")
      .mockResolvedValue(fullChunks);
    const previewLoader = vi.spyOn(source!, "loadPreviewChunks");
    const converted = [makeEvent("cursor-event")];
    processChunksRustMock.mockResolvedValueOnce(converted);

    const events = await (
      engine as unknown as {
        loadPushEvents(sessionId: string): Promise<SessionEvent[]>;
      }
    ).loadPushEvents("cursoride-thread-1");

    expect(events).toEqual(converted);
    expect(fullLoader).toHaveBeenCalledWith("cursoride-thread-1");
    expect(previewLoader).not.toHaveBeenCalled();
    expect(eventStoreMock.getPersistedEvents).not.toHaveBeenCalledWith(
      "cursoride-thread-1"
    );
    expect(processChunksRustMock).toHaveBeenCalledWith(
      fullChunks,
      "cursoride-thread-1"
    );
  });

  afterEach(() => {
    engine.stop();
    localStorage.removeItem(ORG2_CLOUD_ENDPOINT_OVERRIDE_STORAGE_KEY);
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  /** Point the resolver at a custom endpoint and rebuild the engine with an
   * injected `schema_version()` probe (the schema gate only runs on custom
   * endpoints, Phase C). The auth is re-seeded with the custom URL —
   * a sign-in against a custom deployment records that deployment's
   * supabaseUrl, and the endpoint-identity guard requires the active
   * endpoint to match the token's backend. */
  function startWithCustomEndpoint(probe: () => Promise<number | null>): void {
    localStorage.setItem(
      ORG2_CLOUD_ENDPOINT_OVERRIDE_STORAGE_KEY,
      JSON.stringify({
        webOrigin: "https://cloud.acme.dev",
        supabaseUrl: CUSTOM_SUPABASE_URL,
        anonKey: "sb_publishable_custom",
      })
    );
    store.set(org2CloudAuthAtom, { ...AUTH, supabaseUrl: CUSTOM_SUPABASE_URL });
    engine.stop();
    engine = new Org2CloudSyncEngine(
      client,
      projectsClient,
      tasksClient,
      bridge,
      probe
    );
    engine.start(store);
  }

  it("pushes only scope-matched own sessions (metadata + epoch-1 rewrite)", async () => {
    store.set(sessionsAtom, [
      SESSION,
      { ...SESSION, session_id: "session-out", repoPath: "/repo/other" },
      {
        ...SESSION,
        session_id: "session-imported",
        importedFrom: { orgId: "x" } as never,
      },
    ]);
    await engine.runSyncPass();

    expect(client.upsertSessionMetadata).toHaveBeenCalledTimes(1);
    const [token, orgId, sessionId, metadata] =
      client.upsertSessionMetadata.mock.calls[0];
    expect(token).toBe("jwt-1");
    expect(orgId).toBe("corg-1");
    expect(sessionId).toBe("session-1");
    expect(metadata).toMatchObject({
      id: "corg-1:user-1:session-1",
      ownerMemberId: "user-1",
      ownerDisplayName: "Me",
      repoScopeKey: SCOPE_KEY,
      title: "Local session",
    });

    expect(client.rewriteSessionEvents).toHaveBeenCalledTimes(1);
    const [, rewrite] = client.rewriteSessionEvents.mock.calls[0];
    expect(rewrite).toMatchObject({
      orgId: "corg-1",
      sessionId: "session-1",
      newEpoch: 1,
      totalCount: 2,
    });
    // Frozen line: e1 is terminal, e2 is running → 1 frozen + 1 tail event.
    expect(rewrite.frozenSegments).toHaveLength(1);
    expect(rewrite.frozenSegments[0].events).toHaveLength(1);
    expect(rewrite.tail).toHaveLength(1);

    const cursor = store.get(org2CloudPushCursorsAtom)["corg-1:session-1"];
    expect(cursor).toMatchObject({
      orgId: "corg-1",
      sessionId: "session-1",
      epoch: 1,
      frozenSeq: 1,
      pushedCount: 2,
      frozenEventCount: 1,
    });
    expect(cursor.tailHash).not.toBeNull();
  });

  it("does not publish a Personal session merely because its remote matches a team scope", async () => {
    store.set(sessionsAtom, [
      { ...SESSION, session_id: "personal-session", orgId: "personal-org" },
    ]);

    await engine.runSyncPass();

    expect(client.upsertSessionMetadata).not.toHaveBeenCalled();
    expect(client.rewriteSessionEvents).not.toHaveBeenCalled();
  });

  it("allows an explicitly moved Personal session only when the target org scope matches", async () => {
    const personal = {
      ...SESSION,
      session_id: "moved-personal-session",
      orgId: "personal-org",
    };
    store.set(sessionsAtom, [personal]);
    store.set(sessionOrgTagsAtom, {
      [personal.session_id]: [cloudOrgToken("corg-1")],
    });

    await engine.runSyncPass();

    expect(client.upsertSessionMetadata).toHaveBeenCalledTimes(1);
    expect(client.upsertSessionMetadata.mock.calls[0][1]).toBe("corg-1");

    client.upsertSessionMetadata.mockClear();
    store.set(org2CloudRepoScopesAtom, { "corg-1": ["github.com/other/repo"] });
    await engine.runSyncPass();
    expect(client.upsertSessionMetadata).not.toHaveBeenCalled();
  });

  it("publishes a fork only to its source org when personal and team scopes overlap", async () => {
    const fork = {
      ...SESSION,
      session_id: "session-fork",
      forkedFrom: {
        orgId: "corg-team",
        sourceSessionId: "session-source",
        ownerMemberId: "user-owner",
        ownerDisplayName: "Owner",
        atCount: 2,
        forkedAt: "2026-07-02T00:00:00.000Z",
      },
    };
    store.set(sessionsAtom, [fork]);
    store.set(org2CloudOrgsAtom, [
      { orgId: "corg-personal", name: "Personal", role: "owner" },
      { orgId: "corg-team", name: "Team", role: "member" },
    ]);
    store.set(org2CloudRepoScopesAtom, {
      "corg-personal": [SCOPE_KEY],
      "corg-team": [SCOPE_KEY],
    });
    store.set(org2CloudAccessSettingsAtom, {
      "corg-personal": {
        defaultMode: "full_replay",
        sessionModes: {},
        sessionVisibility: {},
      },
      "corg-team": {
        defaultMode: "full_replay",
        sessionModes: {},
        sessionVisibility: {},
      },
    });

    await engine.runSyncPass();

    const destinations = client.upsertSessionMetadata.mock.calls.map(
      ([, orgId, sessionId]) => [orgId, sessionId]
    );
    expect(destinations).toEqual([["corg-team", "session-fork"]]);
    expect(client.rewriteSessionEvents).toHaveBeenCalledTimes(1);
    expect(client.rewriteSessionEvents.mock.calls[0][1].orgId).toBe(
      "corg-team"
    );
  });

  it("allows an explicit tag to move a guest fork into a member org", async () => {
    const fork: Session = {
      ...SESSION,
      session_id: "session-guest-fork",
      orgId: "personal-org",
      forkedFrom: {
        orgId: "corg-owner",
        sourceSessionId: "session-source",
        ownerMemberId: "user-owner",
        ownerDisplayName: "Owner",
        atCount: 2,
        forkedAt: "2026-07-02T00:00:00.000Z",
      },
    };
    store.set(sessionsAtom, [fork]);
    store.set(sessionOrgTagsAtom, {
      "session-guest-fork": [cloudOrgToken("corg-1")],
    });

    await engine.runSyncPass();

    expect(client.upsertSessionMetadata).toHaveBeenCalledWith(
      "jwt-1",
      "corg-1",
      "session-guest-fork",
      expect.any(Object)
    );
  });

  it("never publishes an untagged guest fork into a non-source org", async () => {
    const fork: Session = {
      ...SESSION,
      session_id: "session-guest-fork",
      orgId: "personal-org",
      forkedFrom: {
        orgId: "corg-owner",
        sourceSessionId: "session-source",
        ownerMemberId: "user-owner",
        ownerDisplayName: "Owner",
        atCount: 2,
        forkedAt: "2026-07-02T00:00:00.000Z",
      },
    };
    store.set(sessionsAtom, [fork]);

    await engine.runSyncPass();

    expect(client.upsertSessionMetadata).not.toHaveBeenCalled();
    expect(client.rewriteSessionEvents).not.toHaveBeenCalled();
  });

  it("appends incrementally against the persisted cursor anchors", async () => {
    await engine.runSyncPass(); // anchor (rewrite epoch 1)
    const anchored = store.get(org2CloudPushCursorsAtom)["corg-1:session-1"];

    // e2 froze, e3 is the new tail.
    eventStoreMock.getPersistedEvents.mockResolvedValue([
      makeEvent("e1"),
      makeEvent("e2"),
      makeEvent("e3", "running"),
    ]);
    notifySessionEvents("session-1"); // es:changed for the new write
    await engine.runSyncPass();

    expect(client.appendSessionEvents).toHaveBeenCalledTimes(1);
    const [, append] = client.appendSessionEvents.mock.calls[0];
    expect(append).toMatchObject({
      orgId: "corg-1",
      sessionId: "session-1",
      expectedEpoch: anchored.epoch,
      expectedFrozenSeq: anchored.frozenSeq,
      expectedTailHash: anchored.tailHash,
      totalCount: 3,
    });
    expect(append.newFrozenSegments[0].seq).toBe(anchored.frozenSeq + 1);

    const cursor = store.get(org2CloudPushCursorsAtom)["corg-1:session-1"];
    expect(cursor.epoch).toBe(anchored.epoch);
    expect(cursor.frozenSeq).toBe(anchored.frozenSeq + 1);
    expect(cursor.pushedCount).toBe(3);
    // Rewrite ran only for the initial anchor, not the append pass.
    expect(client.rewriteSessionEvents).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the push state is unchanged", async () => {
    await engine.runSyncPass();
    client.rewriteSessionEvents.mockClear();
    client.upsertSessionMetadata.mockClear();
    await engine.runSyncPass();
    expect(client.rewriteSessionEvents).not.toHaveBeenCalled();
    expect(client.appendSessionEvents).not.toHaveBeenCalled();
    // Metadata is hash-gated too.
    expect(client.upsertSessionMetadata).not.toHaveBeenCalled();
  });

  it("skips the full-history read + re-hash for a verified session until es:changed", async () => {
    await engine.runSyncPass();
    expect(eventStoreMock.getPersistedEvents).toHaveBeenCalledTimes(1);

    // Nothing signaled a write: the events plane is gated — no second
    // full-transcript IPC read on an idle session.
    await engine.runSyncPass();
    expect(eventStoreMock.getPersistedEvents).toHaveBeenCalledTimes(1);

    // A local event write invalidates the gate; the next pass re-verifies
    // and pushes the delta.
    eventStoreMock.getPersistedEvents.mockResolvedValue([
      makeEvent("e1"),
      makeEvent("e2"),
      makeEvent("e3", "running"),
    ]);
    notifySessionEvents("session-1");
    await engine.runSyncPass();
    expect(eventStoreMock.getPersistedEvents).toHaveBeenCalledTimes(2);
    expect(client.appendSessionEvents).toHaveBeenCalledTimes(1);
  });

  it("the events-plane gate never blocks the metadata self-heal path", async () => {
    await engine.runSyncPass();
    expect(client.upsertSessionMetadata).toHaveBeenCalledTimes(1);

    // Gated pass: no event read, but the (hash-invalidated) metadata
    // upsert still fires — the deleteSession/untag recovery relies on it.
    engine.invalidatePushedMetadataHash("corg-1", "session-1");
    await engine.runSyncPass();
    expect(eventStoreMock.getPersistedEvents).toHaveBeenCalledTimes(1);
    expect(client.upsertSessionMetadata).toHaveBeenCalledTimes(2);
  });

  it("re-anchors on ORG2_CONFLICT via server epoch + 1", async () => {
    await engine.runSyncPass(); // anchor at epoch 1
    eventStoreMock.getPersistedEvents.mockResolvedValue([
      makeEvent("e1"),
      makeEvent("e2"),
      makeEvent("e3", "running"),
    ]);
    notifySessionEvents("session-1");
    client.appendSessionEvents.mockRejectedValueOnce(conflictError());
    client.getSessionEvents.mockResolvedValueOnce({
      epoch: 5,
      frozenSeq: 9,
      tailHash: "server-tail",
      count: 9,
      segments: [],
    });

    await engine.runSyncPass();

    expect(client.rewriteSessionEvents).toHaveBeenCalledTimes(2);
    const [, reanchor] = client.rewriteSessionEvents.mock.calls[1];
    expect(reanchor.newEpoch).toBe(6);
    // Full rewrite re-ships the whole frozen prefix from seq 1.
    expect(reanchor.frozenSegments[0].seq).toBe(1);
    const cursor = store.get(org2CloudPushCursorsAtom)["corg-1:session-1"];
    expect(cursor.epoch).toBe(6);
    expect(cursor.pushedCount).toBe(3);
  });

  it("backs off the org and toasts once on ORG2_QUOTA_EXCEEDED", async () => {
    client.rewriteSessionEvents.mockRejectedValue(
      new Org2CloudSyncError("ORG2_QUOTA_EXCEEDED", 403)
    );
    await engine.runSyncPass();
    expect(messageMock.warning).toHaveBeenCalledTimes(1);
    expect(messageMock.warning).toHaveBeenCalledWith(
      "navigation:cloud.sync.quotaExceededToast"
    );

    client.rewriteSessionEvents.mockClear();
    client.upsertSessionMetadata.mockClear();
    await engine.runSyncPass();
    // Backed off: no further RPCs, no second toast.
    expect(client.upsertSessionMetadata).not.toHaveBeenCalled();
    expect(client.rewriteSessionEvents).not.toHaveBeenCalled();
    expect(messageMock.warning).toHaveBeenCalledTimes(1);
  });

  it("skips orgs without local scopes or with sync disabled", async () => {
    store.set(org2CloudSyncEnabledAtom, { "corg-1": false });
    await engine.runSyncPass();
    expect(client.upsertSessionMetadata).not.toHaveBeenCalled();

    store.set(org2CloudSyncEnabledAtom, {});
    store.set(org2CloudRepoScopesAtom, {});
    await engine.runSyncPass();
    expect(client.upsertSessionMetadata).not.toHaveBeenCalled();
  });

  it("skips sessions whose scope key is still resolving and primes it", async () => {
    peekMock.mockReturnValue(undefined);
    await engine.runSyncPass();
    expect(primeMock).toHaveBeenCalledWith(REPO_PATH);
    expect(client.upsertSessionMetadata).not.toHaveBeenCalled();
  });

  it("never pushes a tagged out-of-scope session and drops the stale tag", async () => {
    // Scope is the HARD boundary: the org's scope does NOT match the
    // session's repo, so the tag must not cause a push — instead the engine
    // invalidates it (nothing was ever pushed, so no retract call either).
    store.set(org2CloudRepoScopesAtom, { "corg-1": ["github.com/other/repo"] });
    store.set(sessionOrgTagsAtom, {
      "session-1": [cloudOrgToken("corg-1")],
    });
    await engine.runSyncPass();
    expect(client.upsertSessionMetadata).not.toHaveBeenCalled();
    expect(client.deleteSession).not.toHaveBeenCalled();
    expect(store.get(sessionOrgTagsAtom)).toEqual({});
  });

  it("does not target an org with no scopes even when a session is tagged into it", async () => {
    // No repo scopes = the org accepts nothing; the tag is invalidated.
    store.set(org2CloudRepoScopesAtom, {});
    store.set(sessionOrgTagsAtom, {
      "session-1": [cloudOrgToken("corg-1")],
    });
    await engine.runSyncPass();
    expect(client.upsertSessionMetadata).not.toHaveBeenCalled();
    expect(store.get(sessionOrgTagsAtom)).toEqual({});
  });

  it("retracts a previously-pushed session whose tag fell out of scope", async () => {
    // Push in scope first (default-ladder full_replay via the org default).
    await engine.runSyncPass();
    expect(client.upsertSessionMetadata).toHaveBeenCalledTimes(1);

    // Admin swaps the org's scope away from this repo; the session was also
    // tagged. Next pass must retract the server row AND drop the tag.
    store.set(sessionOrgTagsAtom, {
      "session-1": [cloudOrgToken("corg-1")],
    });
    store.set(org2CloudRepoScopesAtom, { "corg-1": ["github.com/other/repo"] });
    await engine.runSyncPass();
    expect(client.deleteSession).toHaveBeenCalledWith(
      "jwt-1",
      "corg-1",
      "session-1"
    );
    expect(store.get(sessionOrgTagsAtom)).toEqual({});
  });

  it("never pushes a tagged IMPORTED teammate copy (echo-loop guard)", async () => {
    // Only imported-from-cloud copies are echo-guarded now; the user's OWN
    // external history is shareable (covered separately below).
    store.set(org2CloudRepoScopesAtom, {});
    store.set(sessionsAtom, [
      { ...SESSION, session_id: "session-imp", importedFrom: {} as never },
    ]);
    store.set(sessionOrgTagsAtom, {
      "session-imp": [cloudOrgToken("corg-1")],
    });
    await engine.runSyncPass();
    expect(client.upsertSessionMetadata).not.toHaveBeenCalled();
  });

  it("hydrates repo scopes from the server before picking targets", async () => {
    // Second-device scenario: nothing set locally, server knows the scopes.
    store.set(org2CloudRepoScopesAtom, {});
    client.getOrgRepoScopes.mockResolvedValue({
      repoScopes: [SCOPE_KEY],
      used: 1,
      cap: 3,
      cooldownDays: 7,
      coolingDown: [],
    });
    await engine.runSyncPass();
    expect(store.get(org2CloudRepoScopesAtom)).toEqual({
      "corg-1": [SCOPE_KEY],
    });
    expect(client.upsertSessionMetadata).toHaveBeenCalledTimes(1);
  });

  it("keeps last-known scopes and still pushes when hydration fails", async () => {
    client.getOrgRepoScopes.mockRejectedValue(new Error("network down"));
    await engine.runSyncPass();
    expect(store.get(org2CloudRepoScopesAtom)).toEqual({
      "corg-1": [SCOPE_KEY],
    });
    expect(client.upsertSessionMetadata).toHaveBeenCalledTimes(1);
  });

  it("TTL-gates hydration to one fetch across back-to-back passes", async () => {
    await engine.runSyncPass();
    await engine.runSyncPass();
    expect(client.getOrgRepoScopes).toHaveBeenCalledTimes(1);
  });

  // --- Access ladder (§13.4) ------------------------------------------------

  it("BEHAVIOR CHANGE: a scope-matched session is NOT uploaded under the default-off ladder", async () => {
    // No access settings at all ⇒ org default OFF (privacy-first §13.4):
    // repo-scope match makes the session a candidate, nothing more.
    store.set(org2CloudAccessSettingsAtom, {});
    await engine.runSyncPass();
    expect(client.upsertSessionMetadata).not.toHaveBeenCalled();
    expect(client.rewriteSessionEvents).not.toHaveBeenCalled();
    expect(client.appendSessionEvents).not.toHaveBeenCalled();
  });

  it("floors a tagged effective-off session to metadata_only (never 'off' on the wire, no segments)", async () => {
    store.set(org2CloudAccessSettingsAtom, {}); // default OFF
    // Scope stays matched (tags only work WITHIN scope); the tag is what
    // overrides the effective-off ladder default.
    store.set(sessionOrgTagsAtom, { "session-1": [cloudOrgToken("corg-1")] });
    await engine.runSyncPass();

    expect(client.upsertSessionMetadata).toHaveBeenCalledTimes(1);
    const metadata = client.upsertSessionMetadata.mock.calls[0][3];
    expect(metadata.accessMode).toBe("metadata_only");
    expect(metadata.replayLevel).toBe("metadata");
    // Metadata-only rung ships NO event segments.
    expect(client.rewriteSessionEvents).not.toHaveBeenCalled();
    expect(client.appendSessionEvents).not.toHaveBeenCalled();
  });

  it("honors a per-session override over the org default (ratchet) incl. restricted visibility", async () => {
    // Org default full_replay, but THIS session is persisted as
    // metadata_only + restricted — the override must win on every push.
    store.set(org2CloudAccessSettingsAtom, {
      "corg-1": {
        defaultMode: "full_replay",
        sessionModes: { "session-1": "metadata_only" },
        sessionVisibility: { "session-1": "restricted" },
      },
    });
    await engine.runSyncPass();

    expect(client.upsertSessionMetadata).toHaveBeenCalledTimes(1);
    const metadata = client.upsertSessionMetadata.mock.calls[0][3];
    expect(metadata.accessMode).toBe("metadata_only");
    expect(metadata.visibility).toBe("restricted");
    expect(client.rewriteSessionEvents).not.toHaveBeenCalled();
  });

  it("skips a session whose per-session override is off even when the default is full_replay", async () => {
    store.set(org2CloudAccessSettingsAtom, {
      "corg-1": {
        defaultMode: "full_replay",
        sessionModes: { "session-1": "off" },
        sessionVisibility: {},
      },
    });
    await engine.runSyncPass();
    expect(client.upsertSessionMetadata).not.toHaveBeenCalled();
    expect(client.rewriteSessionEvents).not.toHaveBeenCalled();
  });

  it("publishes full_replay metadata with the ladder outcome (org visibility)", async () => {
    await engine.runSyncPass();
    const metadata = client.upsertSessionMetadata.mock.calls[0][3];
    expect(metadata.accessMode).toBe("full_replay");
    expect(metadata.visibility).toBe("org");
    expect(metadata.replayLevel).toBe("replay");
  });

  it("publishes a full_replay metadata row even when the transcript is empty", async () => {
    eventStoreMock.getPersistedEvents.mockResolvedValue([]);

    await engine.runSyncPass();

    expect(client.upsertSessionMetadata).toHaveBeenCalledTimes(1);
    expect(client.upsertSessionMetadata.mock.calls[0][3].accessMode).toBe(
      "full_replay"
    );
    expect(client.rewriteSessionEvents).not.toHaveBeenCalled();
    expect(client.appendSessionEvents).not.toHaveBeenCalled();
    expect(store.get(org2CloudPushedMetadataAtom)).toEqual({
      "corg-1:session-1": true,
    });
  });

  // --- deleteSession resurrection-hash fix ----------------------------------

  it("re-upserts unchanged metadata after invalidatePushedMetadataHash (untag/delete path)", async () => {
    await engine.runSyncPass();
    expect(client.upsertSessionMetadata).toHaveBeenCalledTimes(1);

    // Unchanged pass: hash-gated, no re-upsert.
    await engine.runSyncPass();
    expect(client.upsertSessionMetadata).toHaveBeenCalledTimes(1);

    // deleteSession (untag) tombstoned the row server-side; the invalidation
    // must force the next pass to re-upsert (clearing deleted_at) even
    // though the metadata bytes are identical.
    engine.invalidatePushedMetadataHash("corg-1", "session-1");
    await engine.runSyncPass();
    expect(client.upsertSessionMetadata).toHaveBeenCalledTimes(2);
  });

  it("does not resurrect a tag-only session untagged mid-pass (live tag re-read)", async () => {
    // session-out is tag-only (its repo is NOT a saved scope); session-1
    // stays scope-matched and is pushed FIRST. Pausing session-1's metadata
    // upsert lets us drop session-out's tag WHILE the pass is in flight —
    // exactly the MoveToOrgDialog untag race. The engine must re-read the
    // live tags atom and skip session-out, rather than re-upsert (which
    // would clear the server deleted_at the untag's deleteSession just set)
    // and resurrect a row no later pass ever deletes again.
    store.set(sessionsAtom, [
      SESSION,
      { ...SESSION, session_id: "session-out", repoPath: "/repo/other" },
    ]);
    store.set(sessionOrgTagsAtom, {
      "session-out": [cloudOrgToken("corg-1")],
    });

    let releaseFirstUpsert!: () => void;
    const firstUpsertPaused = new Promise<void>((resolve) => {
      releaseFirstUpsert = resolve;
    });
    let upsertCall = 0;
    const firstUpsertCalled = new Promise<void>((markCalled) => {
      client.upsertSessionMetadata.mockImplementation(async () => {
        upsertCall += 1;
        if (upsertCall === 1) {
          markCalled();
          await firstUpsertPaused;
        }
        return undefined;
      });
    });

    const pass = engine.runSyncPass();
    await firstUpsertCalled;
    // The user unchecks the org in MoveToOrgDialog: the server row is
    // tombstoned (not modeled here) and the local tag is dropped mid-pass.
    store.set(sessionOrgTagsAtom, {});
    releaseFirstUpsert();
    await pass;

    // session-1 upserted once; session-out never — its tag was gone by the
    // time the loop's live re-read reached it.
    const upsertedSessionIds = client.upsertSessionMetadata.mock.calls.map(
      ([, , sessionId]) => sessionId
    );
    expect(upsertedSessionIds).toEqual(["session-1"]);
  });

  // --- Off-retraction of a previously-published session (§13.4) -------------

  it("retracts a previously full_replay session when it drops to untagged effective-off", async () => {
    // Full_replay push first: metadata + segments land, cursor persisted.
    await engine.runSyncPass();
    expect(client.rewriteSessionEvents).toHaveBeenCalledTimes(1);
    expect(
      store.get(org2CloudPushCursorsAtom)["corg-1:session-1"]
    ).toBeDefined();

    // User picks 'Off' (per-session override). The next pass must RETRACT,
    // not silently skip: soft-tombstone the server row + drop the persisted
    // cursor so teammates lose both the listing and replay.
    store.set(org2CloudAccessSettingsAtom, {
      "corg-1": {
        defaultMode: "full_replay",
        sessionModes: { "session-1": "off" },
        sessionVisibility: {},
      },
    });
    await engine.runSyncPass();

    expect(client.deleteSession).toHaveBeenCalledTimes(1);
    expect(client.deleteSession).toHaveBeenCalledWith(
      "jwt-1",
      "corg-1",
      "session-1"
    );
    expect(
      store.get(org2CloudPushCursorsAtom)["corg-1:session-1"]
    ).toBeUndefined();

    // One-shot: a later pass neither re-deletes nor re-pushes.
    client.deleteSession.mockClear();
    await engine.runSyncPass();
    expect(client.deleteSession).not.toHaveBeenCalled();
    expect(client.upsertSessionMetadata).toHaveBeenCalledTimes(1);
  });

  it("does NOT delete a never-pushed session that is set to off", async () => {
    // Default-off ladder, session never published: an 'off' selection is a
    // pure skip — no spurious server delete.
    store.set(org2CloudAccessSettingsAtom, {});
    await engine.runSyncPass();
    expect(client.upsertSessionMetadata).not.toHaveBeenCalled();
    expect(client.deleteSession).not.toHaveBeenCalled();
  });

  it("retracts a metadata_only session dropped to Off in a LATER run (persisted marker)", async () => {
    // Run 1: metadata_only push leaves NO segments cursor — only the
    // persisted push marker records that a live row exists.
    store.set(org2CloudAccessSettingsAtom, {
      "corg-1": {
        defaultMode: "metadata_only",
        sessionModes: {},
        sessionVisibility: {},
      },
    });
    await engine.runSyncPass();
    expect(client.upsertSessionMetadata).toHaveBeenCalledTimes(1);
    expect(client.rewriteSessionEvents).not.toHaveBeenCalled();
    expect(
      store.get(org2CloudPushCursorsAtom)["corg-1:session-1"]
    ).toBeUndefined();
    expect(store.get(org2CloudPushedMetadataAtom)["corg-1:session-1"]).toBe(
      true
    );

    // Simulate an app restart: a fresh engine has an EMPTY in-memory
    // wasCloudPushed cache. Only the persisted marker survives.
    engine.stop();
    engine = new Org2CloudSyncEngine(
      client,
      projectsClient,
      tasksClient,
      bridge
    );
    engine.start(store);

    // Downgrade to Off (default off, no tag). The retract must fire off the
    // persisted marker even though nothing was pushed in THIS run.
    store.set(org2CloudAccessSettingsAtom, {});
    await engine.runSyncPass();

    expect(client.deleteSession).toHaveBeenCalledTimes(1);
    expect(client.deleteSession).toHaveBeenCalledWith(
      "jwt-1",
      "corg-1",
      "session-1"
    );
    expect(
      store.get(org2CloudPushedMetadataAtom)["corg-1:session-1"]
    ).toBeUndefined();

    // One-shot: the marker cleared, a later pass neither re-deletes nor
    // re-pushes.
    client.deleteSession.mockClear();
    await engine.runSyncPass();
    expect(client.deleteSession).not.toHaveBeenCalled();
  });

  it("retract swallows ORG2_SESSION_NOT_FOUND and still clears the marker (idempotent)", async () => {
    // Persisted marker present (prior-run metadata_only push) but the server
    // row is already gone — deleteSession throws ORG2_SESSION_NOT_FOUND. The
    // retract must treat it as done: clear the marker, don't loop the delete.
    store.set(org2CloudPushedMetadataAtom, { "corg-1:session-1": true });
    store.set(org2CloudAccessSettingsAtom, {});
    client.deleteSession.mockRejectedValueOnce(
      new Org2CloudSyncError("ORG2_SESSION_NOT_FOUND", 404)
    );

    await engine.runSyncPass();

    expect(client.deleteSession).toHaveBeenCalledTimes(1);
    expect(
      store.get(org2CloudPushedMetadataAtom)["corg-1:session-1"]
    ).toBeUndefined();

    client.deleteSession.mockClear();
    await engine.runSyncPass();
    expect(client.deleteSession).not.toHaveBeenCalled();
  });

  // --- Projects / work items channel (cloud-parity Phase B) -----------------

  it("drives the ProjectSyncChannel per org: full listing first, cursor delta after", async () => {
    projectsClient.listOrgCollabState.mockResolvedValue({
      serverTime: "2026-07-01T12:00:00.000Z",
      projects: [
        { id: "p-1", name: "P", version: 2, updatedByMemberId: "u-2" },
      ],
      workItems: [],
    });
    await engine.runSyncPass();

    // First pass bypasses the cursor (complete listing).
    expect(projectsClient.listOrgCollabState).toHaveBeenCalledWith(
      "jwt-1",
      "corg-1",
      undefined
    );
    // Pulled rows ride the shared channel into the Rust apply path, keyed
    // by the ALIASED local project org.
    expect(bridge.applyRemote).toHaveBeenCalledWith({
      orgId: "porg-corg-1",
      orgName: "Cloud Team",
      entities: [
        expect.objectContaining({
          kind: "project",
          version: 2,
          updatedBy: "u-2",
        }),
      ],
    });
    // The outbox drains under the same alias.
    expect(bridge.drainOutbox).toHaveBeenCalledWith({
      orgId: "porg-corg-1",
      max: 50,
    });

    // Cursor persisted = serverTime minus the 2s safety overlap …
    expect(store.get(org2CloudCollabStateCursorsAtom)).toEqual({
      "corg-1": "2026-07-01T11:59:58.000Z",
    });
    // … and the SECOND pass pulls the delta behind it.
    // Inbound planes run at most once per INBOUND_FALLBACK_INTERVAL_MS per
    // pass cycle (realtime is the primary trigger); hop the clock past the
    // window so this pass includes the inbound pull.
    vi.setSystemTime(Date.now() + 5 * 60_000 + 1);
    await engine.runSyncPass();
    expect(projectsClient.listOrgCollabState).toHaveBeenLastCalledWith(
      "jwt-1",
      "corg-1",
      "2026-07-01T11:59:58.000Z"
    );
  });

  it("syncs the project plane even for an org with no scopes or tagged sessions", async () => {
    store.set(org2CloudRepoScopesAtom, {});
    await engine.runSyncPass();
    // No session push targets …
    expect(client.upsertSessionMetadata).not.toHaveBeenCalled();
    // … but work items are org-wide, so the channel still runs.
    expect(projectsClient.listOrgCollabState).toHaveBeenCalledTimes(1);
    expect(bridge.drainOutbox).toHaveBeenCalledTimes(1);
  });

  it("ensures the project-org alias for EVERY member org, even ones the sync planes skip", async () => {
    const aliasMock = vi.mocked(ensureProjectOrgForCloudOrg);
    store.set(org2CloudOrgsAtom, [
      { orgId: "corg-1", name: "Cloud Team", role: "member" },
      { orgId: "corg-2", name: "Joined Team", role: "member" },
    ]);
    store.set(org2CloudSyncEnabledAtom, { "corg-2": false });
    client.rewriteSessionEvents.mockRejectedValue(
      new Org2CloudSyncError("ORG2_QUOTA_EXCEEDED", 403)
    );

    await engine.runSyncPass();

    expect(aliasMock.mock.calls.map(([org]) => org.orgId).sort()).toEqual([
      "corg-1",
      "corg-2",
    ]);

    aliasMock.mockClear();
    await engine.runSyncPass();
    expect(aliasMock).not.toHaveBeenCalled();
  });

  it("ensures aliases even when a custom endpoint fails the schema gate", async () => {
    const aliasMock = vi.mocked(ensureProjectOrgForCloudOrg);
    startWithCustomEndpoint(async () => 999999);
    aliasMock.mockClear();
    projectsClient.listOrgCollabState.mockClear();

    await engine.runSyncPass();

    expect(aliasMock).toHaveBeenCalledTimes(1);
    expect(aliasMock.mock.calls[0][0].orgId).toBe("corg-1");
    expect(projectsClient.listOrgCollabState).not.toHaveBeenCalled();
  });

  it("pushes drained outbox rows through the cloud upsert RPCs and acks the version", async () => {
    bridge.drainOutbox
      .mockResolvedValueOnce([
        {
          entryIds: [1],
          orgId: "porg-corg-1",
          kind: "work_item",
          entityId: "AAA-0001",
          op: "upsert",
          payload: { id: "AAA-0001", title: "T" },
          baseVersion: 3,
          fieldPaths: ["title"],
        },
      ])
      .mockResolvedValue([]);
    projectsClient.upsertWorkItem.mockResolvedValue({
      id: "AAA-0001",
      version: 4,
    });

    await engine.runSyncPass();

    // The adapter authenticates with the pass JWT; the channel's profile
    // fields never reach the RPC layer.
    expect(projectsClient.upsertWorkItem).toHaveBeenCalledWith("jwt-1", {
      orgId: "corg-1",
      workItem: { id: "AAA-0001", title: "T" },
      baseVersion: 3,
    });
    expect(bridge.ackOutbox).toHaveBeenCalledWith([
      expect.objectContaining({
        entityId: "AAA-0001",
        ok: true,
        remoteVersion: 4,
      }),
    ]);
  });

  it("backs off + toasts when ORG2_SYNC_DISABLED surfaces through the channel's PUSH path", async () => {
    // The listing RPC the engine awaits directly is UNGATED (0013: only
    // assert_org_member), so the entitlement gate can only fire inside the
    // channel's per-row pushes — which ack failures instead of throwing.
    // No session-push targets either: without the cycle-result inspection
    // the session loop's backoff never fires and the org would silently
    // re-drain its outbox every pass.
    store.set(org2CloudRepoScopesAtom, {});
    bridge.drainOutbox
      .mockResolvedValueOnce([
        {
          entryIds: [1],
          orgId: "porg-corg-1",
          kind: "work_item",
          entityId: "AAA-0001",
          op: "upsert",
          payload: { id: "AAA-0001", title: "T" },
          baseVersion: null,
          fieldPaths: ["title"],
        },
      ])
      .mockResolvedValue([]);
    projectsClient.upsertWorkItem.mockRejectedValue(
      new Org2CloudProjectsError("ORG2_SYNC_DISABLED", 403)
    );

    await engine.runSyncPass();

    // Same backoff+toast route as the session plane.
    expect(messageMock.warning).toHaveBeenCalledTimes(1);
    expect(messageMock.warning).toHaveBeenCalledWith(
      "navigation:cloud.sync.syncDisabledToast"
    );
    // The failed entry was still acked (Rust-side per-entry backoff owns
    // it) and the cursor did NOT advance.
    expect(bridge.ackOutbox).toHaveBeenCalledWith([
      expect.objectContaining({ entityId: "AAA-0001", ok: false }),
    ]);
    expect(store.get(org2CloudCollabStateCursorsAtom)).toEqual({});

    // Backed off: the next pass never touches the org's project plane, and
    // the toast fires exactly once during this cooldown window.
    projectsClient.listOrgCollabState.mockClear();
    bridge.drainOutbox.mockClear();
    await engine.runSyncPass();
    expect(projectsClient.listOrgCollabState).not.toHaveBeenCalled();
    expect(bridge.drainOutbox).not.toHaveBeenCalled();
    expect(messageMock.warning).toHaveBeenCalledTimes(1);

    // A quiet backend cannot strand the org forever: the bounded cooldown
    // expires even when no Realtime entitlement signal arrives.
    vi.setSystemTime(Date.now() + ORG_BACKOFF_COOLDOWN_MS);
    await engine.runSyncPass();
    expect(projectsClient.listOrgCollabState).toHaveBeenCalledTimes(1);
    expect(bridge.drainOutbox).toHaveBeenCalledTimes(1);
  });

  it("clears entitlement backoff immediately on a Realtime invalidation", async () => {
    store.set(org2CloudRepoScopesAtom, {});
    bridge.drainOutbox
      .mockResolvedValueOnce([
        {
          entryIds: [1],
          orgId: "porg-corg-1",
          kind: "work_item",
          entityId: "AAA-0001",
          op: "upsert",
          payload: { id: "AAA-0001", title: "T" },
          baseVersion: null,
          fieldPaths: ["title"],
        },
      ])
      .mockResolvedValue([]);
    projectsClient.upsertWorkItem.mockRejectedValueOnce(
      new Org2CloudProjectsError("ORG2_SYNC_DISABLED", 403)
    );
    await engine.runSyncPass();

    projectsClient.listOrgCollabState.mockClear();
    bridge.drainOutbox.mockClear();
    engine.invalidateOrgInbound("corg-1");
    await engine.runSyncPassAndWaitForDrain();

    expect(projectsClient.listOrgCollabState).toHaveBeenCalled();
    expect(bridge.drainOutbox).toHaveBeenCalled();
  });

  it("holds the collab-state cursor when the channel cycle fails", async () => {
    bridge.drainOutbox.mockRejectedValue(new Error("bridge down"));
    await engine.runSyncPass();
    // No cursor advance: the next pass must retry the same window.
    expect(store.get(org2CloudCollabStateCursorsAtom)).toEqual({});
    // The failure stays contained (no backoff toast for plain errors).
    expect(messageMock.warning).not.toHaveBeenCalled();
  });

  it("drains the projects plane promptly on orgii-data-changed, without the 5-min fallback", async () => {
    await engine.runSyncPass(); // consumes the start-up inbound pull
    projectsClient.listOrgCollabState.mockClear();
    bridge.drainOutbox.mockClear();
    tasksClient.listCommentTasks.mockClear();

    // Gate holds on an ordinary pass: no event, no inbound window elapsed.
    await engine.runSyncPass();
    expect(bridge.drainOutbox).not.toHaveBeenCalled();

    // A local mutation emits orgii-data-changed → debounced pass drains the
    // outbox now instead of waiting INBOUND_FALLBACK_INTERVAL_MS.
    emitDataChanged();
    expect(bridge.drainOutbox).not.toHaveBeenCalled(); // debounce coalesces
    await vi.advanceTimersByTimeAsync(DATA_CHANGED_DEBOUNCE_MS);
    expect(bridge.drainOutbox).toHaveBeenCalledTimes(1);
    expect(projectsClient.listOrgCollabState).toHaveBeenCalledTimes(1);
    // Narrow flag: the comment-task plane stays on the inbound fallback.
    expect(tasksClient.listCommentTasks).not.toHaveBeenCalled();
  });

  it("retries a failed durable project push after Rust's first backoff even while hidden", async () => {
    bridge.drainOutbox
      .mockResolvedValueOnce([
        {
          entryIds: [1],
          orgId: "porg-corg-1",
          kind: "work_item",
          entityId: "AAA-0001",
          op: "upsert",
          payload: { id: "AAA-0001", title: "Offline edit" },
          baseVersion: 3,
          fieldPaths: ["title"],
        },
      ])
      .mockResolvedValue([]);
    projectsClient.upsertWorkItem.mockRejectedValueOnce(
      new TypeError("fetch failed")
    );

    await engine.runSyncPass();
    expect(bridge.ackOutbox).toHaveBeenCalledWith([
      expect.objectContaining({ entityId: "AAA-0001", ok: false }),
    ]);

    // Drain start()'s independent 0 ms bootstrap timer before advancing to
    // the retry deadline. Otherwise it can begin a coalesced pass during the
    // large fake-time jump and make the exact-boundary assertion order-
    // dependent when this spec runs with the rest of the file.
    await vi.advanceTimersByTimeAsync(0);

    projectsClient.listOrgCollabState.mockClear();
    bridge.drainOutbox.mockClear();
    documentStub.visibilityState = "hidden";
    await vi.advanceTimersByTimeAsync(PROJECT_PUSH_RETRY_DELAY_MS - 1);
    await engine.runSyncPassAndWaitForDrain();
    expect(projectsClient.listOrgCollabState).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    // Timer callbacks intentionally fire-and-forget in production. Explicitly
    // drain the serialized pass before asserting so worker scheduling cannot
    // make this spec depend on how busy the rest of the Vitest run is.
    await engine.runSyncPassAndWaitForDrain();
    expect(projectsClient.listOrgCollabState).toHaveBeenCalledTimes(1);
    expect(bridge.drainOutbox).toHaveBeenCalledTimes(1);
    documentStub.visibilityState = "visible";
  });

  it("bounds the remote-apply echo emission to one extra cheap pass", async () => {
    // Production wiring: applyPulledState → notifyDataChanged emits the SAME
    // orgii-data-changed event the engine subscribes to.
    bridge.notifyDataChanged.mockImplementation(async () => {
      emitDataChanged();
      return undefined;
    });
    bridge.applyRemote.mockResolvedValue(1);
    projectsClient.listOrgCollabState
      .mockResolvedValueOnce({
        serverTime: "2026-07-01T12:00:00.000Z",
        projects: [
          { id: "p-1", name: "P", version: 2, updatedByMemberId: "u-2" },
        ],
        workItems: [],
      })
      .mockResolvedValue({
        serverTime: "2026-07-01T12:00:30.000Z",
        projects: [],
        workItems: [],
      });

    await engine.runSyncPass();
    expect(bridge.notifyDataChanged).toHaveBeenCalledTimes(1);
    expect(bridge.drainOutbox).toHaveBeenCalledTimes(1);

    // The echo triggers exactly ONE follow-up projects pass; its empty delta
    // + empty outbox apply nothing, so no further emission and no chain.
    await vi.advanceTimersByTimeAsync(DATA_CHANGED_DEBOUNCE_MS);
    await engine.runSyncPassAndWaitForDrain();
    expect(bridge.drainOutbox).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10 * DATA_CHANGED_DEBOUNCE_MS);
    await engine.runSyncPassAndWaitForDrain();
    expect(bridge.drainOutbox).toHaveBeenCalledTimes(2);
    expect(bridge.notifyDataChanged).toHaveBeenCalledTimes(1);
  });

  it("removes the orgii-data-changed listener on stop (leak-free)", async () => {
    expect(tauriEventListeners.get("orgii-data-changed")?.size).toBe(1);
    engine.stop();
    await Promise.resolve();
    expect(tauriEventListeners.get("orgii-data-changed")?.size).toBe(0);
    engine.start(store);
  });

  // --- Custom-endpoint schema gate (cloud-parity Phase C) -------------------

  it("disables sync + toasts once on a custom-endpoint schema mismatch", async () => {
    const probe = vi.fn(async () => ORG2_CLOUD_EXPECTED_SCHEMA_VERSION - 1);
    startWithCustomEndpoint(probe);

    await engine.runSyncPass();
    expect(probe).toHaveBeenCalledTimes(1);
    // Neither plane runs: no session push, no project listing.
    expect(client.upsertSessionMetadata).not.toHaveBeenCalled();
    expect(projectsClient.listOrgCollabState).not.toHaveBeenCalled();
    expect(messageMock.warning).toHaveBeenCalledTimes(1);
    expect(messageMock.warning).toHaveBeenCalledWith(
      "navigation:cloud.sync.schemaMismatchToast"
    );

    // Pinned until the next start(): no re-probe, no second toast.
    await engine.runSyncPass();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(messageMock.warning).toHaveBeenCalledTimes(1);
  });

  it("syncs a matching custom endpoint, probing exactly once per start", async () => {
    const probe = vi.fn(async () => ORG2_CLOUD_EXPECTED_SCHEMA_VERSION);
    startWithCustomEndpoint(probe);

    await engine.runSyncPass();
    expect(client.upsertSessionMetadata).toHaveBeenCalled();
    await engine.runSyncPass();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(messageMock.warning).not.toHaveBeenCalled();
  });

  it("skips the pass and re-probes next pass when the probe fails (null)", async () => {
    const probe = vi.fn(async () => null);
    startWithCustomEndpoint(probe);

    await engine.runSyncPass();
    expect(client.upsertSessionMetadata).not.toHaveBeenCalled();
    // Unknown ≠ mismatch: no disable-toast for an unreachable backend.
    expect(messageMock.warning).not.toHaveBeenCalled();
    await engine.runSyncPass();
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("never probes the official endpoint (gate is custom-only)", async () => {
    const probe = vi.fn(async () => 0);
    engine.stop();
    engine = new Org2CloudSyncEngine(
      client,
      projectsClient,
      tasksClient,
      bridge,
      probe
    );
    engine.start(store);

    await engine.runSyncPass();
    expect(probe).not.toHaveBeenCalled();
    expect(client.upsertSessionMetadata).toHaveBeenCalled();
  });

  // --- Endpoint-identity guard (security: cross-backend token/payload leak) -

  it("bails the pass when the active endpoint is not the token's backend", async () => {
    // Custom override active and its schema gate PASSING, but the signed-in
    // auth still carries the OFFICIAL backend's URL — an endpoint switch
    // mid-lifetime. The guard must drop the whole pass rather than send the
    // official backend's JWT + session payloads to the custom endpoint.
    const probe = vi.fn(async () => ORG2_CLOUD_EXPECTED_SCHEMA_VERSION);
    startWithCustomEndpoint(probe);
    store.set(org2CloudAuthAtom, AUTH); // token minted against the official URL

    await engine.runSyncPass();

    // We got PAST the schema gate (the probe ran) …
    expect(probe).toHaveBeenCalledTimes(1);
    // … yet neither plane issued a single RPC.
    expect(client.getOrgRepoScopes).not.toHaveBeenCalled();
    expect(client.upsertSessionMetadata).not.toHaveBeenCalled();
    expect(client.rewriteSessionEvents).not.toHaveBeenCalled();
    expect(client.appendSessionEvents).not.toHaveBeenCalled();
    expect(projectsClient.listOrgCollabState).not.toHaveBeenCalled();
    expect(bridge.drainOutbox).not.toHaveBeenCalled();
    expect(tasksClient.listCommentTasks).not.toHaveBeenCalled();
  });

  // --- Comment agent tasks (agent-pickup design §4, Phase 5) ----------------

  it("pulls comment tasks full-then-delta behind the persisted overlap cursor", async () => {
    const task = makeTask("task-1");
    tasksClient.listCommentTasks.mockResolvedValue({
      serverTime: "2026-07-01T12:00:00.000Z",
      tasks: [task],
    });
    await engine.runSyncPass();

    // First pass bypasses the cursor (complete listing, cursor=null) …
    expect(tasksClient.listCommentTasks).toHaveBeenCalledWith(
      "jwt-1",
      "corg-1",
      null
    );
    expect(store.get(org2CloudCommentTasksAtom)).toEqual({
      "corg-1": { "task-1": task },
    });
    // … and persists serverTime minus the 2s safety overlap …
    expect(store.get(org2CloudCommentTaskCursorsAtom)).toEqual({
      "corg-1": "2026-07-01T11:59:58.000Z",
    });

    // … so the SECOND pass pulls the delta behind it.
    const afterFull = store.get(org2CloudCommentTasksAtom);
    tasksClient.listCommentTasks.mockResolvedValue({
      serverTime: "2026-07-01T12:01:00.000Z",
      tasks: [],
    });
    // Inbound planes run at most once per INBOUND_FALLBACK_INTERVAL_MS per
    // pass cycle (realtime is the primary trigger); hop the clock past the
    // window so this pass includes the inbound pull.
    vi.setSystemTime(Date.now() + 5 * 60_000 + 1);
    await engine.runSyncPass();
    expect(tasksClient.listCommentTasks).toHaveBeenLastCalledWith(
      "jwt-1",
      "corg-1",
      "2026-07-01T11:59:58.000Z"
    );
    // An empty delta never churns the atom (identity-stable merge) even
    // though the cursor still advances.
    expect(store.get(org2CloudCommentTasksAtom)).toBe(afterFull);
    expect(store.get(org2CloudCommentTaskCursorsAtom)).toEqual({
      "corg-1": "2026-07-01T12:00:58.000Z",
    });
  });

  it("LWW-merges deltas: an overlap re-delivery never clobbers a fresher write-through", async () => {
    const initial = makeTask("task-1", {
      updatedAt: "2026-07-01T10:00:00.000Z",
    });
    tasksClient.listCommentTasks.mockResolvedValueOnce({
      serverTime: "2026-07-01T12:00:00.000Z",
      tasks: [initial],
    });
    await engine.runSyncPass(); // full listing seeds the map

    // A claim response write-through between passes holds a NEWER copy …
    const claimed = makeTask("task-1", {
      state: "claimed",
      claimedByUserId: "user-2",
      updatedAt: "2026-07-01T12:00:05.000Z",
    });
    store.set(org2CloudCommentTasksAtom, {
      "corg-1": { "task-1": claimed },
    });
    // … while the 2s overlap re-delivers the OLDER open row next to a new
    // task the delta genuinely carries.
    const fresh = makeTask("task-2", { updatedAt: "2026-07-01T12:00:03.000Z" });
    tasksClient.listCommentTasks.mockResolvedValueOnce({
      serverTime: "2026-07-01T12:01:00.000Z",
      tasks: [initial, fresh],
    });
    // Inbound planes run at most once per INBOUND_FALLBACK_INTERVAL_MS per
    // pass cycle (realtime is the primary trigger); hop the clock past the
    // window so this pass includes the inbound pull.
    vi.setSystemTime(Date.now() + 5 * 60_000 + 1);
    await engine.runSyncPass();

    expect(store.get(org2CloudCommentTasksAtom)).toEqual({
      "corg-1": { "task-1": claimed, "task-2": fresh },
    });
  });

  it("isolates a failing org's task pull: others merge, no backoff for member errors", async () => {
    store.set(org2CloudOrgsAtom, [
      { orgId: "corg-1", name: "Cloud Team", role: "member" },
      { orgId: "corg-2", name: "Other Team", role: "member" },
    ]);
    const task = makeTask("task-2");
    tasksClient.listCommentTasks.mockImplementation(
      async (_token: string, orgId: string, _since: string | null) => {
        if (orgId === "corg-1") {
          throw new Org2CloudTaskError("ORG2_MEMBER_REQUIRED", 403);
        }
        return { serverTime: "2026-07-01T12:00:00.000Z", tasks: [task] };
      }
    );
    await engine.runSyncPass();

    // corg-2 merged + cursor-advanced; corg-1 neither.
    expect(store.get(org2CloudCommentTasksAtom)).toEqual({
      "corg-2": { "task-2": task },
    });
    expect(store.get(org2CloudCommentTaskCursorsAtom)).toEqual({
      "corg-2": "2026-07-01T11:59:58.000Z",
    });
    // A membership/org error is NOT an org-level backoff (0002 rule: the
    // listing can never raise quota/disabled): no toast, and the next pass
    // retries corg-1 — still as a FULL listing (the latch only sets on
    // success).
    expect(messageMock.warning).not.toHaveBeenCalled();
    // Inbound planes run at most once per INBOUND_FALLBACK_INTERVAL_MS per
    // pass cycle (realtime is the primary trigger); hop the clock past the
    // window so this pass includes the inbound pull.
    vi.setSystemTime(Date.now() + 5 * 60_000 + 1);
    await engine.runSyncPass();
    const corg1Calls = tasksClient.listCommentTasks.mock.calls.filter(
      ([, orgId]) => orgId === "corg-1"
    );
    expect(corg1Calls).toHaveLength(2);
    expect(corg1Calls[1][2]).toBeNull();
  });

  it("skips the task pull for an org backed off by the session plane", async () => {
    client.rewriteSessionEvents.mockRejectedValue(
      new Org2CloudSyncError("ORG2_QUOTA_EXCEEDED", 403)
    );
    await engine.runSyncPass();
    expect(tasksClient.listCommentTasks).not.toHaveBeenCalled();
  });

  it("aborts the task merge when stop() lands mid-listing (generation check)", async () => {
    let resolveList!: (value: ListCommentTasksResult) => void;
    const listCalled = new Promise<void>((markCalled) => {
      tasksClient.listCommentTasks.mockImplementation(() => {
        markCalled();
        return new Promise<ListCommentTasksResult>((resolve) => {
          resolveList = resolve;
        });
      });
    });

    const pass = engine.runSyncPass();
    await listCalled;
    engine.stop();
    resolveList({
      serverTime: "2026-07-01T12:00:00.000Z",
      tasks: [makeTask("task-1")],
    });
    await pass;

    // Neither the map nor the cursor was written after the generation bump.
    expect(store.get(org2CloudCommentTasksAtom)).toEqual({});
    expect(store.get(org2CloudCommentTaskCursorsAtom)).toEqual({});
  });

  // --- Visibility-aware cadence (user CPU constraint: ONE timer chain) ------

  describe("visibility-aware cadence", () => {
    afterEach(() => {
      documentStub.visibilityState = "visible";
    });

    it("stretches the chain to HIDDEN_PASS_INTERVAL_MS while hidden", async () => {
      documentStub.visibilityState = "hidden";
      const passSpy = vi.spyOn(engine, "runSyncPass");
      await vi.advanceTimersByTimeAsync(0); // start()'s initial 0ms pass
      expect(passSpy).toHaveBeenCalledTimes(1);
      // Settle the pass so its .finally reschedules before we advance.
      await passSpy.mock.results[0].value;

      // The 60s cadence is suspended …
      await vi.advanceTimersByTimeAsync(PASS_INTERVAL_MS);
      expect(passSpy).toHaveBeenCalledTimes(1);
      // … and the SAME chain fires at the 5-minute hidden cadence instead.
      await vi.advanceTimersByTimeAsync(
        HIDDEN_PASS_INTERVAL_MS - PASS_INTERVAL_MS
      );
      expect(passSpy).toHaveBeenCalledTimes(2);
    });

    it("snaps back with an immediate pass when the document becomes visible", async () => {
      documentStub.visibilityState = "hidden";
      const passSpy = vi.spyOn(engine, "runSyncPass");
      await vi.advanceTimersByTimeAsync(0);
      await passSpy.mock.results[0].value;
      expect(passSpy).toHaveBeenCalledTimes(1); // chain parked 5 minutes out

      documentStub.visibilityState = "visible";
      documentStub.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0); // the immediate setTimeout(0) pass
      expect(passSpy).toHaveBeenCalledTimes(2);
      await passSpy.mock.results[1].value;

      // The chain is back on the 60s cadence, not still parked at 5 minutes.
      await vi.advanceTimersByTimeAsync(PASS_INTERVAL_MS);
      expect(passSpy).toHaveBeenCalledTimes(3);
    });

    it("never lets event-store activity trigger passes while hidden (background agent case)", async () => {
      documentStub.visibilityState = "hidden";
      const passSpy = vi.spyOn(engine, "runSyncPass");
      await vi.advanceTimersByTimeAsync(0); // start()'s initial 0ms pass
      await passSpy.mock.results[0].value;
      expect(passSpy).toHaveBeenCalledTimes(1);

      // A steady stream of local event writes (an agent running while the
      // window is minimized) must not reintroduce the ~3s activity cadence:
      // the stretched 5-minute chain is the ONLY background schedule.
      notifySessionEvents("session-1");
      await vi.advanceTimersByTimeAsync(10_000);
      notifySessionEvents("session-1");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(passSpy).toHaveBeenCalledTimes(1);
    });

    it("drops a debounced activity pass when the document hides before it fires", async () => {
      const passSpy = vi.spyOn(engine, "runSyncPass");
      notifySessionEvents("session-1"); // visible: debounce armed
      documentStub.visibilityState = "hidden";
      await vi.advanceTimersByTimeAsync(5_000);
      // Only start()'s initial 0ms chain pass ran — the 3s debounce fired
      // into the hidden check and was dropped.
      expect(passSpy).toHaveBeenCalledTimes(1);
    });

    it("registers the listener on start and removes it on stop (leak-free)", () => {
      const addSpy = vi.spyOn(documentStub, "addEventListener");
      const removeSpy = vi.spyOn(documentStub, "removeEventListener");
      engine.stop(); // engine from beforeEach — restart under the spies
      engine.start(store);

      const added = addSpy.mock.calls.find(
        ([type]) => type === "visibilitychange"
      );
      expect(added).toBeDefined();

      engine.stop();
      // Removed with the SAME bound handler reference (no leak).
      expect(removeSpy).toHaveBeenCalledWith("visibilitychange", added![1]);

      // And a visibility flip after stop() schedules nothing.
      documentStub.dispatchEvent(new Event("visibilitychange"));
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});

describe("buildCloudSessionMetadata", () => {
  // The registry restore tests below seed the durable fork-relay registry;
  // this top-level describe has no store/engine hooks, so clean it here.
  afterEach(() => {
    localStorage.removeItem(__FORK_RELAY_INTERNALS.FORK_RELAY_STORAGE_KEY);
  });

  /** Valid registry forkedFrom — the entry parse is all-or-nothing. */
  const REGISTRY_FORKED_FROM = {
    orgId: "corg-1",
    sourceSessionId: "session-src",
    ownerMemberId: "m2",
    ownerDisplayName: "Bob",
    atCount: 2,
    forkedAt: "2026-07-02T00:00:00.000Z",
  };

  function buildMetadata() {
    return buildCloudSessionMetadata(
      SESSION,
      "corg-1",
      "user-1",
      "Me",
      SCOPE_KEY,
      { accessMode: "full_replay", visibility: "org" }
    );
  }

  it("mirrors the toRemoteMetadata shape with the cloud user as owner", () => {
    const metadata = buildCloudSessionMetadata(
      SESSION,
      "corg-1",
      "user-1",
      "Me",
      SCOPE_KEY,
      { accessMode: "full_replay", visibility: "org" }
    );
    expect(metadata.id).toBe("corg-1:user-1:session-1");
    expect(metadata.orgId).toBe("corg-1");
    expect(metadata.ownerMemberId).toBe("user-1");
    expect(metadata.repoScopeKey).toBe(SCOPE_KEY);
    expect(metadata.accessMode).toBe("full_replay");
    expect(metadata.replayLevel).toBe("replay");
    expect(metadata.visibility).toBe("org");
  });

  it("carries the ladder outcome onto the wire (metadata_only + restricted)", () => {
    const metadata = buildCloudSessionMetadata(
      SESSION,
      "corg-1",
      "user-1",
      "Me",
      SCOPE_KEY,
      { accessMode: "metadata_only", visibility: "restricted" }
    );
    expect(metadata.accessMode).toBe("metadata_only");
    expect(metadata.replayLevel).toBe("metadata");
    expect(metadata.visibility).toBe("restricted");
  });

  it("restores addressesComment from the fork-relay registry taskContext", () => {
    // `addressesComment` never exists on the Session row at all — the
    // registry taskContext is its only durable local home (agent-pickup
    // design §4), so EVERY push must restore it from there.
    localStorage.setItem(
      __FORK_RELAY_INTERNALS.FORK_RELAY_STORAGE_KEY,
      JSON.stringify({
        [SESSION.session_id]: {
          forkedFrom: REGISTRY_FORKED_FROM,
          handoffPending: false,
          taskContext: {
            orgId: "corg-1",
            sourceSessionId: "session-src",
            commentId: "comment-7",
            taskId: "task-7",
            excerpt: "please look at the failing push",
          },
        },
      })
    );

    const metadata = buildMetadata();

    expect(metadata.addressesComment).toEqual({
      commentId: "comment-7",
      sourceSessionId: "session-src",
    });
    // The same registry entry also restores the fork lineage on the wire.
    expect(metadata.forkedFrom).toMatchObject({
      sourceSessionId: "session-src",
    });
  });

  it("leaves addressesComment absent on the wire without a taskContext", () => {
    // A plain fork (pre-task registry shape): entry present, no taskContext.
    localStorage.setItem(
      __FORK_RELAY_INTERNALS.FORK_RELAY_STORAGE_KEY,
      JSON.stringify({
        [SESSION.session_id]: {
          forkedFrom: REGISTRY_FORKED_FROM,
          handoffPending: false,
        },
      })
    );

    const metadata = buildMetadata();

    expect(metadata.addressesComment).toBeUndefined();
    // No push churn: the metadata hash rides sha256(stableStringify(...)),
    // and stableStringify drops undefined keys — the serialized row is
    // byte-identical to one built by a pre-task client.
    expect(stableStringify(metadata)).not.toContain("addressesComment");
  });
});

describe("isCloudPushCandidate", () => {
  it("excludes only imported teammate copies; the user's own external history is shareable", () => {
    expect(isCloudPushCandidate(SESSION)).toBe(true);
    // Imported teammate copy (pulled from the cloud) — excluded (echo-loop).
    expect(
      isCloudPushCandidate({
        ...SESSION,
        importedFrom: { orgId: "x" } as never,
      })
    ).toBe(false);
    // The user's OWN external history (no importedFrom) is now shareable.
    expect(
      isCloudPushCandidate({ ...SESSION, category: "external_history" })
    ).toBe(true);
    // External history that is ALSO an imported copy stays excluded.
    expect(
      isCloudPushCandidate({
        ...SESSION,
        category: "external_history",
        importedFrom: { orgId: "x" } as never,
      })
    ).toBe(false);
  });
});
