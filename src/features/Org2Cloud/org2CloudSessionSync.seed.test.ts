import { createStore } from "jotai";
import { describe, expect, it, vi } from "vitest";

import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import { COLLAB_SESSION_ACCESS_MODE } from "@src/store/collaboration/types";

import type { CloudPushAccess } from "./org2CloudAccessSettings";
import { Org2CloudSessionSync } from "./org2CloudSessionSync";
import { buildCloudSessionMetadata } from "./org2CloudSessionSync.metadata";
import { Org2CloudSessionSyncState } from "./org2CloudSessionSync.state";
import type { Org2CloudSyncClientDeps } from "./org2CloudSessionSync.types";
import { org2CloudPushCursorsAtom } from "./org2CloudSyncAtoms";
import {
  AUTH,
  SCOPE_KEY,
  SESSION,
  eventStoreMock,
} from "./org2CloudSyncEngine.testUtils";

const ORG_ID = "corg-1";

const ACCESS: CloudPushAccess = {
  accessMode: COLLAB_SESSION_ACCESS_MODE.METADATA_ONLY,
  visibility: "org",
};

class SessionSyncStateHarness extends Org2CloudSessionSyncState {
  cache(key: string): void {
    this.cachePreparedPushEvents(key, Promise.resolve({} as never));
  }

  get cacheSize(): number {
    return this.passPushPrepareCache.size;
  }
}

function makeSeedClient() {
  return {
    upsertSessionMetadata: vi.fn(async () => {}),
    appendSessionEvents: vi.fn(async () => {}),
    rewriteSessionEvents: vi.fn(async () => {}),
    getSessionEvents: vi.fn(async () => ({ events: [], epoch: 0 })),
    getOrgRepoScopes: vi.fn(async () => ({ repoScopes: [] })),
    listOrgSessions: vi.fn(async () => ({ sessions: [] })),
    deleteSession: vi.fn(async () => {}),
  } as unknown as Org2CloudSyncClientDeps & {
    upsertSessionMetadata: ReturnType<typeof vi.fn>;
  };
}

function matchingRemoteSummary() {
  const displayName = AUTH.profile?.displayName ?? AUTH.userId;
  return buildCloudSessionMetadata(
    SESSION,
    ORG_ID,
    AUTH.userId,
    displayName,
    SCOPE_KEY,
    ACCESS,
    AUTH.profile?.avatarUrl
  );
}

