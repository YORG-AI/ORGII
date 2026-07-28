import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  captureLoadedTurnRegistryGeneration,
  clearLoadedTurnRegistry,
  getLoadedTurnRegistryStats,
  markTurnBodyLoaded,
  pruneLoadedTurnBodies,
} from "./loadedTurnRegistry";

const { unloadTurnBody } = vi.hoisted(() => ({
  unloadTurnBody: vi.fn(async () => 1),
}));

vi.mock("@src/engines/SessionCore/core/store/EventStoreProxy", () => ({
  eventStoreProxy: { unloadTurnBody },
}));

describe("loadedTurnRegistry lifecycle", () => {
  beforeEach(() => {
    clearLoadedTurnRegistry("session-a");
    clearLoadedTurnRegistry("session-b");
    clearLoadedTurnRegistry("codexapp-large");
    unloadTurnBody.mockClear();
  });

  it("drops loaded-turn metadata when a session is cleared", () => {
    const generation = captureLoadedTurnRegistryGeneration("session-a");
    markTurnBodyLoaded("session-a", "turn-1", generation);

    expect(getLoadedTurnRegistryStats()).toMatchObject({
      sessions: 1,
      loadedTurns: 1,
    });

    clearLoadedTurnRegistry("session-a");
    expect(getLoadedTurnRegistryStats()).toMatchObject({
      sessions: 0,
      loadedTurns: 0,
    });
  });

  it("does not resurrect a cleared session from a stale async completion", () => {
    const staleGeneration = captureLoadedTurnRegistryGeneration("session-a");
    clearLoadedTurnRegistry("session-a");

    markTurnBodyLoaded("session-a", "turn-1", staleGeneration);

    expect(getLoadedTurnRegistryStats()).toMatchObject({
      sessions: 0,
      loadedTurns: 0,
    });
  });

  it("keeps only the selected historical body resident for Codex app sessions", async () => {
    const sessionId = "codexapp-large";
    const generation = captureLoadedTurnRegistryGeneration(sessionId);
    markTurnBodyLoaded(sessionId, "turn-1", generation);
    markTurnBodyLoaded(sessionId, "turn-2", generation);
    markTurnBodyLoaded(sessionId, "turn-3", generation);

    await pruneLoadedTurnBodies(sessionId, ["turn-3"]);

    expect(unloadTurnBody).toHaveBeenCalledTimes(2);
    expect(unloadTurnBody).toHaveBeenNthCalledWith(1, sessionId, "turn-1");
    expect(unloadTurnBody).toHaveBeenNthCalledWith(2, sessionId, "turn-2");
    expect(getLoadedTurnRegistryStats()).toMatchObject({
      sessions: 1,
      loadedTurns: 1,
    });
  });
});
