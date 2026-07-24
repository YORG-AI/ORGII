import { vi } from "vitest";

import type { CollabOutboxPushItem } from "@src/api/http/project";
import { getImportedHistorySourceBySessionId } from "@src/api/tauri/externalHistory";
import type {
  ExternalReplayCloudBatch,
  ExternalReplayCloudManifest,
  ExternalReplayTarget,
} from "@src/api/tauri/externalHistory/replay";
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
import { chatPanelSelectedCloudOrgAtom } from "@src/store/ui/chatPanelAtom";
import { createInstrumentedStore } from "@src/util/core/state/instrumentedStore";

import {
  peekShareableScopeKeys,
  primeShareableScopeKey,
  resolveMatchingOrgRepoScope,
} from "../TeamCollaboration/repoScopeResolver";
import {
  PERSONAL_EXCLUDED_TOKEN,
  cloudOrgToken,
  sessionOrgTagsAtom,
} from "../TeamCollaboration/sessionOrgTagsAtom";
import {
  ORG2_CLOUD_ENDPOINT_OVERRIDE_STORAGE_KEY,
  ORG2_CLOUD_EXPECTED_SCHEMA_VERSION,
  ORG2_CLOUD_OFFICIAL_SUPABASE_URL,
} from "./config";
import {
  org2CloudAccessSettingsAtom,
  org2CloudSharingFloorAtom,
} from "./org2CloudAccessSettings";
import type { Org2CloudAuthState } from "./org2CloudAuthAtom";
import { org2CloudAuthAtom } from "./org2CloudAuthAtom";
import {
  org2CloudOrgsAtom,
  sidebarActiveCloudOrgIdAtom,
} from "./org2CloudOrgsAtom";
import { ensureProjectOrgForCloudOrg } from "./org2CloudProjectOrgAlias";
import type { CloudOrgCollabState } from "./org2CloudProjectsClient";
import { Org2CloudProjectsError } from "./org2CloudProjectsClient";
import {
  SESSION_PUSH_RETRY_BASE_MS,
  SESSION_SEGMENT_UPLOAD_BATCH_SIZE,
} from "./org2CloudSessionSync";
import {
  org2CloudCollabStateCursorsAtom,
  org2CloudPushCursorsAtom,
  org2CloudPushedMetadataAtom,
  org2CloudRepoScopesAtom,
  org2CloudSyncEnabledAtom,
} from "./org2CloudSyncAtoms";
import type {
  CloudAppendSessionEventWiresInput,
  CloudAppendSessionEventsInput,
  CloudOrgScopeState,
  CloudOrgSessions,
  CloudRewriteSessionEventWiresInput,
  CloudRewriteSessionEventsInput,
  CloudSessionEventsSnapshot,
} from "./org2CloudSyncClient";
import { Org2CloudSyncError } from "./org2CloudSyncClient";
import {
  DATA_CHANGED_DEBOUNCE_MS,
  EXTERNAL_HISTORY_ACTIVITY_DEBOUNCE_MS,
  INACTIVE_ORG_BACKOFF_COOLDOWN_MS,
  ORG_BACKOFF_COOLDOWN_MS,
  Org2CloudSyncEngine,
  PROJECT_PUSH_RETRY_DELAY_MS,
} from "./org2CloudSyncEngine";

const { tauriEventListeners } = vi.hoisted(() => ({
  tauriEventListeners: new Map<string, Set<(event: unknown) => void>>(),
}));

const externalReplayCloudMocks = vi.hoisted(() => ({
  prepare: vi.fn(
    async (sessionId: string): Promise<ExternalReplayCloudManifest> => ({
      token: `spool-${sessionId}`,
      generation: "test-generation",
      totalCount: 0,
      frozenEventCount: 0,
      tailEventCount: 0,
      frozenChainHash:
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      tailHash: null,
    })
  ),
  readBatch: vi.fn(
    async (options: {
      token: string;
      startEventIndex: number;
      endEventIndex: number;
      startSegmentIndex?: number;
      maxBytes?: number;
    }) => ({
      segments: [] as ExternalReplayCloudBatch["segments"],
      startEventIndex: options.startEventIndex,
      nextEventIndex: options.startEventIndex,
      startSegmentIndex: options.startSegmentIndex ?? options.startEventIndex,
      nextSegmentIndex: options.startSegmentIndex ?? options.startEventIndex,
      eof: true,
      serializedBytes: 0,
    })
  ),
  prefixHash: vi.fn(async (options: { eventCount: number }) => ({
    eventCount: options.eventCount,
    frozenChainHash:
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  })),
  release: vi.fn(async (_token: string) => undefined),
  resolveSecondary: vi.fn(
    async (): Promise<ExternalReplayTarget | null> => null
  ),
}));

