import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  captureLoadedTurnRegistryGeneration,
  clearLoadedTurnRegistry,
  getLoadedTurnRegistryStats,
  isTurnBodyLoaded,
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

  it("continues past a rejecting unloadTurnBody and still evicts the entry", async () => {
    // Mirrors the real-world "turn not found" RPC rejection: the registry
    // can hold ids the backing store no longer recognizes (windowed
    // replace reloads, shifting imported turn ids). One failed unload must
    // never abort the sweep or reject the caller — that's what used to
    // surface as a fatal, full-app crash from an unhandled RPC rejection.
    const sessionId = "codexapp-large";
    const generation = captureLoadedTurnRegistryGeneration(sessionId);
    markTurnBodyLoaded(sessionId, "turn-1", generation);
    markTurnBodyLoaded(sessionId, "turn-2", generation);
    markTurnBodyLoaded(sessionId, "turn-3", generation);

    unloadTurnBody.mockRejectedValueOnce(
      new Error("[RPC:es_unload_turn_body] turn not found: turn-1")
    );

    await expect(
      pruneLoadedTurnBodies(sessionId, ["turn-3"])
    ).resolves.toBeUndefined();

    expect(unloadTurnBody).toHaveBeenCalledTimes(2);
    expect(unloadTurnBody).toHaveBeenNthCalledWith(1, sessionId, "turn-1");
    expect(unloadTurnBody).toHaveBeenNthCalledWith(2, sessionId, "turn-2");
    // Both candidates are evicted from the registry regardless of the
    // rejection — the registry entry is the source of truth for "do we
    // still think this is loaded", and the answer is no either way.
    expect(getLoadedTurnRegistryStats()).toMatchObject({
      sessions: 1,
      loadedTurns: 1,
    });
  });

  describe("isTurnBodyLoaded", () => {
    it("is false before a turn body has ever been marked loaded", () => {
      expect(isTurnBodyLoaded("session-a", "turn-1")).toBe(false);
    });

    it("is true once a turn body is marked loaded for the current generation", () => {
      const generation = captureLoadedTurnRegistryGeneration("session-a");
      markTurnBodyLoaded("session-a", "turn-1", generation);

      expect(isTurnBodyLoaded("session-a", "turn-1")).toBe(true);
      // Distinct session/turn pairs stay independent.
      expect(isTurnBodyLoaded("session-a", "turn-2")).toBe(false);
      expect(isTurnBodyLoaded("session-b", "turn-1")).toBe(false);
    });

    it("goes false again once pruneLoadedTurnBodies evicts the entry", async () => {
      const sessionId = "codexapp-large";
      const generation = captureLoadedTurnRegistryGeneration(sessionId);
      markTurnBodyLoaded(sessionId, "turn-1", generation);
      markTurnBodyLoaded(sessionId, "turn-2", generation);
      markTurnBodyLoaded(sessionId, "turn-3", generation);

      await pruneLoadedTurnBodies(sessionId, ["turn-3"]);

      // turn-1 was the oldest unprotected candidate — evicted first.
      expect(isTurnBodyLoaded(sessionId, "turn-1")).toBe(false);
      expect(isTurnBodyLoaded(sessionId, "turn-3")).toBe(true);
    });

    it("is false again after a stale async completion is ignored", () => {
      const staleGeneration = captureLoadedTurnRegistryGeneration("session-a");
      clearLoadedTurnRegistry("session-a");

      markTurnBodyLoaded("session-a", "turn-1", staleGeneration);

      expect(isTurnBodyLoaded("session-a", "turn-1")).toBe(false);
    });
  });
});
