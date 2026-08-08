import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  VANISHED_SESSION_RETRACT_CONFIRMATIONS,
  VANISHED_SESSION_SWEEP_INTERVAL_MS,
} from "./org2CloudSyncEngine.constants";
import {
  SESSION,
  cleanupEngineFixture,
  createEngineFixture,
  engineTestDeps,
} from "./org2CloudSyncEngine.testUtils";
import type { EngineFixture } from "./org2CloudSyncEngine.testUtils";

const {
  Org2CloudSyncEngine,
  org2CloudPushCursorsAtom,
  org2CloudPushedMetadataAtom,
  sessionsAtom,
} = engineTestDeps;

describe("vanished-session sweep two-strike confirmation", () => {
  let fixture: EngineFixture;
  let store: EngineFixture["store"];
  let client: EngineFixture["client"];
  let engine: EngineFixture["engine"];
  let resolveLocalSessionIds: ReturnType<typeof vi.fn>;

  function startSweepEngine(): void {
    fixture.engine.stop();
    engine = new Org2CloudSyncEngine(
      client,
      fixture.projectsClient,
      fixture.bridge,
      undefined,
      resolveLocalSessionIds as never
    );
    engine.start(store);
  }

  async function runSweepPass(): Promise<void> {
    vi.setSystemTime(Date.now() + VANISHED_SESSION_SWEEP_INTERVAL_MS + 1);
    await engine.runSyncPass();
  }

  beforeEach(() => {
    fixture = createEngineFixture();
    ({ store, client } = fixture);
    engine = fixture.engine;
    store.set(sessionsAtom, []);
    store.set(org2CloudPushedMetadataAtom, { "corg-1:ghost-1": true });
    resolveLocalSessionIds = vi.fn().mockResolvedValue(new Set());
  });

  afterEach(() => {
    cleanupEngineFixture(engine);
  });

  it("retracts only after consecutive sweeps confirm the suspect absent", async () => {
    startSweepEngine();

    await engine.runSyncPass();
    expect(resolveLocalSessionIds).toHaveBeenCalledTimes(1);
    expect(client.deleteSession).not.toHaveBeenCalled();

    for (let i = 1; i < VANISHED_SESSION_RETRACT_CONFIRMATIONS; i += 1) {
      await runSweepPass();
    }
    expect(client.deleteSession).toHaveBeenCalledTimes(1);
    expect(client.deleteSession).toHaveBeenCalledWith(
      "jwt-1",
      "corg-1",
      "ghost-1"
    );
    // A successful retract clears the durable marker, so later sweeps have
    // no suspect left to confirm.
    await runSweepPass();
    expect(client.deleteSession).toHaveBeenCalledTimes(1);
  });

  it("restarts confirmation when the suspect resolves between sweeps", async () => {
    startSweepEngine();

    await engine.runSyncPass();
    expect(client.deleteSession).not.toHaveBeenCalled();

    // A cache rebuild finished: the id resolves again — the strike resets.
    resolveLocalSessionIds.mockResolvedValue(new Set(["ghost-1"]));
    await runSweepPass();
    expect(client.deleteSession).not.toHaveBeenCalled();

    resolveLocalSessionIds.mockResolvedValue(new Set());
    await runSweepPass();
    expect(client.deleteSession).not.toHaveBeenCalled();

    await runSweepPass();
    expect(client.deleteSession).toHaveBeenCalledTimes(1);
  });
});

describe("superseded-continuation reconcile", () => {
  let fixture: EngineFixture;
  let store: EngineFixture["store"];
  let client: EngineFixture["client"];
  let engine: EngineFixture["engine"];
  let resolveLocalSessionIds: ReturnType<typeof vi.fn>;
  let resolveContinuationStatuses: ReturnType<typeof vi.fn>;

  function startSweepEngine(): void {
    fixture.engine.stop();
    engine = new Org2CloudSyncEngine(
      client,
      fixture.projectsClient,
      fixture.bridge,
      undefined,
      resolveLocalSessionIds as never,
      resolveContinuationStatuses as never
    );
    engine.start(store);
  }

  async function runSweepPass(): Promise<void> {
    vi.setSystemTime(Date.now() + VANISHED_SESSION_SWEEP_INTERVAL_MS + 1);
    await engine.runSyncPass();
  }

  beforeEach(() => {
    fixture = createEngineFixture();
    ({ store, client } = fixture);
    engine = fixture.engine;
    // old-sib was push-marked, then the continuation election demoted it out
    // of the roster; its file (and cache row) still exist locally. The
    // winner is an ordinary scoped session the engine pushes naturally —
    // its cursor comes from that push, exactly like production.
    store.set(org2CloudPushedMetadataAtom, { "corg-1:old-sib": true });
    store.set(sessionsAtom, [
      {
        ...SESSION,
        session_id: "winner",
        continuationLineageId: "lin-1",
      },
    ]);
    resolveLocalSessionIds = vi.fn().mockResolvedValue(new Set(["old-sib"]));
    resolveContinuationStatuses = vi
      .fn()
      .mockResolvedValue([
        { sessionId: "old-sib", lineageId: "lin-1", superseded: true },
      ]);
  });

  afterEach(() => {
    cleanupEngineFixture(engine);
  });

  it("retracts the demoted sibling only when the winner is replay-pushed, after two strikes", async () => {
    startSweepEngine();

    // Pass 1 pushes the winner (its cursor now covers pushed events) and
    // records the superseded suspect's first strike — never a retract.
    await engine.runSyncPass();
    expect(client.deleteSession).not.toHaveBeenCalled();
    expect(
      store.get(org2CloudPushCursorsAtom)["corg-1:winner"]?.pushedCount ?? 0
    ).toBeGreaterThan(0);

    await runSweepPass();
    expect(client.deleteSession).toHaveBeenCalledTimes(1);
    expect(client.deleteSession).toHaveBeenCalledWith(
      "jwt-1",
      "corg-1",
      "old-sib"
    );
    // The retract dropped the marker; nothing is left to reconcile.
    await runSweepPass();
    expect(client.deleteSession).toHaveBeenCalledTimes(1);
  });

  it("leaves the row alone while the family has no pushed winner", async () => {
    // No session carries the suspect's lineage at all.
    store.set(sessionsAtom, []);
    startSweepEngine();

    await engine.runSyncPass();
    await runSweepPass();
    await runSweepPass();
    expect(client.deleteSession).not.toHaveBeenCalled();
  });

  it("treats a failed status lookup as unknown, never superseded", async () => {
    resolveContinuationStatuses.mockRejectedValue(new Error("cache busy"));
    startSweepEngine();

    await engine.runSyncPass();
    await runSweepPass();
    await runSweepPass();
    const retractedIds = client.deleteSession.mock.calls.map((call) => call[2]);
    expect(retractedIds).not.toContain("old-sib");
  });
});
