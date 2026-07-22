import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  externalReplayCloudPrefixHashMock,
  externalReplayCloudPrepareMock,
  externalReplayCloudReadBatchMock,
  externalReplayCloudReleaseMock,
  makeEvent,
  messageMock,
  notifySessionEvents,
  peekMock,
  primeMock,
  resolveSecondaryReplayTargetMock,
} from "./org2CloudSyncEngine.testUtils";
import type { EngineFixture } from "./org2CloudSyncEngine.testUtils";

const {
  EXTERNAL_HISTORY_ACTIVITY_DEBOUNCE_MS,
  ORG_BACKOFF_COOLDOWN_MS,
  PERSONAL_EXCLUDED_TOKEN,
  Org2CloudSyncEngine,
  Org2CloudSyncError,
  chatPanelSelectedCloudOrgAtom,
  cloudOrgToken,
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

  it("publishes Cursor through the Rust spool without any legacy full-history loader", async () => {
    store.set(org2CloudAccessSettingsAtom, {});
    store.set(org2CloudSharingFloorAtom, { "corg-1": "full_replay" });
    store.set(sessionsAtom, [
      { ...SESSION, session_id: "cursoride-thread-1", orgId: "personal-org" },
    ]);

    await engine.runSyncPass();

    expect(externalReplayCloudPrepareMock).not.toHaveBeenCalled();

    vi.setSystemTime(Date.now() + EXTERNAL_HISTORY_ACTIVITY_DEBOUNCE_MS + 1);
    await engine.runSyncPass();

    expect(externalReplayCloudPrepareMock).toHaveBeenCalledTimes(1);
    expect(externalReplayCloudPrepareMock).toHaveBeenCalledWith(
      "cursoride-thread-1"
    );
    expect(eventStoreMock.getPersistedEvents).not.toHaveBeenCalledWith(
      "cursoride-thread-1"
    );
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
    expect(resolveSecondaryReplayTargetMock).not.toHaveBeenCalled();
    expect(eventStoreMock.getPersistedEvents).toHaveBeenCalledWith("session-1");

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

  it("publishes a snapshot-backed native fork through the Rust spool without hydrating EventStore", async () => {
    const fork = {
      ...SESSION,
      session_id: "agentsession-cloud-fork",
      forkedFrom: {
        orgId: "corg-1",
        sourceSessionId: "session-source",
        ownerMemberId: "user-owner",
        ownerDisplayName: "Owner",
        atCount: 2,
        forkedAt: "2026-07-02T00:00:00.000Z",
      },
    };
    resolveSecondaryReplayTargetMock.mockResolvedValueOnce({
      sourceId: "collaboration_snapshot",
      sessionId: fork.session_id,
    });
    store.set(sessionsAtom, [fork]);

    await engine.runSyncPass();

    expect(resolveSecondaryReplayTargetMock).toHaveBeenCalledWith(
      fork.session_id
    );
    expect(externalReplayCloudPrepareMock).toHaveBeenCalledWith(
      fork.session_id
    );
    expect(eventStoreMock.getPersistedEvents).not.toHaveBeenCalledWith(
      fork.session_id
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

    expect(client.getSessionEvents).toHaveBeenCalledWith(
      "jwt-1",
      "corg-1",
      "session-1",
      {
        boundedWirePage: true,
        cursor: { direction: "backward" },
        includeTail: false,
        maxSegments: 1,
        maxWireBytes: 64 * 1024,
      }
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

  it("hydrates and publishes the session plane only for the active org", async () => {
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
    store.set(org2CloudAccessSettingsAtom, {});
    store.set(org2CloudSharingFloorAtom, { "corg-1": "full_replay" });
    store.set(sessionsAtom, [
      { ...SESSION, session_id: "cursoride-thread-1", orgId: "personal-org" },
    ]);

    await engine.runSyncPass();

    expect(client.upsertSessionMetadata).not.toHaveBeenCalled();
    expect(externalReplayCloudPrepareMock).not.toHaveBeenCalled();

    vi.setSystemTime(Date.now() + EXTERNAL_HISTORY_ACTIVITY_DEBOUNCE_MS + 1);
    await engine.runSyncPass();

    expect(client.upsertSessionMetadata).toHaveBeenCalledTimes(1);
    expect(client.upsertSessionMetadata.mock.calls[0][3].accessMode).toBe(
      "full_replay"
    );
    expect(externalReplayCloudPrepareMock).toHaveBeenCalledWith(
      "cursoride-thread-1"
    );
  });

  it("waits for a quiet window before preparing a changing external replay", async () => {
    store.set(sessionsAtom, [
      { ...SESSION, session_id: "cursoride-thread-1", orgId: "personal-org" },
    ]);
    notifySessionEvents("cursoride-thread-1");

    await engine.runSyncPass();

    expect(client.upsertSessionMetadata).not.toHaveBeenCalled();
    expect(externalReplayCloudPrepareMock).not.toHaveBeenCalled();
    expect(eventStoreMock.getPersistedEvents).not.toHaveBeenCalledWith(
      "cursoride-thread-1"
    );

    vi.setSystemTime(Date.now() + EXTERNAL_HISTORY_ACTIVITY_DEBOUNCE_MS + 1);
    await engine.runSyncPass();

    expect(client.upsertSessionMetadata).toHaveBeenCalledTimes(1);
    expect(externalReplayCloudPrepareMock).toHaveBeenCalledTimes(1);
    expect(eventStoreMock.getPersistedEvents).not.toHaveBeenCalledWith(
      "cursoride-thread-1"
    );
  });

  it("seeds unchanged external replay state from the server after restart", async () => {
    const sessionId = "cursoride-thread-1";
    externalReplayCloudPrepareMock.mockResolvedValue({
      token: "restart-external-spool",
      generation: "g1",
      totalCount: 1,
      frozenEventCount: 1,
      tailEventCount: 0,
      frozenChainHash: "restart-chain",
      tailHash: null,
    });
    externalReplayCloudReadBatchMock.mockResolvedValue({
      segments: [
        {
          payloadGz: "restart-wire",
          eventCount: 1,
          segmentHash: "restart-segment",
          wireBytes: 100,
        },
      ],
      startEventIndex: 0,
      nextEventIndex: 1,
      startSegmentIndex: 0,
      nextSegmentIndex: 1,
      eof: true,
      serializedBytes: 100,
    });
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
    client.rewriteSessionEventWires.mockClear();
    client.appendSessionEventWires.mockClear();
    externalReplayCloudPrepareMock.mockClear();
    externalReplayCloudReadBatchMock.mockClear();
    externalReplayCloudPrefixHashMock.mockClear();
    eventStoreMock.getPersistedEvents.mockClear();

    engine = new Org2CloudSyncEngine(client, projectsClient, bridge);
    engine.start(store);
    await engine.runSyncPass();

    expect(client.listOrgSessions).toHaveBeenCalledWith("jwt-1", "corg-1");
    expect(client.upsertSessionMetadata).not.toHaveBeenCalled();
    expect(externalReplayCloudPrepareMock).not.toHaveBeenCalled();
    expect(eventStoreMock.getPersistedEvents).not.toHaveBeenCalledWith(
      sessionId
    );
    expect(client.rewriteSessionEventWires).not.toHaveBeenCalled();
    expect(client.appendSessionEventWires).not.toHaveBeenCalled();

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
    expect(externalReplayCloudPrepareMock).not.toHaveBeenCalled();
    expect(eventStoreMock.getPersistedEvents).not.toHaveBeenCalledWith(
      sessionId
    );

    vi.setSystemTime(Date.now() + EXTERNAL_HISTORY_ACTIVITY_DEBOUNCE_MS + 1);
    await engine.runSyncPass();
    expect(client.upsertSessionMetadata).toHaveBeenCalledTimes(1);
    expect(externalReplayCloudPrepareMock).toHaveBeenCalledTimes(1);
    expect(eventStoreMock.getPersistedEvents).not.toHaveBeenCalledWith(
      sessionId
    );
  });

  it("the floor still lifts imported history the user explicitly shared", async () => {
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
    expect(externalReplayCloudPrepareMock).toHaveBeenCalledWith(
      "cursoride-thread-1"
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

  it("uploads one bounded external spool only to the active org", async () => {
    const events = [makeEvent("x1"), makeEvent("x2"), makeEvent("x3")];
    externalReplayCloudPrepareMock.mockResolvedValueOnce({
      token: "shared-external-spool",
      generation: "g1",
      totalCount: 3,
      frozenEventCount: 3,
      tailEventCount: 0,
      frozenChainHash: "chain-3",
      tailHash: null,
    });
    externalReplayCloudReadBatchMock.mockImplementation(
      async ({ startEventIndex, endEventIndex }) => ({
        segments:
          startEventIndex < endEventIndex
            ? [
                {
                  payloadGz: `wire-${events[startEventIndex]?.id}`,
                  eventCount: 1,
                  segmentHash: `hash-${events[startEventIndex]?.id}`,
                  wireBytes: 100,
                },
              ]
            : [],
        startEventIndex,
        nextEventIndex: Math.min(startEventIndex + 1, endEventIndex),
        startSegmentIndex: startEventIndex,
        nextSegmentIndex: startEventIndex + 1,
        eof: startEventIndex + 1 >= endEventIndex,
        serializedBytes: 100,
      })
    );
    store.set(org2CloudOrgsAtom, [
      { orgId: "corg-1", name: "Cloud Team", role: "member" },
      { orgId: "corg-2", name: "Other Team", role: "member" },
    ]);
    store.set(org2CloudRepoScopesAtom, {
      "corg-1": [SCOPE_KEY],
      "corg-2": [SCOPE_KEY],
    });
    store.set(org2CloudAccessSettingsAtom, {
      "corg-1": { sessionModes: {}, sessionVisibility: {} },
      "corg-2": { sessionModes: {}, sessionVisibility: {} },
    });
    store.set(org2CloudSharingFloorAtom, {
      "corg-1": "full_replay",
      "corg-2": "full_replay",
    });
    store.set(sessionOrgTagsAtom, {
      "cursoride-thread-1": [cloudOrgToken("corg-1"), cloudOrgToken("corg-2")],
    });
    store.set(sessionsAtom, [
      { ...SESSION, session_id: "cursoride-thread-1", orgId: "personal-org" },
    ]);

    await engine.runSyncPass();

    expect(externalReplayCloudPrepareMock).not.toHaveBeenCalled();

    vi.setSystemTime(Date.now() + EXTERNAL_HISTORY_ACTIVITY_DEBOUNCE_MS + 1);
    await engine.runSyncPass();

    expect(externalReplayCloudPrepareMock).toHaveBeenCalledTimes(1);
    expect(externalReplayCloudReadBatchMock).toHaveBeenCalledTimes(3);
    expect(client.rewriteSessionEventWires).toHaveBeenCalledTimes(1);
    expect(client.appendSessionEventWires).toHaveBeenCalledTimes(2);
    expect(eventStoreMock.getPersistedEvents).not.toHaveBeenCalledWith(
      "cursoride-thread-1"
    );
    expect(client.rewriteSessionEventWires.mock.calls[0]?.[1].orgId).toBe(
      "corg-1"
    );
    for (const [, input] of client.appendSessionEventWires.mock.calls) {
      expect(input.orgId).toBe("corg-1");
    }
    for (const [, input] of client.rewriteSessionEventWires.mock.calls) {
      expect(input.frozenSegments).toHaveLength(1);
    }
    for (const [, input] of client.appendSessionEventWires.mock.calls) {
      expect(input.newFrozenSegments).toHaveLength(1);
    }
  });

  it("keeps nine active-org external session spools independently bounded", async () => {
    const sessionIds = Array.from(
      { length: 9 },
      (_, index) => `cursoride-thread-${index + 1}`
    );
    externalReplayCloudPrepareMock.mockImplementation(async (sessionId) => ({
      token: `nine-spool-${sessionId}`,
      generation: `generation-${sessionId}`,
      totalCount: 1,
      frozenEventCount: 1,
      tailEventCount: 0,
      frozenChainHash: `chain-${sessionId}`,
      tailHash: null,
    }));
    externalReplayCloudReadBatchMock.mockImplementation(
      async ({ token, startEventIndex, endEventIndex }) => ({
        segments: [
          {
            payloadGz: `wire-${token}`,
            eventCount: 1,
            segmentHash: `hash-${token}`,
            wireBytes: 100,
          },
        ],
        startEventIndex,
        nextEventIndex: endEventIndex,
        startSegmentIndex: 0,
        nextSegmentIndex: 1,
        eof: true,
        serializedBytes: 100,
      })
    );
    store.set(org2CloudOrgsAtom, [
      { orgId: "corg-1", name: "Cloud Team", role: "member" },
      { orgId: "corg-2", name: "Other Team", role: "member" },
    ]);
    store.set(org2CloudRepoScopesAtom, {
      "corg-1": [SCOPE_KEY],
      "corg-2": [SCOPE_KEY],
    });
    store.set(org2CloudAccessSettingsAtom, {
      "corg-1": { sessionModes: {}, sessionVisibility: {} },
      "corg-2": { sessionModes: {}, sessionVisibility: {} },
    });
    store.set(org2CloudSharingFloorAtom, {
      "corg-1": "full_replay",
      "corg-2": "full_replay",
    });
    store.set(
      sessionOrgTagsAtom,
      Object.fromEntries(
        sessionIds.map((sessionId) => [
          sessionId,
          [cloudOrgToken("corg-1"), cloudOrgToken("corg-2")],
        ])
      )
    );
    store.set(
      sessionsAtom,
      sessionIds.map((sessionId) => ({
        ...SESSION,
        session_id: sessionId,
        orgId: "personal-org",
      }))
    );

    await engine.runSyncPass();

    expect(externalReplayCloudPrepareMock).not.toHaveBeenCalled();

    vi.setSystemTime(Date.now() + EXTERNAL_HISTORY_ACTIVITY_DEBOUNCE_MS + 1);
    await engine.runSyncPass();

    expect(externalReplayCloudPrepareMock).toHaveBeenCalledTimes(9);
    expect(externalReplayCloudReadBatchMock).toHaveBeenCalledTimes(9);
    expect(client.rewriteSessionEventWires).toHaveBeenCalledTimes(9);
    expect(
      client.rewriteSessionEventWires.mock.calls.every(
        ([, input]) => input.orgId === "corg-1"
      )
    ).toBe(true);
    for (const sessionId of sessionIds) {
      const token = `nine-spool-${sessionId}`;
      expect(
        externalReplayCloudReadBatchMock.mock.calls.filter(
          ([options]) => options.token === token
        )
      ).toHaveLength(1);
    }

    engine.stop();
    await Promise.resolve();
    await Promise.resolve();
    for (const sessionId of sessionIds) {
      expect(
        externalReplayCloudReleaseMock.mock.calls.filter(
          ([token]) => token === `nine-spool-${sessionId}`
        )
      ).toHaveLength(1);
    }
  });

  it("publishes a tail-only external spool without treating the tail as frozen", async () => {
    externalReplayCloudPrepareMock.mockResolvedValueOnce({
      token: "tail-only-external-spool",
      generation: "g1",
      totalCount: 1,
      frozenEventCount: 0,
      tailEventCount: 1,
      frozenChainHash:
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      tailHash: "tail-hash",
    });
    externalReplayCloudReadBatchMock.mockResolvedValueOnce({
      segments: [
        {
          payloadGz: "tail-wire",
          eventCount: 1,
          segmentHash: "tail-hash",
          wireBytes: 100,
        },
      ],
      startEventIndex: 0,
      nextEventIndex: 1,
      startSegmentIndex: 0,
      nextSegmentIndex: 1,
      eof: true,
      serializedBytes: 100,
    });
    store.set(sessionsAtom, [
      { ...SESSION, session_id: "cursoride-thread-1", orgId: "personal-org" },
    ]);

    await engine.runSyncPass();
    vi.setSystemTime(Date.now() + EXTERNAL_HISTORY_ACTIVITY_DEBOUNCE_MS + 1);
    await engine.runSyncPass();

    const rewrite = client.rewriteSessionEventWires.mock.calls[0]?.[1];
    expect(rewrite?.frozenSegments).toEqual([]);
    expect(rewrite?.tail).toMatchObject({
      payloadGz: "tail-wire",
      eventCount: 1,
      segmentHash: "tail-hash",
    });
    expect(rewrite?.totalCount).toBe(1);
  });

  it("re-anchors an external staged rewrite after a bounded append conflict", async () => {
    const events = [makeEvent("x1"), makeEvent("x2")];
    externalReplayCloudPrepareMock.mockResolvedValueOnce({
      token: "conflict-external-spool",
      generation: "g1",
      totalCount: 2,
      frozenEventCount: 2,
      tailEventCount: 0,
      frozenChainHash: "chain-2",
      tailHash: null,
    });
    externalReplayCloudReadBatchMock.mockImplementation(
      async ({ startEventIndex, endEventIndex }) => ({
        segments:
          startEventIndex < endEventIndex
            ? [
                {
                  payloadGz: `wire-${events[startEventIndex]?.id}`,
                  eventCount: 1,
                  segmentHash: `hash-${events[startEventIndex]?.id}`,
                  wireBytes: 100,
                },
              ]
            : [],
        startEventIndex,
        nextEventIndex: Math.min(startEventIndex + 1, endEventIndex),
        startSegmentIndex: startEventIndex,
        nextSegmentIndex: startEventIndex + 1,
        eof: startEventIndex + 1 >= endEventIndex,
        serializedBytes: 100,
      })
    );
    client.appendSessionEventWires.mockRejectedValueOnce(conflictError());
    client.getSessionEvents.mockResolvedValueOnce({
      epoch: 7,
      frozenSeq: 0,
      tailHash: null,
      count: 0,
      segments: [],
    });
    store.set(sessionsAtom, [
      { ...SESSION, session_id: "cursoride-thread-1", orgId: "personal-org" },
    ]);

    await engine.runSyncPass();
    vi.setSystemTime(Date.now() + EXTERNAL_HISTORY_ACTIVITY_DEBOUNCE_MS + 1);
    await engine.runSyncPass();

    expect(client.getSessionEvents).toHaveBeenCalledWith(
      "jwt-1",
      "corg-1",
      "cursoride-thread-1",
      {
        boundedWirePage: true,
        cursor: { direction: "backward" },
        includeTail: false,
        maxSegments: 1,
        maxWireBytes: 64 * 1024,
      }
    );
    expect(client.rewriteSessionEventWires).toHaveBeenCalledTimes(2);
    expect(client.rewriteSessionEventWires.mock.calls[1]?.[1].newEpoch).toBe(8);
    expect(
      store.get(org2CloudPushCursorsAtom)["corg-1:cursoride-thread-1"]
    ).toMatchObject({ epoch: 8, frozenEventCount: 2, pushedCount: 2 });
  });

  it("rewrites a new epoch when an external source shrinks", async () => {
    store.set(org2CloudPushCursorsAtom, {
      "corg-1:cursoride-thread-1": {
        orgId: "corg-1",
        sessionId: "cursoride-thread-1",
        epoch: 4,
        frozenSeq: 3,
        pushedCount: 3,
        frozenEventCount: 3,
        frozenChainHash: "old-chain",
        tailHash: null,
      },
    });
    externalReplayCloudPrepareMock.mockResolvedValueOnce({
      token: "shrunk-external-spool",
      generation: "g2",
      totalCount: 2,
      frozenEventCount: 2,
      tailEventCount: 0,
      frozenChainHash: "new-chain",
      tailHash: null,
    });
    externalReplayCloudReadBatchMock.mockResolvedValueOnce({
      segments: [
        {
          payloadGz: "wire-new-1",
          eventCount: 1,
          segmentHash: "hash-new-1",
          wireBytes: 100,
        },
        {
          payloadGz: "wire-new-2",
          eventCount: 1,
          segmentHash: "hash-new-2",
          wireBytes: 100,
        },
      ],
      startEventIndex: 0,
      nextEventIndex: 2,
      startSegmentIndex: 0,
      nextSegmentIndex: 2,
      eof: true,
      serializedBytes: 200,
    });
    store.set(sessionsAtom, [
      { ...SESSION, session_id: "cursoride-thread-1", orgId: "personal-org" },
    ]);

    await engine.runSyncPass();
    vi.setSystemTime(Date.now() + EXTERNAL_HISTORY_ACTIVITY_DEBOUNCE_MS + 1);
    await engine.runSyncPass();

    expect(externalReplayCloudPrefixHashMock).not.toHaveBeenCalled();
    expect(client.appendSessionEventWires).not.toHaveBeenCalled();
    expect(client.rewriteSessionEventWires).toHaveBeenCalledTimes(1);
    expect(client.rewriteSessionEventWires.mock.calls[0]?.[1]).toMatchObject({
      newEpoch: 5,
      totalCount: 2,
      frozenSegments: [
        { seq: 1, eventCount: 1 },
        { seq: 2, eventCount: 1 },
      ],
    });
    expect(
      store.get(org2CloudPushCursorsAtom)["corg-1:cursoride-thread-1"]
    ).toMatchObject({
      epoch: 5,
      frozenSeq: 2,
      pushedCount: 2,
      frozenEventCount: 2,
      frozenChainHash: "new-chain",
    });
  });

  it("rewrites an empty epoch when an external source is cleared", async () => {
    store.set(org2CloudPushCursorsAtom, {
      "corg-1:cursoride-thread-1": {
        orgId: "corg-1",
        sessionId: "cursoride-thread-1",
        epoch: 4,
        frozenSeq: 3,
        pushedCount: 3,
        frozenEventCount: 3,
        frozenChainHash: "old-chain",
        tailHash: null,
      },
    });
    externalReplayCloudPrepareMock.mockResolvedValueOnce({
      token: "cleared-external-spool",
      generation: "g2",
      totalCount: 0,
      frozenEventCount: 0,
      tailEventCount: 0,
      frozenChainHash:
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      tailHash: null,
    });
    store.set(sessionsAtom, [
      { ...SESSION, session_id: "cursoride-thread-1", orgId: "personal-org" },
    ]);

    await engine.runSyncPass();
    vi.setSystemTime(Date.now() + EXTERNAL_HISTORY_ACTIVITY_DEBOUNCE_MS + 1);
    await engine.runSyncPass();

    expect(externalReplayCloudPrefixHashMock).not.toHaveBeenCalled();
    expect(externalReplayCloudReadBatchMock).not.toHaveBeenCalled();
    expect(client.appendSessionEventWires).not.toHaveBeenCalled();
    expect(client.rewriteSessionEventWires).toHaveBeenCalledWith("jwt-1", {
      orgId: "corg-1",
      sessionId: "cursoride-thread-1",
      newEpoch: 5,
      frozenSegments: [],
      tail: null,
      totalCount: 0,
    });
    expect(
      store.get(org2CloudPushCursorsAtom)["corg-1:cursoride-thread-1"]
    ).toMatchObject({
      epoch: 5,
      frozenSeq: 0,
      pushedCount: 0,
      frozenEventCount: 0,
      tailHash: null,
    });
  });

  it("stops an external multi-batch rewrite after the in-flight batch", async () => {
    externalReplayCloudPrepareMock.mockResolvedValueOnce({
      token: "abort-external-spool",
      generation: "g1",
      totalCount: 3,
      frozenEventCount: 3,
      tailEventCount: 0,
      frozenChainHash: "chain-3",
      tailHash: null,
    });
    externalReplayCloudReadBatchMock.mockImplementation(
      async ({ startEventIndex, endEventIndex }) => ({
        segments: [
          {
            payloadGz: `wire-${startEventIndex}`,
            eventCount: 1,
            segmentHash: `hash-${startEventIndex}`,
            wireBytes: 100,
          },
        ],
        startEventIndex,
        nextEventIndex: Math.min(startEventIndex + 1, endEventIndex),
        startSegmentIndex: startEventIndex,
        nextSegmentIndex: startEventIndex + 1,
        eof: startEventIndex + 1 >= endEventIndex,
        serializedBytes: 100,
      })
    );
    client.rewriteSessionEventWires.mockImplementationOnce(async () => {
      engine.stop();
    });
    store.set(sessionsAtom, [
      { ...SESSION, session_id: "cursoride-thread-1", orgId: "personal-org" },
    ]);

    await engine.runSyncPass();
    vi.setSystemTime(Date.now() + EXTERNAL_HISTORY_ACTIVITY_DEBOUNCE_MS + 1);
    await engine.runSyncPass();
    await Promise.resolve();
    await Promise.resolve();

    expect(client.rewriteSessionEventWires).toHaveBeenCalledTimes(1);
    expect(client.appendSessionEventWires).not.toHaveBeenCalled();
    expect(externalReplayCloudReadBatchMock).toHaveBeenCalledTimes(1);
    expect(externalReplayCloudReleaseMock).toHaveBeenCalledWith(
      "abort-external-spool"
    );
    expect(
      store.get(org2CloudPushCursorsAtom)["corg-1:cursoride-thread-1"]
    ).toBeUndefined();
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