vi.mock("@src/api/tauri/externalHistory/replay", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@src/api/tauri/externalHistory/replay")
    >();
  return {
    ...actual,
    externalReplayCloudPrepareForTarget: (target: { sessionId: string }) =>
      externalReplayCloudMocks.prepare(target.sessionId),
    externalReplayCloudReadBatch: externalReplayCloudMocks.readBatch,
    externalReplayCloudPrefixHash: externalReplayCloudMocks.prefixHash,
    externalReplayCloudRelease: externalReplayCloudMocks.release,
    resolveSecondaryReplayTarget: externalReplayCloudMocks.resolveSecondary,
  };
});

export function getTauriEventListeners() {
  return tauriEventListeners;
}

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
  shareableScopeKeysFromRemoteUrls: vi.fn((urls: string[] | undefined) =>
    urls?.length ? [...urls] : null
  ),
  resolveMatchingOrgRepoScope: vi.fn(
    async (keys: string[] | null, scopes: string[] | undefined) =>
      scopes?.find((scope) => keys?.includes(scope)) ?? null
  ),
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

export const eventStoreMock = vi.mocked(eventStoreProxy);
export const processChunksRustMock = vi.mocked(processChunksRust);
export const peekMock = vi.mocked(peekShareableScopeKeys);
export const primeMock = vi.mocked(primeShareableScopeKey);
export const resolveMatchingScopeMock = vi.mocked(resolveMatchingOrgRepoScope);
export const messageMock = vi.mocked(Message);
export const externalReplayCloudPrepareMock = externalReplayCloudMocks.prepare;
export const externalReplayCloudReadBatchMock =
  externalReplayCloudMocks.readBatch;
export const externalReplayCloudPrefixHashMock =
  externalReplayCloudMocks.prefixHash;
export const externalReplayCloudReleaseMock = externalReplayCloudMocks.release;
export const resolveSecondaryReplayTargetMock =
  externalReplayCloudMocks.resolveSecondary;

/** Minimal visibility stub for the engine's browser lifecycle triggers. */
export class DocumentStub extends EventTarget {
  visibilityState: DocumentVisibilityState = "visible";
}

export const documentStub = new DocumentStub();
Object.defineProperty(globalThis, "document", {
  value: documentStub,
  configurable: true,
  writable: true,
});

export const REPO_PATH = "/repo/alpha";
export const SCOPE_KEY = "github.com/acme/alpha";
export const CUSTOM_SUPABASE_URL = "https://supabase.acme.dev";

export const AUTH: Org2CloudAuthState = {
  kind: "org2_cloud",
  supabaseUrl: ORG2_CLOUD_OFFICIAL_SUPABASE_URL,
  supabaseAnonKey: "anon",
  userId: "user-1",
  accessToken: "jwt-1",
  refreshToken: "rt-1",
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
  profile: { displayName: "Me" },
};

export const SESSION: Session = {
  session_id: "session-1",
  status: "completed",
  created_at: "2026-07-01T00:00:00.000Z",
  updated_at: "2026-07-01T00:00:00.000Z",
  name: "Local session",
  orgId: "cloud:corg-1",
  repoPath: REPO_PATH,
  repoRemoteUrls: [SCOPE_KEY],
  category: "rust_agent",
};

export function makeEvent(
  id: string,
  displayStatus: EventDisplayStatus = "completed"
): SessionEvent {
  return {
    id,
    sessionId: "session-1",
    displayStatus,
  } as unknown as SessionEvent;
}

export function conflictError(): Org2CloudSyncError {
  return new Org2CloudSyncError("ORG2_CONFLICT", 409);
}

export function makeClient() {
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
    appendSessionEventWires: vi.fn(
      async (_token: string, _input: CloudAppendSessionEventWiresInput) =>
        undefined
    ),
    rewriteSessionEvents: vi.fn(
      async (_token: string, _input: CloudRewriteSessionEventsInput) =>
        undefined
    ),
    rewriteSessionEventWires: vi.fn(
      async (_token: string, _input: CloudRewriteSessionEventWiresInput) =>
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
    listOrgSessions: vi.fn(
      async (_token: string, _orgId: string): Promise<CloudOrgSessions> => ({
        serverTime: "2026-07-01T12:00:00.000Z",
        sessions: [],
      })
    ),
    deleteSession: vi.fn(
      async (_token: string, _orgId: string, _sessionId: string) => undefined
    ),
  };
}

