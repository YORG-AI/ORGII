import { beforeEach, describe, expect, it, vi } from "vitest";

import { refreshImportedHistorySession } from "./externalHistoryAutoRefresh";

const mocks = vi.hoisted(() => ({
  loadHistory: vi.fn(),
  getAdapterForSession: vi.fn(),
}));

vi.mock("./types", () => ({
  getAdapterForSession: mocks.getAdapterForSession,
}));

describe("refreshImportedHistorySession", () => {
  beforeEach(() => {
    mocks.loadHistory.mockReset();
    mocks.getAdapterForSession.mockReset().mockReturnValue({
      category: "external_history",
      loadHistory: mocks.loadHistory,
    });
  });

  it("reloads and publishes the currently open external transcript", async () => {
    const events = [
      {
        id: "event-1",
        sessionId: "codexapp-active",
        createdAt: "2026-07-16T05:00:00.000Z",
      },
    ];
    mocks.loadHistory.mockResolvedValue(events);
    const dispatchLoadSession = vi.fn();
    const controller = new AbortController();

    await expect(
      refreshImportedHistorySession(
        "codexapp-active",
        controller.signal,
        dispatchLoadSession
      )
    ).resolves.toBe(true);

    expect(mocks.loadHistory).toHaveBeenCalledWith(
      "codexapp-active",
      controller.signal
    );
    expect(dispatchLoadSession).toHaveBeenCalledWith({
      sessionId: "codexapp-active",
      events,
    });
  });

  it("does not poll a native ORGII session", async () => {
    await expect(
      refreshImportedHistorySession(
        "osagent-native",
        new AbortController().signal,
        vi.fn()
      )
    ).resolves.toBe(false);

    expect(mocks.getAdapterForSession).not.toHaveBeenCalled();
  });
});
