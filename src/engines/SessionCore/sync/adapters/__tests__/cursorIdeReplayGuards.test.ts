import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ExternalReplayWindow } from "@src/api/tauri/externalHistory/replay";

import {
  ensureCursorIdeEventsInStore,
  ensureExternalReplayEventsInStore,
} from "../cursorIdeAdapter";

const mocks = vi.hoisted(() => ({
  queryWindow: vi.fn(),
  applyQueryWindow: vi.fn(async () => 0),
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
  externalReplayQueryWindow: mocks.queryWindow,
  externalReplayApplyQueryWindow: mocks.applyQueryWindow,
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

describe("Cursor IDE pure-query delivery guards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getLatestSessionSnapshot.mockReturnValue(null);
  });

  it("prewarms through the pure query and one explicit capped apply", async () => {
    mocks.queryWindow.mockResolvedValue(windowResult("g1", 7));

    await ensureCursorIdeEventsInStore("cursoride-guard-test", {
      forceReload: true,
    });

    expect(mocks.queryWindow).toHaveBeenCalledWith({
      sessionId: "cursoride-guard-test",
    });
    expect(mocks.applyQueryWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "cursoride-guard-test",
        generation: "g1",
        revision: 7,
        replace: true,
      })
    );
    expect(mocks.foregroundOpen).not.toHaveBeenCalled();
  });

  it("drops an A query that resolves after a newer A episode", async () => {
    const oldA = deferred<ExternalReplayWindow>();
    mocks.queryWindow
      .mockReturnValueOnce(oldA.promise)
      .mockResolvedValueOnce(windowResult("g2", 2));

    const stale = ensureCursorIdeEventsInStore("cursoride-guard-test", {
      forceReload: true,
    });
    const current = ensureCursorIdeEventsInStore("cursoride-guard-test", {
      forceReload: true,
    });
    await current;
    oldA.resolve(windowResult("g1", 1));
    await stale;

    expect(mocks.applyQueryWindow).toHaveBeenCalledTimes(1);
    expect(mocks.applyQueryWindow).toHaveBeenCalledWith(
      expect.objectContaining({ generation: "g2", revision: 2 })
    );
  });

  it("uses the same bounded prewarm for non-Cursor external sessions", async () => {
    const window = windowResult("codex-generation", 9);
    window.cursor.sourceId = "codex_app";
    window.cursor.sessionId = "codexapp-nested";
    mocks.queryWindow.mockResolvedValue(window);

    await ensureExternalReplayEventsInStore("codexapp-nested");

    expect(mocks.queryWindow).toHaveBeenCalledWith({
      sessionId: "codexapp-nested",
    });
    expect(mocks.applyQueryWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "codexapp-nested",
        generation: "codex-generation",
        replace: true,
      })
    );
  });

  it("never sends a native SDE session through external replay", async () => {
    await ensureExternalReplayEventsInStore("sdeagent-native");

    expect(mocks.queryWindow).not.toHaveBeenCalled();
    expect(mocks.applyQueryWindow).not.toHaveBeenCalled();
  });
});
