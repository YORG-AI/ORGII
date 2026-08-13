import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ImportedHistorySource } from "@src/api/tauri/externalHistory";
import { rpc } from "@src/api/tauri/rpc";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import type { Session } from "@src/store/session/sessionAtom/types";

import {
  REPO_PATH,
  SCOPE_KEY,
  SESSION,
  cleanupEngineFixture,
  conflictError,
  createEngineFixture,
  engineTestDeps,
  eventStoreMock,
  makeEvent,
  messageMock,
  notifyScopeKeysResolved,
  notifySessionEvents,
  peekMock,
  primeMock,
  processChunksRustMock,
} from "./org2CloudSyncEngine.testUtils";
import type { EngineFixture } from "./org2CloudSyncEngine.testUtils";

const {
  EXTERNAL_HISTORY_ACTIVITY_DEBOUNCE_MS,
  ORG_BACKOFF_COOLDOWN_MS,
  PERSONAL_EXCLUDED_TOKEN,
  SESSION_PUSH_RETRY_BASE_MS,
  SESSION_SEGMENT_UPLOAD_BATCH_SIZE,
  Org2CloudSyncEngine,
  Org2CloudSyncError,
  chatPanelSelectedCloudOrgAtom,
  cloudOrgToken,
  getImportedHistorySourceBySessionId,
  org2CloudAccessSettingsAtom,
  org2CloudOrgsAtom,
  org2CloudPushCursorsAtom,
  org2CloudPushedMetadataAtom,
  org2CloudRepoScopesAtom,
  org2CloudSharingFloorAtom,
  org2CloudSyncEnabledAtom,
  sidebarActiveCloudOrgIdAtom,
  sessionOrgTagsAtom,
  sessionsAtom,
} = engineTestDeps;