export function makeProjectsClient() {
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

export function makeBridge() {
  return {
    drainOutbox: vi.fn(async () => [] as CollabOutboxPushItem[]),
    ackOutbox: vi.fn(async () => undefined),
    applyRemote: vi.fn(async () => 0),
    notifyDataChanged: vi.fn(async () => undefined),
    notifyOutboxFlushed: vi.fn(async () => undefined),
  };
}

export function emitDataChanged(): void {
  for (const handler of tauriEventListeners.get("orgii-data-changed") ?? []) {
    handler({ payload: undefined });
  }
}

export function notifySessionEvents(sessionId: string): void {
  for (const [listener] of eventStoreMock.subscribe.mock.calls) {
    (listener as (snapshot: unknown, sessionId: string) => void)(
      undefined,
      sessionId
    );
  }
}

export function createEngineFixture() {
  const store = createInstrumentedStore();
  const client = makeClient();
  const projectsClient = makeProjectsClient();
  const bridge = makeBridge();
  const engine = new Org2CloudSyncEngine(client, projectsClient, bridge);

  tauriEventListeners.clear();
  store.set(org2CloudAuthAtom, AUTH);
  store.set(org2CloudOrgsAtom, [
    { orgId: "corg-1", name: "Cloud Team", role: "member" },
  ]);
  store.set(chatPanelSelectedCloudOrgAtom, null);
  store.set(sidebarActiveCloudOrgIdAtom, "corg-1");
  store.set(org2CloudRepoScopesAtom, { "corg-1": [SCOPE_KEY] });
  store.set(org2CloudSyncEnabledAtom, {});
  store.set(org2CloudPushCursorsAtom, {});
  store.set(org2CloudPushedMetadataAtom, {});
  store.set(org2CloudCollabStateCursorsAtom, {});
  store.set(sessionOrgTagsAtom, {});
  store.set(org2CloudAccessSettingsAtom, {
    "corg-1": {
      sessionModes: {},
      sessionVisibility: {},
    },
  });
  store.set(org2CloudSharingFloorAtom, { "corg-1": "full_replay" });
  store.set(sessionsAtom, [SESSION]);
  peekMock.mockImplementation((path: string) =>
    path === REPO_PATH ? [SCOPE_KEY] : null
  );
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
  vi.useFakeTimers();
  engine.start(store);

  return { store, client, projectsClient, bridge, engine };
}

export type EngineFixture = ReturnType<typeof createEngineFixture>;

export function cleanupEngineFixture(engine: Org2CloudSyncEngine): void {
  engine.stop();
  localStorage.removeItem(ORG2_CLOUD_ENDPOINT_OVERRIDE_STORAGE_KEY);
  vi.useRealTimers();
  vi.clearAllMocks();
}

/** Runtime dependencies consumed by the split specs.
 *
 * Keeping these behind the fixture module ensures its `vi.mock` declarations
 * are installed before the engine and its collaborators are evaluated.
 */
export const engineTestDeps = {
  DATA_CHANGED_DEBOUNCE_MS,
  EXTERNAL_HISTORY_ACTIVITY_DEBOUNCE_MS,
  chatPanelSelectedCloudOrgAtom,
  ensureProjectOrgForCloudOrg,
  getImportedHistorySourceBySessionId,
  INACTIVE_ORG_BACKOFF_COOLDOWN_MS,
  ORG2_CLOUD_ENDPOINT_OVERRIDE_STORAGE_KEY,
  ORG2_CLOUD_EXPECTED_SCHEMA_VERSION,
  ORG_BACKOFF_COOLDOWN_MS,
  Org2CloudProjectsError,
  Org2CloudSyncEngine,
  Org2CloudSyncError,
  PERSONAL_EXCLUDED_TOKEN,
  PROJECT_PUSH_RETRY_DELAY_MS,
  SESSION_PUSH_RETRY_BASE_MS,
  SESSION_SEGMENT_UPLOAD_BATCH_SIZE,
  cloudOrgToken,
  org2CloudAccessSettingsAtom,
  org2CloudSharingFloorAtom,
  org2CloudAuthAtom,
  org2CloudCollabStateCursorsAtom,
  org2CloudOrgsAtom,
  org2CloudPushCursorsAtom,
  org2CloudPushedMetadataAtom,
  org2CloudRepoScopesAtom,
  org2CloudSyncEnabledAtom,
  sidebarActiveCloudOrgIdAtom,
  sessionOrgTagsAtom,
  sessionsAtom,
};
