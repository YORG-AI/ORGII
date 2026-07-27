import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ExternalReplayWindow } from "@src/api/tauri/externalHistory/replay";

import {
  clearLoadedTurnRegistry,
  getSessionTurnLoader,
  loadSessionTurnBodyIntoStore,
  pruneLoadedTurnBodies,
} from ".";
import { externalReplayTurnLoader } from "./externalReplayTurnLoader";
import { loadPreviousExternalReplayWindow } from "./externalReplayTurnLoader";
import { loadPreviousExternalReplayTurnSlice } from "./externalReplayTurnLoader";
import {
  captureLoadedTurnRegistryGeneration,
  markTurnBodyLoaded,
} from "./loadedTurnRegistry";
import { ownDbTurnLoader } from "./ownDbTurnLoader";

const mocks = vi.hoisted(() => {
  let nextEpisodeId = 0;
  const episodes = new Map<string, { id: number; generation: string | null }>();
  const leaseEpisodeIds = new Map<string, number>();
  const snapshotListeners = new Map<string, Set<(snapshot: unknown) => void>>();
  const snapshots = new Map<string, unknown>();
  return {
    readWindow: vi.fn(),
    openWindow: vi.fn(),
    mergeWindow: vi.fn(),
    previousWindowStart: vi.fn(() => 120),
    previousTurnSliceStart: vi.fn(() => 251),
    getLatestSnapshot: vi.fn(
      (sessionId: string) => snapshots.get(sessionId) ?? null
    ),
    subscribeSession: vi.fn(
      (sessionId: string, listener: (snapshot: unknown) => void) => {
        let listeners = snapshotListeners.get(sessionId);
        if (!listeners) {
          listeners = new Set();
          snapshotListeners.set(sessionId, listeners);
        }
        listeners.add(listener);
        return () => listeners?.delete(listener);
      }
    ),
    loadNativeTurn: vi.fn(async () => ({ turnId: "native", events: [] })),
    mergeNativeEvents: vi.fn(async () => {}),
    unloadNativeTurn: vi.fn(async () => 0),
    resetEpisodes() {
      nextEpisodeId = 0;
      episodes.clear();
      leaseEpisodeIds.clear();
      snapshotListeners.clear();
      snapshots.clear();
    },
    emitSnapshot(sessionId: string, snapshot: unknown) {
      snapshots.set(sessionId, snapshot);
      for (const listener of snapshotListeners.get(sessionId) ?? []) {
        listener(snapshot);
      }
    },
    getLeaseEpisodeId(sessionId: string) {
      return leaseEpisodeIds.get(sessionId) ?? 41;
    },
    setLeaseEpisodeId(sessionId: string, episodeId: number) {
      leaseEpisodeIds.set(sessionId, episodeId);
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
    episodeId: mocks.getLeaseEpisodeId(sessionId),
  }),
  openExternalReplaySession: mocks.openWindow,
  readExternalReplaySession: (
    lease: { sessionId: string; episodeId: number },
    selection: Record<string, unknown>
  ) =>
    mocks.readWindow({
      sessionId: lease.sessionId,
      episodeId: lease.episodeId,
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
  previousExternalReplayWindowStart: mocks.previousWindowStart,
  previousExternalReplayTurnSliceStart: mocks.previousTurnSliceStart,
  startExternalReplayTurnEpisode: mocks.startEpisode,
}));

vi.mock("@src/engines/SessionCore/storage/cacheAdapter", () => ({
  loadTurnBody: mocks.loadNativeTurn,
}));

vi.mock("@src/engines/SessionCore/core/store/EventStoreProxy", () => ({
  eventStoreProxy: {
    getLatestSessionSnapshot: mocks.getLatestSnapshot,
    subscribeSession: mocks.subscribeSession,
    mergeRoundWindowEvents: mocks.mergeNativeEvents,
    unloadTurnBody: mocks.unloadNativeTurn,
  },
}));

function replayWindow(
  sessionId: string,
  generation = "g1",
  eventIds: readonly string[] = []
): ExternalReplayWindow {
  return {
    cursor: {
      sourceId: sessionId.startsWith("cliagent-") ? "managed_cli" : "codex_app",
      sessionId,
      generation,
      revision: 1,
      throughSequence: 1,
    },
    events: eventIds.map(
      (id) => ({ id }) as ExternalReplayWindow["events"][number]
    ),
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

function deferredWindow(): {
  promise: Promise<ExternalReplayWindow>;
  resolve: (window: ExternalReplayWindow) => void;
} {
  let resolve!: (window: ExternalReplayWindow) => void;
  const promise = new Promise<ExternalReplayWindow>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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

  it("does not finish a turn load before its EventStore snapshot is visible", async () => {
    const sessionId = "codexapp-session";
    mocks.readWindow.mockResolvedValue(
      replayWindow(sessionId, "g1", ["provider-event-1"])
    );
    let finished = false;

    const load = loadSessionTurnBodyIntoStore({
      sessionId,
      turnId: "__external_replay_turn_index__:1",
    }).then(() => {
      finished = true;
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(finished).toBe(false);
    expect(mocks.subscribeSession).toHaveBeenCalledWith(
      sessionId,
      expect.any(Function)
    );

    mocks.emitSnapshot(sessionId, {
      version: 2,
      events: [{ id: "provider-event-1" }],
      chatEvents: [],
      sortedSimulatorEvents: [{ id: "provider-event-1" }],
    });
    await load;
    expect(finished).toBe(true);
  });

  it("single-flights rapid scroll-back reads at the same event boundary", async () => {
    let resolve!: (window: ExternalReplayWindow) => void;
    mocks.readWindow.mockReturnValue(
      new Promise<ExternalReplayWindow>((done) => {
        resolve = done;
      })
    );

    const first = loadPreviousExternalReplayWindow("codexapp-session");
    const second = loadPreviousExternalReplayWindow("codexapp-session");
    expect(mocks.readWindow).toHaveBeenCalledTimes(1);
    expect(mocks.readWindow).toHaveBeenCalledWith({
      sessionId: "codexapp-session",
      episodeId: 41,
      beforeSequence: 120,
      limits: {
        maxTurns: 10,
        maxEvents: 200,
        maxIpcBytes: 4 * 1024 * 1024,
      },
    });

    resolve(replayWindow("codexapp-session"));
    await Promise.all([first, second]);
    expect(mocks.mergeWindow).toHaveBeenCalledTimes(1);
  });

  it("advances older-window cursors only after each newly retained page becomes visible", async () => {
    const sessionId = "codexapp-session";
    mocks.previousWindowStart
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(800);
    mocks.readWindow
      .mockResolvedValueOnce(replayWindow(sessionId, "g1", ["older-page-1"]))
      .mockResolvedValueOnce(replayWindow(sessionId, "g1", ["older-page-2"]));

    let firstFinished = false;
    const first = loadPreviousExternalReplayWindow(sessionId).then(() => {
      firstFinished = true;
    });
    await vi.waitFor(() => expect(mocks.mergeWindow).toHaveBeenCalledTimes(1));
    expect(firstFinished).toBe(false);
    mocks.emitSnapshot(sessionId, {
      version: 2,
      chatEvents: [],
      sortedSimulatorEvents: [{ id: "older-page-1" }],
    });
    await first;

    let secondFinished = false;
    const second = loadPreviousExternalReplayWindow(sessionId).then(() => {
      secondFinished = true;
    });
    await vi.waitFor(() => expect(mocks.mergeWindow).toHaveBeenCalledTimes(2));
    expect(secondFinished).toBe(false);
    // Simulate the 16 MiB cap evicting prior resident history. The page from
    // this exact request must still be present, so the visibility barrier can
    // settle without waiting for its five-second timeout.
    mocks.emitSnapshot(sessionId, {
      version: 3,
      chatEvents: [],
      sortedSimulatorEvents: [{ id: "older-page-2" }],
    });
    await second;

    expect(mocks.readWindow.mock.calls.map(([request]) => request)).toEqual([
      expect.objectContaining({ beforeSequence: 1_000 }),
      expect.objectContaining({ beforeSequence: 800 }),
    ]);
    expect(firstFinished).toBe(true);
    expect(secondFinished).toBe(true);
  });

  it("continues a partial paginated turn from its earliest resident event", async () => {
    await loadPreviousExternalReplayTurnSlice("codexapp-session", 7);

    expect(mocks.previousTurnSliceStart).toHaveBeenCalledWith(
      "codexapp-session",
      7
    );
    expect(mocks.readWindow).toHaveBeenCalledWith({
      sessionId: "codexapp-session",
      episodeId: 41,
      beforeSequence: 251,
      limits: {
        maxTurns: 1,
        maxEvents: 200,
        maxIpcBytes: 4 * 1024 * 1024,
      },
    });
  });

  it("starts a fresh read when A reopens with a new foreground episode", async () => {
    const sessionId = "codexapp-session";
    const oldRead = deferredWindow();
    const reopenedRead = deferredWindow();
    mocks.readWindow
      .mockReturnValueOnce(oldRead.promise)
      .mockReturnValueOnce(reopenedRead.promise);

    mocks.setLeaseEpisodeId(sessionId, 41);
    const oldEpisode = mocks.captureEpisode(sessionId);
    const first = loadPreviousExternalReplayWindow(sessionId);
    expect(mocks.readWindow).toHaveBeenCalledTimes(1);

    // A → B → A gives A both a new renderer episode and a new Rust lease.
    // The old Promise is still pending, so a session-only key would reuse it
    // and the new A would never issue its own RPC.
    mocks.startEpisode("other-session", "g1");
    mocks.startEpisode(sessionId, "g1");
    mocks.setLeaseEpisodeId(sessionId, 42);
    const second = loadPreviousExternalReplayWindow(sessionId);

    expect(oldEpisode.id).not.toBe(mocks.captureEpisode(sessionId).id);
    expect(mocks.readWindow).toHaveBeenCalledTimes(2);
    expect(mocks.readWindow).toHaveBeenNthCalledWith(2, {
      sessionId,
      episodeId: 42,
      beforeSequence: 120,
      limits: {
        maxTurns: 10,
        maxEvents: 200,
        maxIpcBytes: 4 * 1024 * 1024,
      },
    });

    oldRead.resolve(replayWindow(sessionId));
    await first;
    expect(mocks.mergeWindow).not.toHaveBeenCalled();

    reopenedRead.resolve(replayWindow(sessionId));
    await second;
    expect(mocks.mergeWindow).toHaveBeenCalledTimes(1);
  });

  it("reopens authoritatively when an older page belongs to a new generation", async () => {
    mocks.readWindow.mockResolvedValue(
      replayWindow("codexapp-session", "g2", ["replacement-generation-event"])
    );
    mocks.openWindow.mockResolvedValue(replayWindow("codexapp-session", "g2"));

    await loadSessionTurnBodyIntoStore({
      sessionId: "codexapp-session",
      turnId: "__external_replay_turn_index__:0",
    });

    expect(mocks.openWindow).toHaveBeenCalledWith({
      sessionId: "codexapp-session",
      episodeId: 41,
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