describe("Org2CloudSyncEngine session publishing", () => {
  let fixture: EngineFixture;
  let store: EngineFixture["store"];
  let client: EngineFixture["client"];
  let projectsClient: EngineFixture["projectsClient"];
  let bridge: EngineFixture["bridge"];
  let engine: EngineFixture["engine"];

  beforeEach(() => {
    fixture = createEngineFixture();
    ({ store, client, projectsClient, bridge, engine } = fixture);
  });

  afterEach(() => {
    cleanupEngineFixture(engine);
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

  it("publishes live CLI sessions from the native transcript when the events cache is empty", async () => {
    eventStoreMock.getPersistedEvents.mockResolvedValueOnce([]);
    const chunks = [{ id: "cli-chunk" }] as never;
    const chunksSpy = vi.spyOn(rpc.cli, "chunks").mockResolvedValue(chunks);
    const converted = [makeEvent("cli-event")];
    processChunksRustMock.mockResolvedValueOnce(converted);

    const events = await (
      engine as unknown as {
        loadPushEvents(sessionId: string): Promise<SessionEvent[]>;
      }
    ).loadPushEvents("cliagent-123-native");

    expect(events).toEqual(converted);
    expect(chunksSpy).toHaveBeenCalledWith({
      sessionId: "cliagent-123-native",
    });
    expect(processChunksRustMock).toHaveBeenCalledWith(
      chunks,
      "cliagent-123-native"
    );
    chunksSpy.mockRestore();
  });

  it("prefers the persisted event cache for CLI sessions when it is populated", async () => {
    const persisted = [makeEvent("persisted-cli-event")];
    eventStoreMock.getPersistedEvents.mockResolvedValueOnce(persisted);
    const chunksSpy = vi.spyOn(rpc.cli, "chunks");

    const events = await (
      engine as unknown as {
        loadPushEvents(sessionId: string): Promise<SessionEvent[]>;
      }
    ).loadPushEvents("cliagent-123-native");

    expect(events).toEqual(persisted);
    expect(chunksSpy).not.toHaveBeenCalled();
    chunksSpy.mockRestore();
  });
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
        sessionModes: {},
        sessionVisibility: {},
      },
      "corg-team": {
        sessionModes: {},
        sessionVisibility: {},
      },
    });
    store.set(org2CloudSharingFloorAtom, {
      "corg-personal": "full_replay",
      "corg-team": "full_replay",
    });
    store.set(sidebarActiveCloudOrgIdAtom, "corg-team");

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

  it("publishes a large rewrite in bounded resumable segment batches", async () => {
    const oversizedPayload = "x".repeat(260 * 1024);
    const events = Array.from(
      { length: SESSION_SEGMENT_UPLOAD_BATCH_SIZE + 1 },
      (_, index) =>
        ({
          ...makeEvent(`large-${index}`),
          payload: `${index}:${oversizedPayload}`,
        }) as unknown as SessionEvent
    );
    eventStoreMock.getPersistedEvents.mockResolvedValue(events);

    await engine.runSyncPass();

    expect(client.rewriteSessionEvents).toHaveBeenCalledTimes(1);
    const [, rewrite] = client.rewriteSessionEvents.mock.calls[0];
    expect(rewrite.frozenSegments).toHaveLength(
      SESSION_SEGMENT_UPLOAD_BATCH_SIZE
    );
    expect(rewrite.tail).toBeNull();
    expect(rewrite.totalCount).toBe(SESSION_SEGMENT_UPLOAD_BATCH_SIZE);

    expect(client.appendSessionEvents).toHaveBeenCalledTimes(1);
    const [, append] = client.appendSessionEvents.mock.calls[0];
    expect(append.expectedFrozenSeq).toBe(SESSION_SEGMENT_UPLOAD_BATCH_SIZE);
    expect(append.newFrozenSegments).toHaveLength(1);
    expect(append.totalCount).toBe(events.length);

    expect(
      store.get(org2CloudPushCursorsAtom)["corg-1:session-1"]
    ).toMatchObject({
      epoch: 1,
      frozenSeq: SESSION_SEGMENT_UPLOAD_BATCH_SIZE + 1,
      pushedCount: events.length,
      frozenEventCount: events.length,
    });
  });

  it("backs off a failed large upload and resumes from its committed batch", async () => {
    const oversizedPayload = "y".repeat(260 * 1024);
    const events = Array.from(
      { length: SESSION_SEGMENT_UPLOAD_BATCH_SIZE + 2 },
      (_, index) =>
        ({
          ...makeEvent(`resume-${index}`),
          payload: `${index}:${oversizedPayload}`,
        }) as unknown as SessionEvent
    );
    eventStoreMock.getPersistedEvents.mockResolvedValue(events);
    client.appendSessionEvents.mockRejectedValueOnce(
      new Org2CloudSyncError(
        "canceling statement due to statement timeout",
        500
      )
    );

    await engine.runSyncPass();

    expect(client.rewriteSessionEvents).toHaveBeenCalledTimes(1);
    expect(client.appendSessionEvents).toHaveBeenCalledTimes(1);
    expect(
      store.get(org2CloudPushCursorsAtom)["corg-1:session-1"]
    ).toMatchObject({
      frozenSeq: SESSION_SEGMENT_UPLOAD_BATCH_SIZE,
      pushedCount: SESSION_SEGMENT_UPLOAD_BATCH_SIZE,
      frozenEventCount: SESSION_SEGMENT_UPLOAD_BATCH_SIZE,
      tailHash: null,
    });
    expect(eventStoreMock.getPersistedEvents).toHaveBeenCalledTimes(1);

    await engine.runSyncPass();
    expect(client.rewriteSessionEvents).toHaveBeenCalledTimes(1);
    expect(client.appendSessionEvents).toHaveBeenCalledTimes(1);
    // The retry gate runs before loadPushEvents, so the large transcript is
    // not reparsed or rehashed during the cooldown.
    expect(eventStoreMock.getPersistedEvents).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + SESSION_PUSH_RETRY_BASE_MS + 1);
    await engine.runSyncPass();

    expect(client.rewriteSessionEvents).toHaveBeenCalledTimes(1);
    expect(client.appendSessionEvents).toHaveBeenCalledTimes(2);
    expect(
      store.get(org2CloudPushCursorsAtom)["corg-1:session-1"]
    ).toMatchObject({
      frozenSeq: SESSION_SEGMENT_UPLOAD_BATCH_SIZE + 2,
      pushedCount: events.length,
      frozenEventCount: events.length,
    });
    expect(eventStoreMock.getPersistedEvents).toHaveBeenCalledTimes(2);
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

    expect(client.getSessionEvents).toHaveBeenCalledWith(
      "jwt-1",
      "corg-1",
      "session-1",
      { afterSeq: 2_147_483_647 }
    );
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
    store.set(sidebarActiveCloudOrgIdAtom, "corg-1");
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

  it("does not publish sessions for an inactive org", async () => {
    store.set(sidebarActiveCloudOrgIdAtom, null);
    client.upsertSessionMetadata.mockRejectedValue(
      new Org2CloudSyncError("ORG2_QUOTA_EXCEEDED", 403)
    );

    await engine.runSyncPass();
    expect(messageMock.warning).not.toHaveBeenCalled();
    expect(client.upsertSessionMetadata).not.toHaveBeenCalled();

    store.set(sidebarActiveCloudOrgIdAtom, "corg-1");
    await engine.runSyncPass();
    expect(client.upsertSessionMetadata).toHaveBeenCalledTimes(1);
    expect(messageMock.warning).toHaveBeenCalledTimes(1);
  });

  it("applies the org minimum while publishing a background org", async () => {
    store.set(sidebarActiveCloudOrgIdAtom, null);
    store.set(org2CloudOrgsAtom, [
      {
        orgId: "corg-1",
        name: "Cloud Team",
        role: "member",
        offlineSyncEnabled: true,
      },
    ]);

    await engine.runSyncPass();

    expect(client.getOrgRepoScopes).toHaveBeenCalledWith("jwt-1", "corg-1");
    expect(client.listOrgSessions).toHaveBeenCalledWith("jwt-1", "corg-1");
    expect(client.upsertSessionMetadata).toHaveBeenCalledTimes(1);
    expect(client.upsertSessionMetadata.mock.calls[0][1]).toBe("corg-1");
    expect(client.upsertSessionMetadata.mock.calls[0][3].accessMode).toBe(
      "full_replay"
    );
    expect(client.rewriteSessionEvents).toHaveBeenCalledTimes(1);
  });

  it("treats the visible management org as active for retry and toast policy", async () => {
    store.set(sidebarActiveCloudOrgIdAtom, null);
    store.set(chatPanelSelectedCloudOrgAtom, { orgId: "corg-1" });
    client.upsertSessionMetadata.mockRejectedValue(
      new Org2CloudSyncError("ORG2_QUOTA_EXCEEDED", 403)
    );

    await engine.runSyncPass();

    expect(messageMock.warning).toHaveBeenCalledTimes(1);
    expect(messageMock.warning).toHaveBeenCalledWith(
      "navigation:cloud.sync.quotaExceededToast"
    );
  });

  it("starts publishing and warns when an inactive org becomes active", async () => {
    store.set(sidebarActiveCloudOrgIdAtom, null);
    client.upsertSessionMetadata.mockRejectedValue(
      new Org2CloudSyncError("ORG2_QUOTA_EXCEEDED", 403)
    );

    await engine.runSyncPass();
    expect(messageMock.warning).not.toHaveBeenCalled();
    expect(client.upsertSessionMetadata).not.toHaveBeenCalled();

    client.upsertSessionMetadata.mockClear();
    store.set(sidebarActiveCloudOrgIdAtom, "corg-1");
    await engine.runSyncPass();
    expect(client.upsertSessionMetadata).toHaveBeenCalledTimes(1);
    expect(messageMock.warning).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + ORG_BACKOFF_COOLDOWN_MS + 1);
    await engine.runSyncPass();
    expect(messageMock.warning).toHaveBeenCalledTimes(1);
  });

  it("does not repeat the active-org toast on automatic cooldown retries", async () => {
    store.set(sidebarActiveCloudOrgIdAtom, "corg-1");
    client.upsertSessionMetadata.mockRejectedValue(
      new Org2CloudSyncError("ORG2_QUOTA_EXCEEDED", 403)
    );

    await engine.runSyncPass();
    vi.setSystemTime(Date.now() + ORG_BACKOFF_COOLDOWN_MS + 1);
    await engine.runSyncPass();
    expect(messageMock.warning).toHaveBeenCalledTimes(1);

    await engine.resumeOrgAndWait("corg-1");
    expect(messageMock.warning).toHaveBeenCalledTimes(2);
  });

  it("evicts the backoff episode when an org membership is removed", async () => {
    store.set(sidebarActiveCloudOrgIdAtom, "corg-1");
    client.upsertSessionMetadata.mockRejectedValue(
      new Org2CloudSyncError("ORG2_QUOTA_EXCEEDED", 403)
    );
    const originalOrgs = store.get(org2CloudOrgsAtom);

    await engine.runSyncPass();
    expect(messageMock.warning).toHaveBeenCalledTimes(1);

    store.set(org2CloudOrgsAtom, []);
    await engine.runSyncPass();
    store.set(org2CloudOrgsAtom, originalOrgs);
    await engine.runSyncPass();

    expect(messageMock.warning).toHaveBeenCalledTimes(2);
  });

  it("evicts per-session acceleration state when a local session disappears", async () => {
    await engine.runSyncPass();
    client.upsertSessionMetadata.mockClear();

    store.set(sessionsAtom, []);
    await engine.runSyncPass();
    store.set(sessionsAtom, [SESSION]);
    await engine.runSyncPass();

    expect(client.upsertSessionMetadata).toHaveBeenCalledTimes(1);
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

  it("does not materialize local histories when cold-start summary hydration is offline", async () => {
    client.listOrgSessions.mockRejectedValueOnce(new Error("offline"));
    eventStoreMock.getPersistedEvents.mockClear();

    await engine.runSyncPass();

    expect(eventStoreMock.getPersistedEvents).not.toHaveBeenCalled();
    expect(client.upsertSessionMetadata).not.toHaveBeenCalled();
    expect(client.rewriteSessionEvents).not.toHaveBeenCalled();
  });

  it("runs one event-driven pass when a repository identity finishes resolving", async () => {
    await vi.advanceTimersByTimeAsync(0);
    await engine.runSyncPassAndWaitForDrain();
    const passCount = engine.startedPassCount;

    notifyScopeKeysResolved();
    notifyScopeKeysResolved();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(engine.startedPassCount).toBe(passCount + 1);
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

  it("clears the Personal exclusion when dropping the session's last cloud tag", async () => {
    store.set(org2CloudRepoScopesAtom, { "corg-1": ["github.com/other/repo"] });
    store.set(sessionOrgTagsAtom, {
      "session-1": [cloudOrgToken("corg-1"), PERSONAL_EXCLUDED_TOKEN],
    });
    await engine.runSyncPass();
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
    // Push in scope first via the org's full-replay minimum.
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

  it("hydrates and publishes only the active org when background upload is off", async () => {
    store.set(org2CloudOrgsAtom, [
      { orgId: "corg-1", name: "Active Team", role: "member" },
      { orgId: "corg-2", name: "Inactive Team", role: "member" },
    ]);
    store.set(org2CloudRepoScopesAtom, {
      "corg-1": [SCOPE_KEY],
      "corg-2": [SCOPE_KEY],
    });

    await engine.runSyncPass();

    expect(client.listOrgSessions).toHaveBeenCalledTimes(1);
    expect(client.listOrgSessions).toHaveBeenCalledWith("jwt-1", "corg-1");
    expect(client.upsertSessionMetadata).toHaveBeenCalledTimes(1);
    expect(client.upsertSessionMetadata.mock.calls[0][1]).toBe("corg-1");
  });

  // --- Access ladder (§13.4) ------------------------------------------------

  it("a scope-matched session is NOT uploaded with no org minimum or session override", async () => {
    // No minimum and no per-session access ⇒ local mode OFF:
    // repo-scope match makes the session a candidate, nothing more.
    store.set(org2CloudAccessSettingsAtom, {});
    store.set(org2CloudSharingFloorAtom, {});
    await engine.runSyncPass();
    expect(client.upsertSessionMetadata).not.toHaveBeenCalled();
    expect(client.rewriteSessionEvents).not.toHaveBeenCalled();
    expect(client.appendSessionEvents).not.toHaveBeenCalled();
  });

  it("applies the admin floor to scope-matched imported history", async () => {
    const source = getImportedHistorySourceBySessionId("cursoride-thread-1");
    const loadFullTranscriptChunks = vi
      .spyOn(source!, "loadFullTranscriptChunks")
      .mockResolvedValue([] as never);
    store.set(org2CloudAccessSettingsAtom, {});
    store.set(org2CloudSharingFloorAtom, { "corg-1": "full_replay" });
    store.set(sessionsAtom, [
      { ...SESSION, session_id: "cursoride-thread-1", orgId: "personal-org" },
    ]);

    await engine.runSyncPass();

    expect(client.upsertSessionMetadata).not.toHaveBeenCalled();
    expect(loadFullTranscriptChunks).not.toHaveBeenCalled();

    vi.setSystemTime(Date.now() + EXTERNAL_HISTORY_ACTIVITY_DEBOUNCE_MS + 1);
    await engine.runSyncPass();

    expect(client.upsertSessionMetadata).toHaveBeenCalledTimes(1);
    expect(client.upsertSessionMetadata.mock.calls[0][3].accessMode).toBe(
      "full_replay"
    );
    expect(loadFullTranscriptChunks).toHaveBeenCalledWith("cursoride-thread-1");
  });

  it("waits for a quiet window before normalizing a changing external replay", async () => {
    const source = getImportedHistorySourceBySessionId("cursoride-thread-1");
    const loadFullTranscriptChunks = vi
      .spyOn(source!, "loadFullTranscriptChunks")
      .mockResolvedValue([] as never);
    store.set(sessionsAtom, [
      { ...SESSION, session_id: "cursoride-thread-1", orgId: "personal-org" },
    ]);
    notifySessionEvents("cursoride-thread-1");

    await engine.runSyncPass();

    expect(client.upsertSessionMetadata).not.toHaveBeenCalled();
    expect(loadFullTranscriptChunks).not.toHaveBeenCalled();
    expect(processChunksRustMock).not.toHaveBeenCalled();

    vi.setSystemTime(Date.now() + EXTERNAL_HISTORY_ACTIVITY_DEBOUNCE_MS + 1);
    await engine.runSyncPass();

    expect(client.upsertSessionMetadata).toHaveBeenCalledTimes(1);
    expect(loadFullTranscriptChunks).toHaveBeenCalledTimes(1);
  });

  it("replays only the mutable turn and appended turns after an imported full anchor", async () => {
    const sessionId = "cursoride-incremental-thread-1";
    type CloudReplaySource = ImportedHistorySource &
      Required<
        Pick<ImportedHistorySource, "loadCloudTurnIds" | "loadCloudTurnWindows">
      >;
    const source = getImportedHistorySourceBySessionId(
      sessionId
    ) as CloudReplaySource;
    const turnChunks = {
      "turn-a": [{ chunk_id: "raw-a", function: "user_message" }],
      "turn-b": [{ chunk_id: "raw-b", function: "user_message" }],
      "turn-c": [{ chunk_id: "raw-c", function: "user_message" }],
      "turn-d": [{ chunk_id: "raw-d", function: "user_message" }],
    } as const;
    const turnEvents = {
      "turn-a": [makeEvent("event-a-user"), makeEvent("event-a-result")],
      "turn-b": [makeEvent("event-b-user"), makeEvent("event-b-result")],
      "turn-c": [makeEvent("event-c-user"), makeEvent("event-c-result")],
      "turn-d": [makeEvent("event-d-user"), makeEvent("event-d-result")],
    } as const;
    let authoritativeChunks: Array<{
      readonly chunk_id: string;
      readonly function: string;
    }> = [...turnChunks["turn-a"], ...turnChunks["turn-b"]];
    let authoritativeEvents = [
      ...turnEvents["turn-a"],
      ...turnEvents["turn-b"],
    ];
    const loadFullTranscriptChunks = vi
      .spyOn(source, "loadFullTranscriptChunks")
      .mockImplementation(async () => authoritativeChunks as never);
    const loadCloudTurnIds = vi
      .spyOn(source, "loadCloudTurnIds")
      .mockResolvedValue(["turn-a", "turn-b"]);
    const loadCloudTurnWindows = vi
      .spyOn(source, "loadCloudTurnWindows")
      .mockImplementation(async (_sessionId, turnIds) =>
        turnIds.map((turnId) => ({
          turnId,
          chunks: turnChunks[turnId as keyof typeof turnChunks] as never,
        }))
      );
    processChunksRustMock.mockImplementation(async (chunks) => {
      if (chunks === authoritativeChunks) return authoritativeEvents;
      const turnId = Object.entries(turnChunks).find(
        ([, candidate]) => candidate[0]?.chunk_id === chunks[0]?.chunk_id
      )?.[0] as keyof typeof turnEvents | undefined;
      return turnId ? [...turnEvents[turnId]] : [];
    });
    store.set(sessionsAtom, [
      { ...SESSION, session_id: sessionId, orgId: "personal-org" },
    ]);

    await engine.runSyncPass();
    vi.setSystemTime(Date.now() + EXTERNAL_HISTORY_ACTIVITY_DEBOUNCE_MS + 1);
    await engine.runSyncPass();

    const anchored = store.get(org2CloudPushCursorsAtom)[`corg-1:${sessionId}`];
    expect(anchored.importedReplay).toMatchObject({
      reloadTurnId: "turn-b",
      retainedEventCount: 2,
      retainedChunkCount: 1,
      frozenOverlapCount: 2,
    });
    expect(anchored.importedReplay?.frozenHashFrontier.length).toBeGreaterThan(
      0
    );
    expect(client.rewriteSessionEvents).toHaveBeenCalledTimes(1);

    loadFullTranscriptChunks.mockClear();
    loadCloudTurnIds.mockResolvedValue(["turn-a", "turn-b", "turn-c"]);
    client.appendSessionEvents.mockClear();
    store.set(sessionsAtom, [
      {
        ...SESSION,
        session_id: sessionId,
        orgId: "personal-org",
        updated_at: "2026-08-04T15:01:00.000Z",
      },
    ]);
    await engine.runSyncPass();
    vi.setSystemTime(Date.now() + EXTERNAL_HISTORY_ACTIVITY_DEBOUNCE_MS + 1);
    await engine.runSyncPass();

    expect(loadFullTranscriptChunks).not.toHaveBeenCalled();
    expect(loadCloudTurnWindows).toHaveBeenLastCalledWith(
      sessionId,
      ["turn-b", "turn-c"],
      1
    );
    expect(client.appendSessionEvents).toHaveBeenCalledTimes(1);
    expect(client.appendSessionEvents.mock.calls[0][1]).toMatchObject({
      expectedEpoch: anchored.epoch,
      expectedFrozenSeq: anchored.frozenSeq,
      totalCount: 6,
    });
    expect(
      client.appendSessionEvents.mock.calls[0][1].newFrozenSegments.flatMap(
        (segment) => segment.events
      )
    ).toEqual(turnEvents["turn-c"]);
    const advanced = store.get(org2CloudPushCursorsAtom)[`corg-1:${sessionId}`];
    expect(advanced).toMatchObject({ pushedCount: 6, frozenEventCount: 6 });
    expect(advanced.importedReplay).toMatchObject({
      reloadTurnId: "turn-c",
      retainedEventCount: 4,
      retainedChunkCount: 2,
      frozenOverlapCount: 2,
    });

    // A changed source prefix invalidates the provider cursor even when its
    // normalized event bytes happen to remain equal. Recovery is one full
    // authoritative read, after which the new prefix is checkpointed.
    authoritativeChunks = [
      ...turnChunks["turn-a"],
      ...turnChunks["turn-b"],
      ...turnChunks["turn-c"],
    ];
    authoritativeEvents = [
      ...turnEvents["turn-a"],
      ...turnEvents["turn-b"],
      ...turnEvents["turn-c"],
    ];
    loadFullTranscriptChunks.mockClear();
    loadCloudTurnIds.mockResolvedValue(["turn-x", "turn-b", "turn-c"]);
    store.set(sessionsAtom, [
      {
        ...SESSION,
        session_id: sessionId,
        orgId: "personal-org",
        updated_at: "2026-08-04T15:02:00.000Z",
      },
    ]);
    await engine.runSyncPass();
    vi.setSystemTime(Date.now() + EXTERNAL_HISTORY_ACTIVITY_DEBOUNCE_MS + 1);
    await engine.runSyncPass();
    expect(loadFullTranscriptChunks).toHaveBeenCalledTimes(1);

    // If another writer wins OCC after incremental preparation, recovery must
    // discard the bounded suffix and re-read the full source before rewriting
    // at the server's epoch. A suffix must never be used as a rewrite body.
    authoritativeChunks = [
      ...turnChunks["turn-a"],
      ...turnChunks["turn-b"],
      ...turnChunks["turn-c"],
      ...turnChunks["turn-d"],
    ];
    authoritativeEvents = [
      ...turnEvents["turn-a"],
      ...turnEvents["turn-b"],
      ...turnEvents["turn-c"],
      ...turnEvents["turn-d"],
    ];
    loadFullTranscriptChunks.mockClear();
    loadCloudTurnIds.mockResolvedValue([
      "turn-x",
      "turn-b",
      "turn-c",
      "turn-d",
    ]);
    client.appendSessionEvents.mockClear();
    client.rewriteSessionEvents.mockClear();
    client.appendSessionEvents.mockRejectedValueOnce(conflictError());
    client.getSessionEvents.mockResolvedValueOnce({
      epoch: 5,
      frozenSeq: 9,
      tailHash: "server-tail",
      count: 9,
      segments: [],
    });
    store.set(sessionsAtom, [
      {
        ...SESSION,
        session_id: sessionId,
        orgId: "personal-org",
        updated_at: "2026-08-04T15:03:00.000Z",
      },
    ]);
    await engine.runSyncPass();
    vi.setSystemTime(Date.now() + EXTERNAL_HISTORY_ACTIVITY_DEBOUNCE_MS + 1);
    await engine.runSyncPass();
    expect(client.appendSessionEvents).toHaveBeenCalledTimes(1);
    expect(loadFullTranscriptChunks).toHaveBeenCalledTimes(1);
    expect(client.rewriteSessionEvents).toHaveBeenCalledTimes(1);
    expect(client.rewriteSessionEvents.mock.calls[0][1]).toMatchObject({
      newEpoch: 6,
      totalCount: 8,
    });

    loadFullTranscriptChunks.mockRestore();
    loadCloudTurnIds.mockRestore();
    loadCloudTurnWindows.mockRestore();
  });

  it("forces a full authoritative reread after the incremental pass budget", async () => {
    const { IMPORTED_INCREMENTAL_REANCHOR_EVERY } =
      await import("./org2CloudSessionSync");
    const sessionId = "cursoride-reanchor-cadence-thread-1";
    type CloudReplaySource = ImportedHistorySource &
      Required<
        Pick<ImportedHistorySource, "loadCloudTurnIds" | "loadCloudTurnWindows">
      >;
    const source = getImportedHistorySourceBySessionId(
      sessionId
    ) as CloudReplaySource;
    const turnChunks = {
      "turn-a": [{ chunk_id: "raw-a", function: "user_message" }],
      "turn-b": [{ chunk_id: "raw-b", function: "user_message" }],
      "turn-c": [{ chunk_id: "raw-c", function: "user_message" }],
      "turn-d": [{ chunk_id: "raw-d", function: "user_message" }],
    } as const;
    const turnEvents = {
      "turn-a": [makeEvent("event-a-user"), makeEvent("event-a-result")],
      "turn-b": [makeEvent("event-b-user"), makeEvent("event-b-result")],
      "turn-c": [makeEvent("event-c-user"), makeEvent("event-c-result")],
      "turn-d": [makeEvent("event-d-user"), makeEvent("event-d-result")],
    } as const;
    let authoritativeChunks: Array<{
      readonly chunk_id: string;
      readonly function: string;
    }> = [...turnChunks["turn-a"], ...turnChunks["turn-b"]];
    let authoritativeEvents = [
      ...turnEvents["turn-a"],
      ...turnEvents["turn-b"],
    ];
    const loadFullTranscriptChunks = vi
      .spyOn(source, "loadFullTranscriptChunks")
      .mockImplementation(async () => authoritativeChunks as never);
    const loadCloudTurnIds = vi
      .spyOn(source, "loadCloudTurnIds")
      .mockResolvedValue(["turn-a", "turn-b"]);
    const loadCloudTurnWindows = vi
      .spyOn(source, "loadCloudTurnWindows")
      .mockImplementation(async (_sessionId, turnIds) =>
        turnIds.map((turnId) => ({
          turnId,
          chunks: turnChunks[turnId as keyof typeof turnChunks] as never,
        }))
      );
    processChunksRustMock.mockImplementation(async (chunks) => {
      if (chunks === authoritativeChunks) return authoritativeEvents;
      const turnId = Object.entries(turnChunks).find(
        ([, candidate]) => candidate[0]?.chunk_id === chunks[0]?.chunk_id
      )?.[0] as keyof typeof turnEvents | undefined;
      return turnId ? [...turnEvents[turnId]] : [];
    });
    store.set(sessionsAtom, [
      { ...SESSION, session_id: sessionId, orgId: "personal-org" },
    ]);

    await engine.runSyncPass();
    vi.setSystemTime(Date.now() + EXTERNAL_HISTORY_ACTIVITY_DEBOUNCE_MS + 1);
    await engine.runSyncPass();

    // One bounded pass advances the cadence counter.
    authoritativeChunks = [
      ...turnChunks["turn-a"],
      ...turnChunks["turn-b"],
      ...turnChunks["turn-c"],
    ];
    authoritativeEvents = [
      ...turnEvents["turn-a"],
      ...turnEvents["turn-b"],
      ...turnEvents["turn-c"],
    ];
    loadCloudTurnIds.mockResolvedValue(["turn-a", "turn-b", "turn-c"]);
    loadFullTranscriptChunks.mockClear();
    store.set(sessionsAtom, [
      {
        ...SESSION,
        session_id: sessionId,
        orgId: "personal-org",
        updated_at: "2026-08-04T15:01:00.000Z",
      },
    ]);
    await engine.runSyncPass();
    vi.setSystemTime(Date.now() + EXTERNAL_HISTORY_ACTIVITY_DEBOUNCE_MS + 1);
    await engine.runSyncPass();
    expect(loadFullTranscriptChunks).not.toHaveBeenCalled();
    const key = `corg-1:${sessionId}`;
    expect(
      store.get(org2CloudPushCursorsAtom)[key].importedReplay
        ?.incrementalPassCount
    ).toBe(1);

    // An exhausted budget declines the checkpoint: the next delta pays one
    // full authoritative read, still appends (intact prefix never rewrites),
    // and the fresh checkpoint restarts the cadence at zero.
    store.set(org2CloudPushCursorsAtom, (current) => {
      const cursor = current[key];
      return {
        ...current,
        [key]: {
          ...cursor,
          importedReplay: cursor.importedReplay && {
            ...cursor.importedReplay,
            incrementalPassCount: IMPORTED_INCREMENTAL_REANCHOR_EVERY,
          },
        },
      };
    });
    authoritativeChunks = [
      ...turnChunks["turn-a"],
      ...turnChunks["turn-b"],
      ...turnChunks["turn-c"],
      ...turnChunks["turn-d"],
    ];
    authoritativeEvents = [
      ...turnEvents["turn-a"],
      ...turnEvents["turn-b"],
      ...turnEvents["turn-c"],
      ...turnEvents["turn-d"],
    ];
    loadCloudTurnIds.mockResolvedValue([
      "turn-a",
      "turn-b",
      "turn-c",
      "turn-d",
    ]);
    loadFullTranscriptChunks.mockClear();
    client.rewriteSessionEvents.mockClear();
    client.appendSessionEvents.mockClear();
    store.set(sessionsAtom, [
      {
        ...SESSION,
        session_id: sessionId,
        orgId: "personal-org",
        updated_at: "2026-08-04T15:02:00.000Z",
      },
    ]);
    await engine.runSyncPass();
    vi.setSystemTime(Date.now() + EXTERNAL_HISTORY_ACTIVITY_DEBOUNCE_MS + 1);
    await engine.runSyncPass();

    expect(loadFullTranscriptChunks).toHaveBeenCalledTimes(1);
    expect(client.rewriteSessionEvents).not.toHaveBeenCalled();
    expect(client.appendSessionEvents).toHaveBeenCalledTimes(1);
    expect(
      client.appendSessionEvents.mock.calls[0][1].newFrozenSegments.flatMap(
        (segment: { events: unknown[] }) => segment.events
      )
    ).toEqual(turnEvents["turn-d"]);
    expect(
      store.get(org2CloudPushCursorsAtom)[key].importedReplay
        ?.incrementalPassCount
    ).toBe(0);

    loadFullTranscriptChunks.mockRestore();
    loadCloudTurnIds.mockRestore();
    loadCloudTurnWindows.mockRestore();
  });

  it("upgrades a pre-checkpoint flat cursor with a delta append, never an epoch rewrite", async () => {
    const sessionId = "cursoride-flat-migration-thread-1";
    type CloudReplaySource = ImportedHistorySource &
      Required<
        Pick<ImportedHistorySource, "loadCloudTurnIds" | "loadCloudTurnWindows">
      >;
    const source = getImportedHistorySourceBySessionId(
      sessionId
    ) as CloudReplaySource;
    const turnChunks = {
      "turn-a": [{ chunk_id: "raw-a", function: "user_message" }],
      "turn-b": [{ chunk_id: "raw-b", function: "user_message" }],
      "turn-c": [{ chunk_id: "raw-c", function: "user_message" }],
      "turn-d": [{ chunk_id: "raw-d", function: "user_message" }],
    } as const;
    const turnEvents = {
      "turn-a": [makeEvent("event-a-user"), makeEvent("event-a-result")],
      "turn-b": [makeEvent("event-b-user"), makeEvent("event-b-result")],
      "turn-c": [makeEvent("event-c-user"), makeEvent("event-c-result")],
      "turn-d": [makeEvent("event-d-user"), makeEvent("event-d-result")],
    } as const;
    let authoritativeChunks: Array<{
      readonly chunk_id: string;
      readonly function: string;
    }> = [...turnChunks["turn-a"], ...turnChunks["turn-b"]];
    let authoritativeEvents = [
      ...turnEvents["turn-a"],
      ...turnEvents["turn-b"],
    ];
    const loadFullTranscriptChunks = vi
      .spyOn(source, "loadFullTranscriptChunks")
      .mockImplementation(async () => authoritativeChunks as never);
    // Duplicate ids disable the anchor probe, so the first push persists a
    // pre-checkpoint flat-v1 cursor exactly like one written before this
    // feature existed.
    const loadCloudTurnIds = vi
      .spyOn(source, "loadCloudTurnIds")
      .mockResolvedValue(["turn-a", "turn-a"]);
    const loadCloudTurnWindows = vi
      .spyOn(source, "loadCloudTurnWindows")
      .mockImplementation(async (_sessionId, turnIds) =>
        turnIds.map((turnId) => ({
          turnId,
          chunks: turnChunks[turnId as keyof typeof turnChunks] as never,
        }))
      );
    processChunksRustMock.mockImplementation(async (chunks) => {
      if (chunks === authoritativeChunks) return authoritativeEvents;
      const turnId = Object.entries(turnChunks).find(
        ([, candidate]) => candidate[0]?.chunk_id === chunks[0]?.chunk_id
      )?.[0] as keyof typeof turnEvents | undefined;
      return turnId ? [...turnEvents[turnId]] : [];
    });
    store.set(sessionsAtom, [
      { ...SESSION, session_id: sessionId, orgId: "personal-org" },
    ]);

    await engine.runSyncPass();
    vi.setSystemTime(Date.now() + EXTERNAL_HISTORY_ACTIVITY_DEBOUNCE_MS + 1);
    await engine.runSyncPass();

    const flatCursor = store.get(org2CloudPushCursorsAtom)[
      `corg-1:${sessionId}`
    ];
    expect(flatCursor).toMatchObject({ epoch: 1, pushedCount: 4 });
    expect(flatCursor.importedReplay).toBeUndefined();
    expect(client.rewriteSessionEvents).toHaveBeenCalledTimes(1);

    // The probe recovers and one turn is appended. Migration to the merkle
    // checkpoint must ride the ordinary delta append: re-uploading the whole
    // intact history would spend O(total) network on every legacy cursor.
    authoritativeChunks = [
      ...turnChunks["turn-a"],
      ...turnChunks["turn-b"],
      ...turnChunks["turn-c"],
    ];
    authoritativeEvents = [
      ...turnEvents["turn-a"],
      ...turnEvents["turn-b"],
      ...turnEvents["turn-c"],
    ];
    loadCloudTurnIds.mockResolvedValue(["turn-a", "turn-b", "turn-c"]);
    client.rewriteSessionEvents.mockClear();
    client.appendSessionEvents.mockClear();
    store.set(sessionsAtom, [
      {
        ...SESSION,
        session_id: sessionId,
        orgId: "personal-org",
        updated_at: "2026-08-04T15:01:00.000Z",
      },
    ]);
    await engine.runSyncPass();
    vi.setSystemTime(Date.now() + EXTERNAL_HISTORY_ACTIVITY_DEBOUNCE_MS + 1);
    await engine.runSyncPass();

    expect(client.rewriteSessionEvents).not.toHaveBeenCalled();
    expect(client.appendSessionEvents).toHaveBeenCalledTimes(1);
    expect(client.appendSessionEvents.mock.calls[0][1]).toMatchObject({
      expectedEpoch: 1,
      totalCount: 6,
    });
    expect(
      client.appendSessionEvents.mock.calls[0][1].newFrozenSegments.flatMap(
        (segment) => segment.events
      )
    ).toEqual(turnEvents["turn-c"]);
    const upgraded = store.get(org2CloudPushCursorsAtom)[`corg-1:${sessionId}`];
    expect(upgraded).toMatchObject({ epoch: 1, pushedCount: 6 });
    expect(upgraded.importedReplay).toMatchObject({ reloadTurnId: "turn-c" });

    // The upgraded checkpoint must actually enable the bounded path.
    authoritativeChunks = [
      ...turnChunks["turn-a"],
      ...turnChunks["turn-b"],
      ...turnChunks["turn-c"],
      ...turnChunks["turn-d"],
    ];
    authoritativeEvents = [
      ...turnEvents["turn-a"],
      ...turnEvents["turn-b"],
      ...turnEvents["turn-c"],
      ...turnEvents["turn-d"],
    ];
    loadCloudTurnIds.mockResolvedValue([
      "turn-a",
      "turn-b",
      "turn-c",
      "turn-d",
    ]);
    loadFullTranscriptChunks.mockClear();
    client.appendSessionEvents.mockClear();
    store.set(sessionsAtom, [
      {
        ...SESSION,
        session_id: sessionId,
        orgId: "personal-org",
        updated_at: "2026-08-04T15:02:00.000Z",
      },
    ]);
    await engine.runSyncPass();
    vi.setSystemTime(Date.now() + EXTERNAL_HISTORY_ACTIVITY_DEBOUNCE_MS + 1);
    await engine.runSyncPass();

    expect(loadFullTranscriptChunks).not.toHaveBeenCalled();
    expect(client.rewriteSessionEvents).not.toHaveBeenCalled();
    expect(client.appendSessionEvents).toHaveBeenCalledTimes(1);
    expect(client.appendSessionEvents.mock.calls[0][1]).toMatchObject({
      totalCount: 8,
    });

    loadFullTranscriptChunks.mockRestore();
    loadCloudTurnIds.mockRestore();
    loadCloudTurnWindows.mockRestore();
  });

  it("keeps an intact history on the append path when the turn-id probe fails transiently", async () => {
    const sessionId = "cursoride-transient-probe-thread-1";
    type CloudReplaySource = ImportedHistorySource &
      Required<
        Pick<ImportedHistorySource, "loadCloudTurnIds" | "loadCloudTurnWindows">
      >;
    const source = getImportedHistorySourceBySessionId(
      sessionId
    ) as CloudReplaySource;
    const turnChunks = {
      "turn-a": [{ chunk_id: "raw-a", function: "user_message" }],
      "turn-b": [{ chunk_id: "raw-b", function: "user_message" }],
      "turn-c": [{ chunk_id: "raw-c", function: "user_message" }],
      "turn-d": [{ chunk_id: "raw-d", function: "user_message" }],
    } as const;
    const turnEvents = {
      "turn-a": [makeEvent("event-a-user"), makeEvent("event-a-result")],
      "turn-b": [makeEvent("event-b-user"), makeEvent("event-b-result")],
      "turn-c": [makeEvent("event-c-user"), makeEvent("event-c-result")],
      "turn-d": [makeEvent("event-d-user"), makeEvent("event-d-result")],
    } as const;
    let authoritativeChunks: Array<{
      readonly chunk_id: string;
      readonly function: string;
    }> = [...turnChunks["turn-a"], ...turnChunks["turn-b"]];
    let authoritativeEvents = [
      ...turnEvents["turn-a"],
      ...turnEvents["turn-b"],
    ];
    const loadFullTranscriptChunks = vi
      .spyOn(source, "loadFullTranscriptChunks")
      .mockImplementation(async () => authoritativeChunks as never);
    const loadCloudTurnIds = vi
      .spyOn(source, "loadCloudTurnIds")
      .mockResolvedValue(["turn-a", "turn-b"]);
    const loadCloudTurnWindows = vi
      .spyOn(source, "loadCloudTurnWindows")
      .mockImplementation(async (_sessionId, turnIds) =>
        turnIds.map((turnId) => ({
          turnId,
          chunks: turnChunks[turnId as keyof typeof turnChunks] as never,
        }))
      );
    processChunksRustMock.mockImplementation(async (chunks) => {
      if (chunks === authoritativeChunks) return authoritativeEvents;
      const turnId = Object.entries(turnChunks).find(
        ([, candidate]) => candidate[0]?.chunk_id === chunks[0]?.chunk_id
      )?.[0] as keyof typeof turnEvents | undefined;
      return turnId ? [...turnEvents[turnId]] : [];
    });
    store.set(sessionsAtom, [
      { ...SESSION, session_id: sessionId, orgId: "personal-org" },
    ]);

    await engine.runSyncPass();
    vi.setSystemTime(Date.now() + EXTERNAL_HISTORY_ACTIVITY_DEBOUNCE_MS + 1);
    await engine.runSyncPass();
    expect(
      store.get(org2CloudPushCursorsAtom)[`corg-1:${sessionId}`].importedReplay
    ).toBeDefined();
    expect(client.rewriteSessionEvents).toHaveBeenCalledTimes(1);

    // One turn is appended while the id probe fails for the whole pass (the
    // incremental attempt and the full-path re-anchor both reject). A read
    // hiccup is not evidence of history mutation: the pass must fall back to
    // one full READ and a delta append, never a full re-UPLOAD.
    authoritativeChunks = [
      ...turnChunks["turn-a"],
      ...turnChunks["turn-b"],
      ...turnChunks["turn-c"],
    ];
    authoritativeEvents = [
      ...turnEvents["turn-a"],
      ...turnEvents["turn-b"],
      ...turnEvents["turn-c"],
    ];
    loadCloudTurnIds
      .mockRejectedValueOnce(new Error("transient: source db is locked"))
      .mockRejectedValueOnce(new Error("transient: source db is locked"));
    loadFullTranscriptChunks.mockClear();
    client.rewriteSessionEvents.mockClear();
    client.appendSessionEvents.mockClear();
    store.set(sessionsAtom, [
      {
        ...SESSION,
        session_id: sessionId,
        orgId: "personal-org",
        updated_at: "2026-08-04T15:01:00.000Z",
      },
    ]);
    await engine.runSyncPass();
    vi.setSystemTime(Date.now() + EXTERNAL_HISTORY_ACTIVITY_DEBOUNCE_MS + 1);
    await engine.runSyncPass();

    expect(loadFullTranscriptChunks).toHaveBeenCalledTimes(1);
    expect(client.rewriteSessionEvents).not.toHaveBeenCalled();
    expect(client.appendSessionEvents).toHaveBeenCalledTimes(1);
    expect(
      client.appendSessionEvents.mock.calls[0][1].newFrozenSegments.flatMap(
        (segment) => segment.events
      )
    ).toEqual(turnEvents["turn-c"]);
    // Without a probe there is no checkpoint to carry: the cursor downgrades
    // to flat-v1 consistently instead of keeping a stale merkle checkpoint.
    const downgraded = store.get(org2CloudPushCursorsAtom)[
      `corg-1:${sessionId}`
    ];
    expect(downgraded).toMatchObject({ epoch: 1, pushedCount: 6 });
    expect(downgraded.importedReplay).toBeUndefined();

    // Once the probe recovers, the next delta re-anchors the checkpoint —
    // again via the ordinary append, with no rewrite anywhere in the cycle.
    authoritativeChunks = [
      ...turnChunks["turn-a"],
      ...turnChunks["turn-b"],
      ...turnChunks["turn-c"],
      ...turnChunks["turn-d"],
    ];
    authoritativeEvents = [
      ...turnEvents["turn-a"],
      ...turnEvents["turn-b"],
      ...turnEvents["turn-c"],
      ...turnEvents["turn-d"],
    ];
    loadCloudTurnIds.mockResolvedValue([
      "turn-a",
      "turn-b",
      "turn-c",
      "turn-d",
    ]);
    client.appendSessionEvents.mockClear();
    store.set(sessionsAtom, [
      {
        ...SESSION,
        session_id: sessionId,
        orgId: "personal-org",
        updated_at: "2026-08-04T15:02:00.000Z",
      },
    ]);
    await engine.runSyncPass();
    vi.setSystemTime(Date.now() + EXTERNAL_HISTORY_ACTIVITY_DEBOUNCE_MS + 1);
    await engine.runSyncPass();

    expect(client.rewriteSessionEvents).not.toHaveBeenCalled();
    expect(client.appendSessionEvents).toHaveBeenCalledTimes(1);
    const reanchored = store.get(org2CloudPushCursorsAtom)[
      `corg-1:${sessionId}`
    ];
    expect(reanchored).toMatchObject({ epoch: 1, pushedCount: 8 });
    expect(reanchored.importedReplay).toMatchObject({ reloadTurnId: "turn-d" });

    loadFullTranscriptChunks.mockRestore();
    loadCloudTurnIds.mockRestore();
    loadCloudTurnWindows.mockRestore();
  });

  it("survives a JSON persistence round trip of the imported replay checkpoint", async () => {
    const sessionId = "cursoride-roundtrip-thread-1";
    type CloudReplaySource = ImportedHistorySource &
      Required<
        Pick<ImportedHistorySource, "loadCloudTurnIds" | "loadCloudTurnWindows">
      >;
    const source = getImportedHistorySourceBySessionId(
      sessionId
    ) as CloudReplaySource;
    const turnChunks = {
      "turn-a": [{ chunk_id: "raw-a", function: "user_message" }],
      "turn-b": [{ chunk_id: "raw-b", function: "user_message" }],
      "turn-c": [{ chunk_id: "raw-c", function: "user_message" }],
    } as const;
    const turnEvents = {
      "turn-a": [makeEvent("event-a-user"), makeEvent("event-a-result")],
      "turn-b": [makeEvent("event-b-user"), makeEvent("event-b-result")],
      "turn-c": [makeEvent("event-c-user"), makeEvent("event-c-result")],
    } as const;
    let authoritativeChunks: Array<{
      readonly chunk_id: string;
      readonly function: string;
    }> = [...turnChunks["turn-a"], ...turnChunks["turn-b"]];
    let authoritativeEvents = [
      ...turnEvents["turn-a"],
      ...turnEvents["turn-b"],
    ];
    const loadFullTranscriptChunks = vi
      .spyOn(source, "loadFullTranscriptChunks")
      .mockImplementation(async () => authoritativeChunks as never);
    const loadCloudTurnIds = vi
      .spyOn(source, "loadCloudTurnIds")
      .mockResolvedValue(["turn-a", "turn-b"]);
    const loadCloudTurnWindows = vi
      .spyOn(source, "loadCloudTurnWindows")
      .mockImplementation(async (_sessionId, turnIds) =>
        turnIds.map((turnId) => ({
          turnId,
          chunks: turnChunks[turnId as keyof typeof turnChunks] as never,
        }))
      );
    processChunksRustMock.mockImplementation(async (chunks) => {
      if (chunks === authoritativeChunks) return authoritativeEvents;
      const turnId = Object.entries(turnChunks).find(
        ([, candidate]) => candidate[0]?.chunk_id === chunks[0]?.chunk_id
      )?.[0] as keyof typeof turnEvents | undefined;
      return turnId ? [...turnEvents[turnId]] : [];
    });
    store.set(sessionsAtom, [
      { ...SESSION, session_id: sessionId, orgId: "personal-org" },
    ]);

    await engine.runSyncPass();
    vi.setSystemTime(Date.now() + EXTERNAL_HISTORY_ACTIVITY_DEBOUNCE_MS + 1);
    await engine.runSyncPass();
    expect(
      store.get(org2CloudPushCursorsAtom)[`corg-1:${sessionId}`].importedReplay
    ).toBeDefined();

    // The merkle frontier is built with array holes at even heights; the
    // storage layer persists them as JSON null. The commitment recomputed
    // from the reloaded null form must still match the stored chain hash,
    // otherwise every app restart silently loses the bounded path.
    store.set(
      org2CloudPushCursorsAtom,
      JSON.parse(JSON.stringify(store.get(org2CloudPushCursorsAtom)))
    );

    authoritativeChunks = [
      ...turnChunks["turn-a"],
      ...turnChunks["turn-b"],
      ...turnChunks["turn-c"],
    ];
    authoritativeEvents = [
      ...turnEvents["turn-a"],
      ...turnEvents["turn-b"],
      ...turnEvents["turn-c"],
    ];
    loadCloudTurnIds.mockResolvedValue(["turn-a", "turn-b", "turn-c"]);
    loadFullTranscriptChunks.mockClear();
    client.appendSessionEvents.mockClear();
    store.set(sessionsAtom, [
      {
        ...SESSION,
        session_id: sessionId,
        orgId: "personal-org",
        updated_at: "2026-08-04T15:01:00.000Z",
      },
    ]);
    await engine.runSyncPass();
    vi.setSystemTime(Date.now() + EXTERNAL_HISTORY_ACTIVITY_DEBOUNCE_MS + 1);
    await engine.runSyncPass();

    expect(loadFullTranscriptChunks).not.toHaveBeenCalled();
    expect(client.appendSessionEvents).toHaveBeenCalledTimes(1);
    expect(client.appendSessionEvents.mock.calls[0][1]).toMatchObject({
      totalCount: 6,
    });

    loadFullTranscriptChunks.mockRestore();
    loadCloudTurnIds.mockRestore();
    loadCloudTurnWindows.mockRestore();
  });

  it("publishes a roster-refreshed external replay in an inactive background org after one quiet timer", async () => {
    const sessionId = "codexapp-background-thread-1";
    const source = getImportedHistorySourceBySessionId(sessionId);
    const loadFullTranscriptChunks = vi
      .spyOn(source!, "loadFullTranscriptChunks")
      .mockResolvedValue([] as never);
    store.set(sidebarActiveCloudOrgIdAtom, null);
    store.set(org2CloudOrgsAtom, [
      {
        orgId: "corg-1",
        name: "Cloud Team",
        role: "member",
        offlineSyncEnabled: true,
      },
    ]);

    // Drain the startup pass and isolate the sessionsAtom-driven trigger.
    await vi.advanceTimersByTimeAsync(0);
    await engine.runSyncPassAndWaitForDrain();
    client.upsertSessionMetadata.mockClear();
    client.rewriteSessionEvents.mockClear();
    loadFullTranscriptChunks.mockClear();
    let markBackgroundUpserted!: () => void;
    const backgroundUpserted = new Promise<void>((resolve) => {
      markBackgroundUpserted = resolve;
    });
    client.upsertSessionMetadata.mockImplementation(async () => {
      markBackgroundUpserted();
    });

    store.set(sessionsAtom, [
      {
        ...SESSION,
        session_id: sessionId,
        orgId: "personal-org",
        updated_at: "2026-08-04T15:00:00.000Z",
      },
    ]);

    await vi.advanceTimersByTimeAsync(
      EXTERNAL_HISTORY_ACTIVITY_DEBOUNCE_MS - 1
    );
    expect(client.upsertSessionMetadata).not.toHaveBeenCalled();
    expect(loadFullTranscriptChunks).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2);
    await backgroundUpserted;
    expect(client.upsertSessionMetadata).toHaveBeenCalledTimes(1);
    expect(client.upsertSessionMetadata.mock.calls[0][2]).toBe(sessionId);
    expect(loadFullTranscriptChunks).toHaveBeenCalledWith(sessionId);

    const passCount = engine.startedPassCount;
    engine.stop();
    store.set(sessionsAtom, [
      {
        ...SESSION,
        session_id: sessionId,
        orgId: "personal-org",
        updated_at: "2026-08-04T15:01:00.000Z",
      },
    ]);
    await vi.advanceTimersByTimeAsync(EXTERNAL_HISTORY_ACTIVITY_DEBOUNCE_MS);
    expect(engine.startedPassCount).toBe(passCount);
  });

  it("seeds unchanged external replay state from the server after restart", async () => {
    const sessionId = "cursoride-thread-1";
    const source = getImportedHistorySourceBySessionId(sessionId);
    const loadFullTranscriptChunks = vi
      .spyOn(source!, "loadFullTranscriptChunks")
      .mockResolvedValue([{ id: "cursor-chunk" }] as never);
    processChunksRustMock.mockResolvedValue([makeEvent("cursor-event")]);
    store.set(sessionsAtom, [
      { ...SESSION, session_id: sessionId, orgId: "personal-org" },
    ]);

    await engine.runSyncPass();
    vi.setSystemTime(Date.now() + EXTERNAL_HISTORY_ACTIVITY_DEBOUNCE_MS + 1);
    await engine.runSyncPass();

    const metadata = client.upsertSessionMetadata.mock.calls[0][3];
    const cursor = store.get(org2CloudPushCursorsAtom)[`corg-1:${sessionId}`];
    expect(cursor).toBeDefined();

    engine.stop();
    client.listOrgSessions.mockResolvedValue({
      serverTime: "2026-07-01T12:01:00.000Z",
      sessions: [
        {
          ...metadata,
          eventsEpoch: cursor.epoch,
          eventsFrozenSeq: cursor.frozenSeq,
          eventsCount: cursor.pushedCount,
          eventsTailHash: cursor.tailHash ?? undefined,
        },
      ],
    });
    client.upsertSessionMetadata.mockClear();
    client.rewriteSessionEvents.mockClear();
    client.appendSessionEvents.mockClear();
    loadFullTranscriptChunks.mockClear();
    processChunksRustMock.mockClear();

    engine = new Org2CloudSyncEngine(client, projectsClient, bridge);
    engine.start(store);
    await engine.runSyncPass();

    expect(client.listOrgSessions).toHaveBeenCalledWith("jwt-1", "corg-1");
    expect(client.upsertSessionMetadata).not.toHaveBeenCalled();
    expect(loadFullTranscriptChunks).not.toHaveBeenCalled();
    expect(processChunksRustMock).not.toHaveBeenCalled();
    expect(client.rewriteSessionEvents).not.toHaveBeenCalled();
    expect(client.appendSessionEvents).not.toHaveBeenCalled();

    store.set(sessionsAtom, [
      {
        ...SESSION,
        session_id: sessionId,
        orgId: "personal-org",
        updated_at: "2026-07-01T12:02:00.000Z",
      },
    ]);
    await engine.runSyncPass();
    expect(client.upsertSessionMetadata).not.toHaveBeenCalled();
    expect(loadFullTranscriptChunks).not.toHaveBeenCalled();
    expect(processChunksRustMock).not.toHaveBeenCalled();

    vi.setSystemTime(Date.now() + EXTERNAL_HISTORY_ACTIVITY_DEBOUNCE_MS + 1);
    await engine.runSyncPass();
    expect(client.upsertSessionMetadata).toHaveBeenCalledTimes(1);
    expect(loadFullTranscriptChunks).toHaveBeenCalledTimes(1);
    expect(processChunksRustMock).toHaveBeenCalledTimes(1);
  });

  it("the floor still lifts imported history the user explicitly shared", async () => {
    const source = getImportedHistorySourceBySessionId("cursoride-thread-1");
    vi.spyOn(source!, "loadFullTranscriptChunks").mockResolvedValue(
      [] as never
    );
    store.set(org2CloudAccessSettingsAtom, {
      "corg-1": {
        sessionModes: { "cursoride-thread-1": "metadata_only" },
        sessionVisibility: {},
      },
    });
    store.set(org2CloudSharingFloorAtom, { "corg-1": "full_replay" });
    store.set(sessionsAtom, [
      { ...SESSION, session_id: "cursoride-thread-1", orgId: "personal-org" },
    ]);

    await engine.runSyncPass();

    expect(client.upsertSessionMetadata).not.toHaveBeenCalled();

    vi.setSystemTime(Date.now() + EXTERNAL_HISTORY_ACTIVITY_DEBOUNCE_MS + 1);
    await engine.runSyncPass();

    expect(client.upsertSessionMetadata).toHaveBeenCalledTimes(1);
    expect(client.upsertSessionMetadata.mock.calls[0][3].accessMode).toBe(
      "full_replay"
    );
  });

  it("floors a tagged effective-off session to metadata_only (never 'off' on the wire, no segments)", async () => {
    store.set(org2CloudAccessSettingsAtom, {});
    store.set(org2CloudSharingFloorAtom, {});
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

  it("honors a per-session mode and restricted visibility on every push", async () => {
    store.set(org2CloudAccessSettingsAtom, {
      "corg-1": {
        sessionModes: { "session-1": "metadata_only" },
        sessionVisibility: { "session-1": "restricted" },
      },
    });
    store.set(org2CloudSharingFloorAtom, {});
    await engine.runSyncPass();

    expect(client.upsertSessionMetadata).toHaveBeenCalledTimes(1);
    const metadata = client.upsertSessionMetadata.mock.calls[0][3];
    expect(metadata.accessMode).toBe("metadata_only");
    expect(metadata.visibility).toBe("restricted");
    expect(client.rewriteSessionEvents).not.toHaveBeenCalled();
  });

  it("a full-replay minimum lifts a stale per-session off value", async () => {
    store.set(org2CloudAccessSettingsAtom, {
      "corg-1": {
        sessionModes: { "session-1": "off" },
        sessionVisibility: {},
      },
    });
    await engine.runSyncPass();
    expect(client.upsertSessionMetadata).toHaveBeenCalledTimes(1);
    expect(client.upsertSessionMetadata.mock.calls[0][3].accessMode).toBe(
      "full_replay"
    );
    expect(client.rewriteSessionEvents).toHaveBeenCalledTimes(1);
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

  it("publishes a multi-tagged session only to the active org", async () => {
    store.set(org2CloudOrgsAtom, [
      { orgId: "corg-1", name: "Cloud Team", role: "member" },
      { orgId: "corg-2", name: "Other Team", role: "member" },
    ]);
    store.set(org2CloudRepoScopesAtom, {
      "corg-1": [SCOPE_KEY],
      "corg-2": [SCOPE_KEY],
    });
    store.set(org2CloudAccessSettingsAtom, {
      "corg-1": {
        sessionModes: {},
        sessionVisibility: {},
      },
      "corg-2": {
        sessionModes: {},
        sessionVisibility: {},
      },
    });
    store.set(org2CloudSharingFloorAtom, {
      "corg-1": "full_replay",
      "corg-2": "full_replay",
    });
    store.set(sessionOrgTagsAtom, {
      "session-1": [cloudOrgToken("corg-1"), cloudOrgToken("corg-2")],
    });

    await engine.runSyncPass();

    expect(client.rewriteSessionEvents).toHaveBeenCalledTimes(1);
    expect(client.rewriteSessionEvents.mock.calls[0][1].orgId).toBe("corg-1");
    expect(eventStoreMock.getPersistedEvents).toHaveBeenCalledTimes(1);
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
        sessionModes: { "session-1": "off" },
        sessionVisibility: {},
      },
    });
    store.set(org2CloudSharingFloorAtom, {});
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
    // No minimum and no override: an Off session is a
    // pure skip — no spurious server delete.
    store.set(org2CloudAccessSettingsAtom, {});
    store.set(org2CloudSharingFloorAtom, {});
    await engine.runSyncPass();
    expect(client.upsertSessionMetadata).not.toHaveBeenCalled();
    expect(client.deleteSession).not.toHaveBeenCalled();
  });

  it("retracts a metadata_only session dropped to Off in a LATER run (persisted marker)", async () => {
    // Run 1: metadata_only push leaves NO segments cursor — only the
    // persisted push marker records that a live row exists.
    store.set(org2CloudAccessSettingsAtom, {});
    store.set(org2CloudSharingFloorAtom, { "corg-1": "metadata_only" });
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
    engine = new Org2CloudSyncEngine(client, projectsClient, bridge);
    engine.start(store);

    // Admin lowers the minimum to Off. The retract must fire off the
    // persisted marker even though nothing was pushed in THIS run.
    store.set(org2CloudAccessSettingsAtom, {});
    store.set(org2CloudSharingFloorAtom, {});
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
    store.set(org2CloudSharingFloorAtom, {});
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
});
