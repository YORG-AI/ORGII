import { beforeEach, describe, expect, it, vi } from "vitest";

import { IMPORTED_HISTORY_SOURCE_DESCRIPTORS } from "@src/api/tauri/externalHistory/imported";

import { openBoundedReplaySessionForE2E } from "./openBoundedReplaySession";

const mocks = vi.hoisted(() => ({
  activate: vi.fn(),
  deactivate: vi.fn(),
  getEvents: vi.fn(),
  mergeTurnWindow: vi.fn(),
  open: vi.fn(),
  startTurnEpisode: vi.fn(),
}));

vi.mock("@src/engines/SessionCore/core/store/EventStoreProxy", () => ({
  eventStoreProxy: { getEvents: mocks.getEvents },
}));

vi.mock("@src/engines/SessionCore/sync/externalReplayTransport", () => ({
  activateExternalReplaySession: mocks.activate,
  deactivateExternalReplaySession: mocks.deactivate,
  openExternalReplaySession: mocks.open,
}));

vi.mock("@src/engines/SessionCore/sync/externalReplayTurnState", () => ({
  mergeExternalReplayTurnWindow: mocks.mergeTurnWindow,
  startExternalReplayTurnEpisode: mocks.startTurnEpisode,
}));

describe("openBoundedReplaySessionForE2E", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.activate.mockImplementation((sessionId: string) => ({
      sessionId,
      epoch: 1,
      signal: new AbortController().signal,
    }));
    mocks.open.mockImplementation(async (lease: { sessionId: string }) => ({
      cursor: {
        sourceId: "codex_app",
        sessionId: lease.sessionId,
        generation: "generation-1",
        revision: 1,
        throughSequence: 1,
      },
      events: [],
      turnHeaders: [],
      totalTurnCount: 0,
      hasOlder: false,
      watcherAvailable: true,
      stats: { notReady: false },
    }));
  });

  it.each([
    ...IMPORTED_HISTORY_SOURCE_DESCRIPTORS.map(({ prefix, sourceId }) => ({
      sessionId: `${prefix}e2e-production-open`,
      sourceId,
    })),
    {
      sessionId: "imported-session-e2e-collaboration",
      sourceId: "collaboration_snapshot",
    },
  ])(
    "opens $sourceId through the production foreground transport",
    async ({ sessionId }) => {
      const opened = await openBoundedReplaySessionForE2E(sessionId);

      expect(mocks.activate).toHaveBeenCalledTimes(1);
      expect(mocks.activate).toHaveBeenCalledWith(sessionId);
      expect(mocks.open).toHaveBeenCalledTimes(1);
      expect(mocks.open).toHaveBeenCalledWith(opened?.lease);
      expect(mocks.startTurnEpisode).toHaveBeenCalledTimes(1);
      expect(mocks.startTurnEpisode).toHaveBeenCalledWith(
        sessionId,
        "generation-1"
      );
      expect(mocks.mergeTurnWindow).toHaveBeenCalledTimes(1);
      expect(mocks.deactivate).not.toHaveBeenCalled();
    }
  );

  it("does not activate bounded replay for a native SDE session", async () => {
    await expect(
      openBoundedReplaySessionForE2E("sdeagent-native-e2e")
    ).resolves.toBeNull();
    expect(mocks.activate).not.toHaveBeenCalled();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.mergeTurnWindow).not.toHaveBeenCalled();
  });

  it("keeps the managed CLI live EventStore projection while its binding is pending", async () => {
    const liveEvents = [{ id: "live-user" }];
    mocks.open.mockResolvedValueOnce({
      cursor: {
        sourceId: "managed_cli",
        sessionId: "cliagent-pending",
        generation: "pending",
        revision: 0,
        throughSequence: 0,
      },
      events: [],
      turnHeaders: [],
      totalTurnCount: 0,
      hasOlder: false,
      watcherAvailable: true,
      stats: { notReady: true },
    });
    mocks.getEvents.mockResolvedValueOnce(liveEvents);

    const opened = await openBoundedReplaySessionForE2E("cliagent-pending");

    expect(opened?.events).toBe(liveEvents);
    expect(mocks.getEvents).toHaveBeenCalledWith("cliagent-pending");
  });

  it("releases the foreground lease when production open fails", async () => {
    mocks.open.mockRejectedValueOnce(new Error("open failed"));

    await expect(
      openBoundedReplaySessionForE2E("codexapp-open-failure")
    ).rejects.toThrow("open failed");
    expect(mocks.deactivate).toHaveBeenCalledTimes(1);
    expect(mocks.deactivate).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "codexapp-open-failure" })
    );
  });
});
