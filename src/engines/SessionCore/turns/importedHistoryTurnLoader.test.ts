import { beforeEach, describe, expect, it, vi } from "vitest";

import { importedHistoryTurnLoader } from "./importedHistoryTurnLoader";

const mocks = vi.hoisted(() => ({
  loadWindows: vi.fn(),
  processChunks: vi.fn(),
  mergeRoundWindowEvents: vi.fn(),
}));

vi.mock("@src/api/tauri/externalHistory", () => ({
  importedHistoryTurnWindows: mocks.loadWindows,
}));

vi.mock("@src/engines/SessionCore/ingestion/rustBridge", () => ({
  processChunksRust: mocks.processChunks,
}));

vi.mock("@src/engines/SessionCore/core/store/EventStoreProxy", () => ({
  eventStoreProxy: {
    mergeRoundWindowEvents: mocks.mergeRoundWindowEvents,
  },
}));

describe("importedHistoryTurnLoader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("coalesces one page of turn requests into one native parse", async () => {
    mocks.loadWindows.mockResolvedValue([
      { turnId: "u1", chunks: [{ chunk_id: "a1" }] },
      { turnId: "u2", chunks: [{ chunk_id: "a2" }] },
    ]);
    mocks.processChunks.mockResolvedValue([{ id: "event-1" }]);

    await Promise.all([
      importedHistoryTurnLoader.loadTurnBodyIntoStore({
        sessionId: "claudecodeapp-session-1",
        turnId: "u1",
      }),
      importedHistoryTurnLoader.loadTurnBodyIntoStore({
        sessionId: "claudecodeapp-session-1",
        turnId: "u2",
      }),
    ]);

    expect(mocks.loadWindows).toHaveBeenCalledTimes(1);
    expect(mocks.loadWindows).toHaveBeenCalledWith({
      sessionId: "claudecodeapp-session-1",
      turnIds: ["u1", "u2"],
    });
    expect(mocks.processChunks).toHaveBeenCalledWith(
      [{ chunk_id: "a1" }, { chunk_id: "a2" }],
      "claudecodeapp-session-1"
    );
    expect(mocks.mergeRoundWindowEvents).toHaveBeenCalledWith(
      [{ id: "event-1" }],
      "claudecodeapp-session-1"
    );
  });

  it("serializes requests that arrive while a provider parse is in flight", async () => {
    let finishFirst: ((value: unknown[]) => void) | undefined;
    mocks.loadWindows
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFirst = resolve;
          })
      )
      .mockResolvedValueOnce([]);
    mocks.processChunks.mockResolvedValue([]);

    const first = importedHistoryTurnLoader.loadTurnBodyIntoStore({
      sessionId: "claudecodeapp-session-2",
      turnId: "u1",
    });
    await vi.waitFor(() => {
      expect(mocks.loadWindows).toHaveBeenCalledTimes(1);
    });

    const second = importedHistoryTurnLoader.loadTurnBodyIntoStore({
      sessionId: "claudecodeapp-session-2",
      turnId: "u2",
    });
    expect(mocks.loadWindows).toHaveBeenCalledTimes(1);

    finishFirst?.([]);
    await Promise.all([first, second]);

    expect(mocks.loadWindows).toHaveBeenCalledTimes(2);
    expect(mocks.loadWindows).toHaveBeenLastCalledWith({
      sessionId: "claudecodeapp-session-2",
      turnIds: ["u2"],
    });
  });

  it("does not claim native or source-specific window sessions", async () => {
    await importedHistoryTurnLoader.loadTurnBodyIntoStore({
      sessionId: "codexapp-session-1",
      turnId: "u1",
    });
    await importedHistoryTurnLoader.loadTurnBodyIntoStore({
      sessionId: "sdeagent-session-1",
      turnId: "u1",
    });

    expect(mocks.loadWindows).not.toHaveBeenCalled();
  });
});
