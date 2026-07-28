import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  VANISHED_SESSION_RETRACT_CONFIRMATIONS,
  VANISHED_SESSION_SWEEP_INTERVAL_MS,
} from "./org2CloudSyncEngine.constants";
import {
  cleanupEngineFixture,
  createEngineFixture,
  engineTestDeps,
} from "./org2CloudSyncEngine.testUtils";
import type { EngineFixture } from "./org2CloudSyncEngine.testUtils";

const { Org2CloudSyncEngine, org2CloudPushedMetadataAtom, sessionsAtom } =
  engineTestDeps;

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
