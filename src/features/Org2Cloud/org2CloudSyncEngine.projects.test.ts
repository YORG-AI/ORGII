import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AUTH,
  CUSTOM_SUPABASE_URL,
  cleanupEngineFixture,
  createEngineFixture,
  documentStub,
  emitDataChanged,
  engineTestDeps,
  getTauriEventListeners,
  messageMock,
} from "./org2CloudSyncEngine.testUtils";
import type { EngineFixture } from "./org2CloudSyncEngine.testUtils";

const {
  DATA_CHANGED_DEBOUNCE_MS,
  ORG2_CLOUD_ENDPOINT_OVERRIDE_STORAGE_KEY,
  ORG2_CLOUD_EXPECTED_SCHEMA_VERSION,
  ORG_BACKOFF_COOLDOWN_MS,
  PROJECT_PUSH_RETRY_DELAY_MS,
  ensureProjectOrgForCloudOrg,
  org2CloudAuthAtom,
  org2CloudCollabStateCursorsAtom,
  org2CloudOrgsAtom,
  org2CloudRepoScopesAtom,
  org2CloudSyncEnabledAtom,
  Org2CloudProjectsError,
  Org2CloudSyncEngine,
  Org2CloudSyncError,
} = engineTestDeps;

describe("Org2CloudSyncEngine project and endpoint synchronization", () => {
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

  /** Rebuild the engine against a custom endpoint and schema probe. */
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
    engine = new Org2CloudSyncEngine(client, projectsClient, bridge, probe);
    engine.start(store);
  }

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

  it("scopes Realtime pulls to one org, preserves delta cursors, and skips the outbox probe", async () => {
    store.set(org2CloudOrgsAtom, [
      { orgId: "corg-1", name: "Cloud Team", role: "member" },
      { orgId: "corg-2", name: "Other Team", role: "member" },
    ]);

    await engine.runSyncPass();
    projectsClient.listOrgCollabState.mockClear();
    bridge.drainOutbox.mockClear();

    await engine.invalidateOrgInboundAndWait("corg-1");

    expect(projectsClient.listOrgCollabState).toHaveBeenCalledTimes(1);
    expect(projectsClient.listOrgCollabState).toHaveBeenCalledWith(
      "jwt-1",
      "corg-1",
      "2026-07-01T11:59:58.000Z"
    );
    expect(bridge.drainOutbox).not.toHaveBeenCalled();
  });

  it("applies snake_case tombstones from Realtime-scoped project pulls", async () => {
    await engine.runSyncPass();
    projectsClient.listOrgCollabState.mockClear();
    bridge.applyRemote.mockClear();
    bridge.drainOutbox.mockClear();
    bridge.applyRemote.mockResolvedValue(1);
    projectsClient.listOrgCollabState.mockResolvedValueOnce({
      serverTime: "2026-07-01T12:05:00.000Z",
      projects: [],
      workItems: [
        {
          id: "AAA-0001",
          version: 6,
          updated_by_user_id: "u-2",
          deleted_at: "2026-07-01T12:04:59.000Z",
        },
      ],
    });

    await engine.invalidateOrgInboundAndWait("corg-1");

    expect(projectsClient.listOrgCollabState).toHaveBeenCalledWith(
      "jwt-1",
      "corg-1",
      "2026-07-01T11:59:58.000Z"
    );
    expect(bridge.applyRemote).toHaveBeenCalledWith({
      orgId: "porg-corg-1",
      orgName: "Cloud Team",
      entities: [
        expect.objectContaining({
          kind: "work_item",
          version: 6,
          updatedBy: "u-2",
          deletedAt: "2026-07-01T12:04:59.000Z",
        }),
      ],
    });
    expect(bridge.drainOutbox).not.toHaveBeenCalled();
  });

  it("uses a full listing only for reconnect recovery", async () => {
    await engine.runSyncPass();
    projectsClient.listOrgCollabState.mockClear();

    await engine.invalidateOrgInboundAndWait("corg-1", { full: true });

    expect(projectsClient.listOrgCollabState).toHaveBeenCalledWith(
      "jwt-1",
      "corg-1",
      undefined
    );
  });

  it("resumeOrgAndWait runs exactly one serialized pass (no dirty follow-up)", async () => {
    await engine.runSyncPass();
    projectsClient.listOrgCollabState.mockClear();
    const passesBefore = engine.startedPassCount;

    await engine.resumeOrgAndWait("corg-1");

    expect(engine.startedPassCount - passesBefore).toBe(1);
    expect(projectsClient.listOrgCollabState).toHaveBeenCalledTimes(1);
    expect(projectsClient.listOrgCollabState).toHaveBeenCalledWith(
      "jwt-1",
      "corg-1",
      undefined
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

  it("keeps project tombstones draining while session replay is over quota", async () => {
    client.rewriteSessionEvents.mockRejectedValue(
      new Org2CloudSyncError("ORG2_QUOTA_EXCEEDED", 403)
    );

    await engine.runSyncPass();

    expect(messageMock.warning).toHaveBeenCalledWith(
      "navigation:cloud.sync.quotaExceededToast"
    );
    expect(projectsClient.listOrgCollabState).toHaveBeenCalledTimes(1);
    expect(bridge.drainOutbox).toHaveBeenCalledTimes(1);

    // The org remains session-backed-off, but a later local deletion still
    // schedules and drains the independent projects/work-items control plane.
    await vi.advanceTimersByTimeAsync(0);
    await engine.runSyncPassAndWaitForDrain();
    client.rewriteSessionEvents.mockClear();
    projectsClient.listOrgCollabState.mockClear();
    bridge.drainOutbox.mockClear();

    emitDataChanged();
    await vi.advanceTimersByTimeAsync(DATA_CHANGED_DEBOUNCE_MS);
    await engine.runSyncPassAndWaitForDrain();

    expect(client.rewriteSessionEvents).not.toHaveBeenCalled();
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
    await engine.invalidateOrgInboundAndWait("corg-1");

    expect(projectsClient.listOrgCollabState).toHaveBeenCalled();
    // This org never completed its startup inbound cycle before backoff, so
    // the overdue safety pass also retries its durable outbox.
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
    // start() also owns an independent 0 ms bootstrap timer. Drain it before
    // the event assertion so it cannot overlap the debounce callback and turn
    // that callback into a fire-and-forget dirty pass under full-suite load.
    await vi.advanceTimersByTimeAsync(0);
    await engine.runSyncPassAndWaitForDrain();
    projectsClient.listOrgCollabState.mockClear();
    bridge.drainOutbox.mockClear();

    // Gate holds on an ordinary pass: no event, no inbound window elapsed.
    await engine.runSyncPass();
    expect(bridge.drainOutbox).not.toHaveBeenCalled();

    // A local mutation emits orgii-data-changed → debounced pass drains the
    // outbox now instead of waiting INBOUND_FALLBACK_INTERVAL_MS.
    emitDataChanged();
    expect(bridge.drainOutbox).not.toHaveBeenCalled(); // debounce coalesces
    await vi.advanceTimersByTimeAsync(DATA_CHANGED_DEBOUNCE_MS);
    // Production timer callbacks are intentionally fire-and-forget. Wait for
    // the pass they started (and any serialized dirty follow-up) before
    // asserting against its async ProjectSyncChannel work.
    await engine.runSyncPassAndWaitForDrain();
    expect(bridge.drainOutbox).toHaveBeenCalledTimes(1);
    expect(projectsClient.listOrgCollabState).toHaveBeenCalledTimes(1);
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

  it("forces an outbox-draining recovery pass when the browser comes online", async () => {
    // This suite normally runs in Vitest's node environment. Install a
    // minimal browser event target before start() so the production listener
    // itself (including stop() cleanup) is exercised.
    engine.stop();
    const browserWindow = new EventTarget();
    vi.stubGlobal("window", browserWindow);
    engine = new Org2CloudSyncEngine(client, projectsClient, bridge);
    engine.start(store);
    try {
      await engine.runSyncPass();
      projectsClient.listOrgCollabState.mockClear();
      bridge.drainOutbox.mockClear();

      browserWindow.dispatchEvent(new Event("online"));
      await engine.runSyncPassAndWaitForDrain();

      expect(projectsClient.listOrgCollabState).toHaveBeenCalledTimes(1);
      expect(bridge.drainOutbox).toHaveBeenCalledTimes(1);
    } finally {
      engine.stop();
      vi.unstubAllGlobals();
    }
  });

  it("retries when the project listing fails before the outbox can drain", async () => {
    projectsClient.listOrgCollabState.mockRejectedValueOnce(
      new TypeError("fetch failed")
    );

    await engine.runSyncPass();
    await vi.advanceTimersByTimeAsync(0);
    projectsClient.listOrgCollabState.mockClear();
    bridge.drainOutbox.mockClear();

    await vi.advanceTimersByTimeAsync(PROJECT_PUSH_RETRY_DELAY_MS);
    await engine.runSyncPassAndWaitForDrain();

    expect(projectsClient.listOrgCollabState).toHaveBeenCalledTimes(1);
    expect(bridge.drainOutbox).toHaveBeenCalledTimes(1);
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
    expect(getTauriEventListeners().get("orgii-data-changed")?.size).toBe(1);
    engine.stop();
    await Promise.resolve();
    expect(getTauriEventListeners().get("orgii-data-changed")?.size).toBe(0);
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
    engine = new Org2CloudSyncEngine(client, projectsClient, bridge, probe);
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
  });
});