describe("Org2CloudSessionSync seedFromRemoteSummary", () => {
  it("suppresses the first metadata upsert after seeding from a matching summary", async () => {
    const client = makeSeedClient();
    const sync = new Org2CloudSessionSync(() => createStore(), client);

    await sync.seedFromRemoteSummary(
      AUTH,
      ORG_ID,
      SESSION,
      SCOPE_KEY,
      ACCESS,
      matchingRemoteSummary()
    );
    await sync.pushSession(AUTH, ORG_ID, SESSION, SCOPE_KEY, ACCESS);

    expect(client.upsertSessionMetadata).not.toHaveBeenCalled();
  });

  it("still upserts when the remote summary does not match the local payload", async () => {
    const client = makeSeedClient();
    const sync = new Org2CloudSessionSync(() => createStore(), client);

    await sync.seedFromRemoteSummary(AUTH, ORG_ID, SESSION, SCOPE_KEY, ACCESS, {
      ...matchingRemoteSummary(),
      title: "Renamed elsewhere",
    });
    await sync.pushSession(AUTH, ORG_ID, SESSION, SCOPE_KEY, ACCESS);

    expect(client.upsertSessionMetadata).toHaveBeenCalledTimes(1);
  });

  it("skips native transcript materialization when cursor, content revision, and remote summary match", async () => {
    const client = makeSeedClient();
    const store = createStore();
    const sync = new Org2CloudSessionSync(() => store, client);
    const access: CloudPushAccess = {
      accessMode: COLLAB_SESSION_ACCESS_MODE.FULL_REPLAY,
      visibility: "org",
    };
    store.set(org2CloudPushCursorsAtom, {
      [`${ORG_ID}:${SESSION.session_id}`]: {
        orgId: ORG_ID,
        sessionId: SESSION.session_id,
        epoch: 7,
        frozenSeq: 3,
        pushedCount: 42,
        frozenEventCount: 40,
        frozenChainHash: "frozen-hash",
        tailHash: "tail-hash",
        localContentRevision: 99,
      },
    });
    const remote = buildCloudSessionMetadata(
      SESSION,
      ORG_ID,
      AUTH.userId,
      AUTH.profile?.displayName ?? AUTH.userId,
      SCOPE_KEY,
      access,
      AUTH.profile?.avatarUrl
    );
    remote.eventsEpoch = 7;
    remote.eventsFrozenSeq = 3;
    remote.eventsCount = 42;
    remote.eventsTailHash = "tail-hash";
    vi.spyOn(
      eventStoreProxy,
      "getPersistedEventRevision"
    ).mockResolvedValueOnce({ eventCount: 42, revision: 99 });
    eventStoreMock.getPersistedEvents.mockClear();

    await sync.seedFromRemoteSummary(
      AUTH,
      ORG_ID,
      SESSION,
      SCOPE_KEY,
      access,
      remote
    );
    await sync.pushSession(AUTH, ORG_ID, SESSION, SCOPE_KEY, access);

    expect(eventStoreMock.getPersistedEvents).not.toHaveBeenCalled();
    expect(client.appendSessionEvents).not.toHaveBeenCalled();
    expect(client.rewriteSessionEvents).not.toHaveBeenCalled();
  });

  it("upgrades a legacy native cursor with a cheap persisted-count proof", async () => {
    const client = makeSeedClient();
    const store = createStore();
    const sync = new Org2CloudSessionSync(() => store, client);
    const access: CloudPushAccess = {
      accessMode: COLLAB_SESSION_ACCESS_MODE.FULL_REPLAY,
      visibility: "org",
    };
    const cursorKey = `${ORG_ID}:${SESSION.session_id}`;
    store.set(org2CloudPushCursorsAtom, {
      [cursorKey]: {
        orgId: ORG_ID,
        sessionId: SESSION.session_id,
        epoch: 7,
        frozenSeq: 3,
        pushedCount: 42,
        frozenEventCount: 40,
        frozenChainHash: "frozen-hash",
        tailHash: "tail-hash",
      },
    });
    const remote = buildCloudSessionMetadata(
      SESSION,
      ORG_ID,
      AUTH.userId,
      AUTH.profile?.displayName ?? AUTH.userId,
      SCOPE_KEY,
      access,
      AUTH.profile?.avatarUrl
    );
    remote.eventsEpoch = 7;
    remote.eventsFrozenSeq = 3;
    remote.eventsCount = 42;
    remote.eventsTailHash = "tail-hash";
    const revisionSpy = vi
      .spyOn(eventStoreProxy, "getPersistedEventRevision")
      .mockResolvedValueOnce({ eventCount: 42, revision: 101 });
    eventStoreMock.getPersistedEvents.mockClear();

    await sync.seedFromRemoteSummary(
      AUTH,
      ORG_ID,
      SESSION,
      SCOPE_KEY,
      access,
      remote
    );
    await sync.pushSession(AUTH, ORG_ID, SESSION, SCOPE_KEY, access);

    expect(revisionSpy).toHaveBeenCalledWith(SESSION.session_id);
    expect(eventStoreMock.getPersistedEvents).not.toHaveBeenCalled();
    expect(
      store.get(org2CloudPushCursorsAtom)[cursorKey]?.localContentRevision
    ).toBe(101);
  });

  it("pushes renamed metadata without re-reading an unchanged native replay", async () => {
    const client = makeSeedClient();
    const store = createStore();
    const sync = new Org2CloudSessionSync(() => store, client);
    const access: CloudPushAccess = {
      accessMode: COLLAB_SESSION_ACCESS_MODE.FULL_REPLAY,
      visibility: "org",
    };
    const renamed = {
      ...SESSION,
      name: "Renamed metadata only",
      updated_at: "2026-08-09T09:00:00.000Z",
    };
    store.set(org2CloudPushCursorsAtom, {
      [`${ORG_ID}:${SESSION.session_id}`]: {
        orgId: ORG_ID,
        sessionId: SESSION.session_id,
        epoch: 7,
        frozenSeq: 3,
        pushedCount: 42,
        frozenEventCount: 40,
        frozenChainHash: "frozen-hash",
        tailHash: "tail-hash",
        localContentRevision: 99,
      },
    });
    const remote = buildCloudSessionMetadata(
      SESSION,
      ORG_ID,
      AUTH.userId,
      AUTH.profile?.displayName ?? AUTH.userId,
      SCOPE_KEY,
      access,
      AUTH.profile?.avatarUrl
    );
    remote.eventsEpoch = 7;
    remote.eventsFrozenSeq = 3;
    remote.eventsCount = 42;
    remote.eventsTailHash = "tail-hash";
    vi.spyOn(
      eventStoreProxy,
      "getPersistedEventRevision"
    ).mockResolvedValueOnce({ eventCount: 42, revision: 99 });
    eventStoreMock.getPersistedEvents.mockClear();

    await sync.seedFromRemoteSummary(
      AUTH,
      ORG_ID,
      renamed,
      SCOPE_KEY,
      access,
      remote
    );
    await sync.pushSession(AUTH, ORG_ID, renamed, SCOPE_KEY, access);

    expect(client.upsertSessionMetadata).toHaveBeenCalledTimes(1);
    expect(eventStoreMock.getPersistedEvents).not.toHaveBeenCalled();
    expect(client.appendSessionEvents).not.toHaveBeenCalled();
    expect(client.rewriteSessionEvents).not.toHaveBeenCalled();
  });
});

describe("Org2CloudSessionSync pass memory", () => {
  it("bounds prepared transcripts and releases them at pass completion", () => {
    const state = new SessionSyncStateHarness(() => null);
    state.cache("session-1");
    state.cache("session-2");
    state.cache("session-3");
    expect(state.cacheSize).toBe(2);

    state.endPass();
    expect(state.cacheSize).toBe(0);
  });
});
