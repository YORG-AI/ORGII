import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadSubmissionProjectionEvents } from "./useSubmissionsData";

const mocks = vi.hoisted(() => ({
  loadEvents: vi.fn(),
  queryWindow: vi.fn(),
  resolveSecondary: vi.fn(),
}));

vi.mock("@src/engines/SessionCore/storage/cacheAdapter", () => ({
  loadEvents: mocks.loadEvents,
}));

vi.mock("@src/api/tauri/externalHistory/replay", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@src/api/tauri/externalHistory/replay")
    >();
  return {
    ...actual,
    externalReplayQueryWindowForTarget: mocks.queryWindow,
    resolveSecondaryReplayTarget: mocks.resolveSecondary,
  };
});

function boundedWindow(sessionId: string) {
  return {
    events: [{ id: `${sessionId}-event`, sessionId }],
  };
}

describe("loadSubmissionProjectionEvents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.queryWindow.mockImplementation(
      ({ target }: { target: { sessionId: string } }) =>
        Promise.resolve(boundedWindow(target.sessionId))
    );
    mocks.resolveSecondary.mockResolvedValue(null);
    mocks.loadEvents.mockResolvedValue([]);
  });

  it.each([
    "codexapp-session",
    "claudecodeapp-session",
    "opencodeapp-session",
    "clineapp-session",
    "cliagent-session",
    "imported-session-snapshot",
  ])("uses a bounded projection for %s", async (sessionId) => {
    await expect(loadSubmissionProjectionEvents(sessionId)).resolves.toEqual(
      boundedWindow(sessionId).events
    );
    expect(mocks.queryWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({ sessionId }),
        limits: {
          maxTurns: 10,
          maxEvents: 200,
          maxIpcBytes: 4 * 1024 * 1024,
        },
      })
    );
    expect(mocks.resolveSecondary).not.toHaveBeenCalled();
    expect(mocks.loadEvents).not.toHaveBeenCalled();
  });

  it("uses the verified snapshot index for a Cloud-created native fork", async () => {
    const sessionId = "agentsession-cloud-fork";
    mocks.resolveSecondary.mockResolvedValue({
      sourceId: "collaboration_snapshot",
      sessionId,
    });

    await expect(loadSubmissionProjectionEvents(sessionId)).resolves.toEqual(
      boundedWindow(sessionId).events
    );
    expect(mocks.resolveSecondary).toHaveBeenCalledWith(sessionId);
    expect(mocks.queryWindow).toHaveBeenCalledWith({
      target: { sourceId: "collaboration_snapshot", sessionId },
      limits: {
        maxTurns: 10,
        maxEvents: 200,
        maxIpcBytes: 4 * 1024 * 1024,
      },
    });
    expect(mocks.loadEvents).not.toHaveBeenCalled();
  });

  it.each(["sdeagent-native", "agentsession-native"])(
    "keeps native persisted loading for %s",
    async (sessionId) => {
      await loadSubmissionProjectionEvents(sessionId);
      expect(mocks.loadEvents).toHaveBeenCalledWith(sessionId);
      expect(mocks.queryWindow).not.toHaveBeenCalled();
    }
  );
});
