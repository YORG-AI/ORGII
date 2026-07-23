import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ExternalReplayWindow } from "@src/api/tauri/externalHistory/replay";

import {
  clearLoadedTurnRegistry,
  getSessionTurnLoader,
  loadSessionTurnBodyIntoStore,
  pruneLoadedTurnBodies,
} from ".";
import { externalReplayTurnLoader } from "./externalReplayTurnLoader";
import {
  captureLoadedTurnRegistryGeneration,
  markTurnBodyLoaded,
} from "./loadedTurnRegistry";
import { ownDbTurnLoader } from "./ownDbTurnLoader";

const mocks = vi.hoisted(() => {
  let nextEpisodeId = 0;
  const episodes = new Map<string, { id: number; generation: string | null }>();
  return {
    readWindow: vi.fn(),
    openWindow: vi.fn(),
    mergeWindow: vi.fn(),
    loadNativeTurn: vi.fn(async () => ({ turnId: "native", events: [] })),
    mergeNativeEvents: vi.fn(async () => {}),
    unloadNativeTurn: vi.fn(async () => 0),
    resetEpisodes() {
      nextEpisodeId = 0;
      episodes.clear();
    },
    startEpisode(sessionId: string, generation: string | null = null) {
      const episode = { id: ++nextEpisodeId, generation };
      episodes.set(sessionId, episode);
      return episode;
    },
    captureEpisode(sessionId: string) {
      const existing = episodes.get(sessionId);
      if (existing) return existing;
      const episode = { id: ++nextEpisodeId, generation: "g1" };
      episodes.set(sessionId, episode);
      return episode;
    },
    isCurrentEpisode(
      sessionId: string,
      episode: { id: number; generation: string | null }
    ) {
      return episodes.get(sessionId)?.id === episode.id;
    },
  };
});

vi.mock("@src/api/tauri/externalHistory/replay", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@src/api/tauri/externalHistory/replay")
    >();
  return { ...actual, externalReplayReadWindow: mocks.readWindow };
});

vi.mock("@src/engines/SessionCore/sync/externalReplayTransport", () => ({
  getActiveExternalReplayLease: (sessionId: string) => ({
    sessionId,
    epoch: 41,
  }),
  openExternalReplaySession: mocks.openWindow,
  readExternalReplaySession: (
    lease: { sessionId: string; epoch: number },
    selection: Record<string, unknown>
  ) =>
    mocks.readWindow({
      sessionId: lease.sessionId,
      episodeId: lease.epoch,
      ...selection,
    }),
}));

vi.mock("@src/engines/SessionCore/sync/externalReplayTurnState", () => ({
  captureExternalReplayTurnEpisode: mocks.captureEpisode,
  externalReplayTurnIndexFromId: (turnId: string) => {
    const prefix = "__external_replay_turn_index__:";
    return turnId.startsWith(prefix)
      ? Number(turnId.slice(prefix.length))
      : null;
  },
  isCurrentExternalReplayTurnEpisode: mocks.isCurrentEpisode,
  mergeExternalReplayTurnWindow: mocks.mergeWindow,
  startExternalReplayTurnEpisode: mocks.startEpisode,
}));

vi.mock("@src/engines/SessionCore/storage/cacheAdapter", () => ({
  loadTurnBody: mocks.loadNativeTurn,
}));

vi.mock("@src/engines/SessionCore/core/store/EventStoreProxy", () => ({
  eventStoreProxy: {
    mergeRoundWindowEvents: mocks.mergeNativeEvents,
    unloadTurnBody: mocks.unloadNativeTurn,
  },
}));

function replayWindow(
  sessionId: string,
  generation = "g1"
): ExternalReplayWindow {
  return {
    cursor: {
      sourceId: sessionId.startsWith("cliagent-") ? "managed_cli" : "codex_app",
      sessionId,
      generation,
      revision: 1,
      throughSequence: 1,
    },
    events: [],
    windowStartSequence: null,
    turnHeaders: [],
    totalEventCount: 0,
    totalTurnCount: 0,
    hasOlder: false,
    watcherAvailable: false,
    stats: {
      parsedBytes: 0,
      parsedRows: 0,
      normalizedEvents: 0,
      upsertedEvents: 0,
      removedEvents: 0,
      ipcBytes: 0,
      notReady: false,
    },
  };
}

const BOUNDED_SESSION_IDS = [
  "codexapp-session",
  "claudecodeapp-session",
  "opencodeapp-session",
  "clineapp-session",
  "cliagent-session",
  "imported-session-snapshot",
] as const;

