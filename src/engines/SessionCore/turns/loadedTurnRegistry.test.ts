import { beforeEach, describe, expect, it } from "vitest";

import {
  captureLoadedTurnRegistryGeneration,
  clearLoadedTurnRegistry,
  getLoadedTurnRegistryStats,
  markTurnBodyLoaded,
} from "./loadedTurnRegistry";

describe("loadedTurnRegistry lifecycle", () => {
  beforeEach(() => {
    clearLoadedTurnRegistry("session-a");
    clearLoadedTurnRegistry("session-b");
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

  it("keeps random-access bookkeeping until the bounded LRU prunes it", () => {
    const generation = captureLoadedTurnRegistryGeneration("session-a");
    markTurnBodyLoaded("session-a", "turn-1", generation);
    markTurnBodyLoaded("session-a", "turn-2", generation);
    markTurnBodyLoaded("session-a", "turn-3", generation);

    expect(getLoadedTurnRegistryStats()).toMatchObject({
      sessions: 1,
      loadedTurns: 3,
    });
  });
});
