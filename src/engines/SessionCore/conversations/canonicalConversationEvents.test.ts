import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import { loadCanonicalConversationEvents } from "./canonicalConversationEvents";

const mocks = vi.hoisted(() => ({
  cliStatus: vi.fn(),
  loadAuthoritative: vi.fn(),
  getPersistedEvents: vi.fn(),
  mergeInterrupted: vi.fn(),
}));

vi.mock("@src/api/tauri/rpc", () => ({
  rpc: { cli: { status: mocks.cliStatus } },
}));
vi.mock("@src/engines/SessionCore/sync/authoritativeSessionEvents", () => ({
  loadAuthoritativeSessionEvents: mocks.loadAuthoritative,
}));
vi.mock("@src/engines/SessionCore/core/store/EventStoreProxy", () => ({
  eventStoreProxy: { getPersistedEvents: mocks.getPersistedEvents },
}));
vi.mock("./nativeConversationMaterializer", () => ({
  mergeInterruptedConversationProjection: mocks.mergeInterrupted,
}));

function event(id: string): SessionEvent {
  return {
    id,
    chunk_id: id,
    sessionId: "cliagent-test",
    createdAt: "2026-08-30T00:00:00.000Z",
    functionName: "assistant_message",
    uiCanonical: "assistant_message",
    actionType: "assistant",
    args: {},
    result: { content: id },
    source: "assistant",
    displayText: id,
    displayStatus: "completed",
    displayVariant: "message",
    activityStatus: "agent",
  };
}

describe("loadCanonicalConversationEvents", () => {
  const native = [event("native")];
  const projected = [...native, event("partial")];
  const merged = [...native, event("merged-partial")];

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadAuthoritative.mockResolvedValue({
      events: native,
      source: "cli_history",
    });
    mocks.getPersistedEvents.mockResolvedValue(projected);
    mocks.mergeInterrupted.mockReturnValue(merged);
  });

  it.each(["failed", "error", "timeout", "cancelled", "abandoned"])(
    "preserves the durable partial suffix for %s terminal sessions",
    async (status) => {
      mocks.cliStatus.mockResolvedValue({ status });

      await expect(
        loadCanonicalConversationEvents("cliagent-test")
      ).resolves.toEqual({ events: merged, source: "cli_history" });
      expect(mocks.getPersistedEvents).toHaveBeenCalledWith("cliagent-test");
      expect(mocks.mergeInterrupted).toHaveBeenCalledWith(native, projected);
    }
  );

  it.each(["completed", "archived", "running", "unknown"])(
    "keeps the native-only path for %s sessions",
    async (status) => {
      mocks.cliStatus.mockResolvedValue({ status });

      await expect(
        loadCanonicalConversationEvents("cliagent-test")
      ).resolves.toEqual({ events: native, source: "cli_history" });
      expect(mocks.getPersistedEvents).not.toHaveBeenCalled();
      expect(mocks.mergeInterrupted).not.toHaveBeenCalled();
    }
  );

  it.each(["failed", "error", "timeout", "cancelled", "abandoned"])(
    "recovers the durable partial projection when native history is unavailable for %s sessions",
    async (status) => {
      const nativeError = new Error("native transcript unavailable");
      mocks.loadAuthoritative.mockRejectedValue(nativeError);
      mocks.cliStatus.mockResolvedValue({ status });

      await expect(
        loadCanonicalConversationEvents("cliagent-test")
      ).resolves.toEqual({ events: merged, source: "cli_history" });
      expect(mocks.getPersistedEvents).toHaveBeenCalledWith("cliagent-test");
      expect(mocks.mergeInterrupted).toHaveBeenCalledWith([], projected);
    }
  );

  it.each(["completed", "archived", "running", "unknown"])(
    "fails closed when native history is unavailable for %s sessions",
    async (status) => {
      const nativeError = new Error("native transcript unavailable");
      mocks.loadAuthoritative.mockRejectedValue(nativeError);
      mocks.cliStatus.mockResolvedValue({ status });

      await expect(
        loadCanonicalConversationEvents("cliagent-test")
      ).rejects.toBe(nativeError);
      expect(mocks.getPersistedEvents).not.toHaveBeenCalled();
      expect(mocks.mergeInterrupted).not.toHaveBeenCalled();
    }
  );

  it("fails closed when the EventStore fallback is unavailable", async () => {
    const nativeError = new Error("native transcript unavailable");
    const eventStoreError = new Error("EventStore unavailable");
    mocks.loadAuthoritative.mockRejectedValue(nativeError);
    mocks.cliStatus.mockResolvedValue({ status: "failed" });
    mocks.getPersistedEvents.mockRejectedValue(eventStoreError);

    await expect(loadCanonicalConversationEvents("cliagent-test")).rejects.toBe(
      eventStoreError
    );
    expect(mocks.mergeInterrupted).not.toHaveBeenCalled();
  });
});