describe("session turn loader routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resetEpisodes();
    for (const sessionId of BOUNDED_SESSION_IDS) {
      clearLoadedTurnRegistry(sessionId);
    }
    clearLoadedTurnRegistry("sdeagent-native");
    clearLoadedTurnRegistry("agentsession-cloud-fork");
    mocks.readWindow.mockImplementation(
      ({ sessionId }: { sessionId: string }) =>
        Promise.resolve(replayWindow(sessionId))
    );
    mocks.openWindow.mockImplementation(
      ({ sessionId }: { sessionId: string }) =>
        Promise.resolve(replayWindow(sessionId, "g2"))
    );
  });

  it.each(BOUNDED_SESSION_IDS)(
    "routes %s through foreground bounded readWindow",
    async (sessionId) => {
      expect(getSessionTurnLoader(sessionId)).toBe(externalReplayTurnLoader);
      await loadSessionTurnBodyIntoStore({
        sessionId,
        turnId: "__external_replay_turn_index__:3",
      });
      expect(mocks.readWindow).toHaveBeenCalledWith({
        sessionId,
        episodeId: 41,
        turnIndex: 3,
        limits: {
          maxTurns: 1,
          maxEvents: 200,
          maxIpcBytes: 4 * 1024 * 1024,
        },
      });
      expect(mocks.loadNativeTurn).not.toHaveBeenCalled();
    }
  );

  it.each(["sdeagent-native", "agentsession-cloud-fork"])(
    "keeps %s on the native turn loader",
    async (sessionId) => {
      expect(getSessionTurnLoader(sessionId)).toBe(ownDbTurnLoader);
      await loadSessionTurnBodyIntoStore({ sessionId, turnId: "native-turn" });
      expect(mocks.loadNativeTurn).toHaveBeenCalledWith(
        sessionId,
        "native-turn"
      );
      expect(mocks.readWindow).not.toHaveBeenCalled();
    }
  );

  it("bounds external loaded-turn bookkeeping without native unload RPCs", async () => {
    const sessionId = "codexapp-registry-bound";
    clearLoadedTurnRegistry(sessionId);
    const generation = captureLoadedTurnRegistryGeneration(sessionId);
    for (let index = 0; index < 12; index += 1) {
      markTurnBodyLoaded(sessionId, `turn-${index}`, generation);
    }

    const pruned = await pruneLoadedTurnBodies(sessionId, [
      "turn-10",
      "turn-11",
    ]);

    expect(pruned).toHaveLength(4);
    expect(pruned).toEqual(["turn-0", "turn-1", "turn-2", "turn-3"]);
    expect(mocks.unloadNativeTurn).not.toHaveBeenCalled();
    clearLoadedTurnRegistry(sessionId);
  });

  it("single-flights the same older page and does not apply it twice", async () => {
    let resolve!: (window: ExternalReplayWindow) => void;
    mocks.readWindow.mockReturnValue(
      new Promise<ExternalReplayWindow>((done) => {
        resolve = done;
      })
    );
    const args = {
      sessionId: "codexapp-session",
      turnId: "__external_replay_turn_index__:1",
    };
    const first = loadSessionTurnBodyIntoStore(args);
    const second = loadSessionTurnBodyIntoStore(args);
    expect(mocks.readWindow).toHaveBeenCalledTimes(1);
    resolve(replayWindow(args.sessionId));
    await Promise.all([first, second]);
    expect(mocks.mergeWindow).toHaveBeenCalledTimes(1);
  });

  it("reopens authoritatively when an older page belongs to a new generation", async () => {
    mocks.readWindow.mockResolvedValue(replayWindow("codexapp-session", "g2"));
    mocks.openWindow.mockResolvedValue(replayWindow("codexapp-session", "g2"));

    await loadSessionTurnBodyIntoStore({
      sessionId: "codexapp-session",
      turnId: "__external_replay_turn_index__:0",
    });

    expect(mocks.openWindow).toHaveBeenCalledWith({
      sessionId: "codexapp-session",
      epoch: 41,
    });
    expect(mocks.mergeWindow).toHaveBeenCalledTimes(1);
    expect(mocks.mergeWindow).toHaveBeenCalledWith(
      "codexapp-session",
      expect.objectContaining({
        cursor: expect.objectContaining({ generation: "g2" }),
      })
    );
  });
});
