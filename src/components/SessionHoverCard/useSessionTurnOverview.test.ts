import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  loadSessionTurnOverview,
  rememberTurnOverview,
} from "./useSessionTurnOverview";

const mocks = vi.hoisted(() => ({
  resolveSecondary: vi.fn(),
  queryWindowForTarget: vi.fn(),
  foregroundOpen: vi.fn(),
  loadTurnIndex: vi.fn(),
}));

vi.mock("@src/api/tauri/externalHistory/replay", () => ({
  resolveSecondaryReplayTarget: mocks.resolveSecondary,
  externalReplayQueryWindowForTarget: mocks.queryWindowForTarget,
  externalReplayOpenWindow: mocks.foregroundOpen,
}));

vi.mock("@src/engines/SessionCore/storage/cacheAdapter", () => ({
  loadTurnIndex: mocks.loadTurnIndex,
}));

describe("external replay hover overview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveSecondary.mockResolvedValue({
      sourceId: "codex_app",
      sessionId: "codexapp-hover-pure",
    });
    mocks.loadTurnIndex.mockResolvedValue([]);
  });

  it("queries one compact event without opening a foreground watcher/store", async () => {
    mocks.queryWindowForTarget.mockResolvedValue({
      cursor: {
        sourceId: "codex_app",
        sessionId: "codexapp-hover-pure",
        generation: "g1",
        revision: 3,
        throughSequence: 2,
      },
      events: [],
      turnHeaders: [],
      totalEventCount: 50,
      totalTurnCount: 12,
      hasOlder: true,
      watcherAvailable: false,
      stats: {
        parsedBytes: 0,
        parsedRows: 0,
        normalizedEvents: 0,
        upsertedEvents: 0,
        removedEvents: 0,
        ipcBytes: 512,
        notReady: false,
      },
    });

    await expect(
      loadSessionTurnOverview("codexapp-hover-pure", [])
    ).resolves.toEqual({ turnCount: 12, workedDurationMs: null });
    expect(mocks.queryWindowForTarget).toHaveBeenCalledWith({
      target: {
        sourceId: "codex_app",
        sessionId: "codexapp-hover-pure",
      },
      limits: { maxTurns: 1, maxEvents: 1, maxIpcBytes: 128 * 1024 },
    });
    expect(mocks.loadTurnIndex).not.toHaveBeenCalled();
    expect(mocks.foregroundOpen).not.toHaveBeenCalled();
  });

  it("does not let a session-only cache freeze an external turn count", async () => {
    rememberTurnOverview("codexapp-hover-pure", {
      turnCount: 1,
      workedDurationMs: null,
    });
    mocks.queryWindowForTarget.mockResolvedValue({
      cursor: {
        sourceId: "codex_app",
        sessionId: "codexapp-hover-pure",
        generation: "g2",
        revision: 9,
        throughSequence: 20,
      },
      events: [],
      turnHeaders: [],
      totalEventCount: 80,
      totalTurnCount: 21,
      hasOlder: true,
      watcherAvailable: false,
      stats: {
        parsedBytes: 0,
        parsedRows: 0,
        normalizedEvents: 0,
        upsertedEvents: 0,
        removedEvents: 0,
        ipcBytes: 512,
        notReady: false,
      },
    });

    await expect(
      loadSessionTurnOverview("codexapp-hover-pure", [])
    ).resolves.toEqual({ turnCount: 21, workedDurationMs: null });
    expect(mocks.queryWindowForTarget).toHaveBeenCalledOnce();
  });

  it("uses the verified secondary snapshot for a native collaboration fork", async () => {
    const target = {
      sourceId: "collaboration_snapshot",
      sessionId: "agentsession-cloud-fork",
    };
    mocks.resolveSecondary.mockResolvedValue(target);
    mocks.queryWindowForTarget.mockResolvedValue({
      cursor: {
        ...target,
        generation: "fork-g1",
        revision: 2,
        throughSequence: 400,
      },
      events: [],
      turnHeaders: [],
      totalEventCount: 2_000,
      totalTurnCount: 350,
      hasOlder: true,
      watcherAvailable: false,
      stats: {
        parsedBytes: 0,
        parsedRows: 0,
        normalizedEvents: 0,
        upsertedEvents: 0,
        removedEvents: 0,
        ipcBytes: 512,
        notReady: false,
      },
    });

    await expect(
      loadSessionTurnOverview("agentsession-cloud-fork", [])
    ).resolves.toEqual({ turnCount: 350, workedDurationMs: null });
    expect(mocks.queryWindowForTarget).toHaveBeenCalledWith({
      target,
      limits: { maxTurns: 1, maxEvents: 1, maxIpcBytes: 128 * 1024 },
    });
    expect(mocks.loadTurnIndex).not.toHaveBeenCalled();
  });

  it("keeps ordinary native sessions on the persisted turn index", async () => {
    mocks.resolveSecondary.mockResolvedValue(null);
    mocks.loadTurnIndex.mockResolvedValue([
      { durationMs: 700 },
      { durationMs: 500 },
    ]);

    await expect(
      loadSessionTurnOverview("sdeagent-native-hover", [])
    ).resolves.toEqual({ turnCount: 2, workedDurationMs: 1_200 });
    expect(mocks.loadTurnIndex).toHaveBeenCalledWith("sdeagent-native-hover");
    expect(mocks.queryWindowForTarget).not.toHaveBeenCalled();
  });
});
