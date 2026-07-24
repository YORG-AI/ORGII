import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ExternalReplayWindow } from "@src/api/tauri/externalHistory/replay";

import { ensureExternalReplayEventsInStore } from "../externalReplayPrewarm";

const mocks = vi.hoisted(() => ({
  prewarmWindow: vi.fn(),
  getLatestSessionSnapshot: vi.fn(() => null),
  setAtom: vi.fn(),
  foregroundOpen: vi.fn(),
}));

vi.mock("@src/api/tauri/externalHistory/replay", () => ({
  resolveExternalReplayTarget: (sessionId: string) =>
    sessionId.startsWith("sdeagent-")
      ? null
      : {
          sourceId: sessionId.startsWith("cursoride-")
            ? "cursor_ide"
            : "codex_app",
          sessionId,
        },
  externalReplayPrewarmWindow: mocks.prewarmWindow,
  externalReplayOpenWindow: mocks.foregroundOpen,
}));

vi.mock("@src/engines/SessionCore/core/store/EventStoreProxy", () => ({
  eventStoreProxy: {
    getLatestSessionSnapshot: mocks.getLatestSessionSnapshot,
  },
}));

vi.mock("@src/util/core/state/instrumentedStore", () => ({
  getInstrumentedStore: () => ({ set: mocks.setAtom }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function windowResult(
  generation: string,
  revision: number
): ExternalReplayWindow {
  return {
    cursor: {
      sourceId: "cursor_ide",
      sessionId: "cursoride-guard-test",
      generation,
      revision,
      throughSequence: revision,
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

describe("external replay Rust-owned prewarm guards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getLatestSessionSnapshot.mockReturnValue(null);
  });

  it("prewarms through one Rust-owned bounded request", async () => {
    mocks.prewarmWindow.mockResolvedValue(windowResult("g1", 7));

    await ensureExternalReplayEventsInStore("cursoride-guard-test", {
      forceReload: true,
    });

    expect(mocks.prewarmWindow).toHaveBeenCalledWith(
      "cursoride-guard-test",
      expect.any(Number)
    );
    expect(mocks.setAtom).toHaveBeenCalledTimes(1);
    expect(mocks.foregroundOpen).not.toHaveBeenCalled();
  });

  it("drops an A prewarm result after a newer A episode", async () => {
    const oldA = deferred<ExternalReplayWindow>();
    mocks.prewarmWindow
      .mockReturnValueOnce(oldA.promise)
      .mockResolvedValueOnce(windowResult("g2", 2));

    const stale = ensureExternalReplayEventsInStore("cursoride-guard-test", {
      forceReload: true,
    });
    const current = ensureExternalReplayEventsInStore("cursoride-guard-test", {
      forceReload: true,
    });
    await current;
    oldA.resolve(windowResult("g1", 1));
    await stale;

    expect(mocks.setAtom).toHaveBeenCalledTimes(1);
    const firstEpisode = mocks.prewarmWindow.mock.calls[0]?.[1] as number;
    const secondEpisode = mocks.prewarmWindow.mock.calls[1]?.[1] as number;
    expect(secondEpisode).toBeGreaterThan(firstEpisode);
  });

  it("uses the same bounded prewarm for non-Cursor external sessions", async () => {
    const window = windowResult("codex-generation", 9);
    window.cursor.sourceId = "codex_app";
    window.cursor.sessionId = "codexapp-nested";
    mocks.prewarmWindow.mockResolvedValue(window);

    await ensureExternalReplayEventsInStore("codexapp-nested");

    expect(mocks.prewarmWindow).toHaveBeenCalledWith(
      "codexapp-nested",
      expect.any(Number)
    );
  });

  it("never sends a native SDE session through external replay", async () => {
    await ensureExternalReplayEventsInStore("sdeagent-native");

    expect(mocks.prewarmWindow).not.toHaveBeenCalled();
  });
});
