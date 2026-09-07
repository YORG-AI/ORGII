import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import { loadPersistedHistory } from "../sessionSyncUtils";
import type { SessionAdapter } from "../types";

const cacheAdapterMock = vi.hoisted(() => ({
  getSessionMetadata: vi.fn(),
  loadInitialTurnWindow: vi.fn(),
  loadEvents: vi.fn(),
}));

vi.mock("@src/engines/SessionCore/storage/cacheAdapter", () => ({
  getSessionMetadata: cacheAdapterMock.getSessionMetadata,
  loadInitialTurnWindow: cacheAdapterMock.loadInitialTurnWindow,
  loadEvents: cacheAdapterMock.loadEvents,
}));

function makeEvent(id: string): SessionEvent {
  return { id } as SessionEvent;
}

function makeAdapter(
  category: string,
  historyEvents: SessionEvent[]
): SessionAdapter {
  return {
    category,
    loadHistory: vi.fn(async () => historyEvents),
  } as unknown as SessionAdapter;
}

describe("loadPersistedHistory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cacheAdapterMock.getSessionMetadata.mockResolvedValue(null);
  });

  it("returns turn-window events when the event cache has rows", async () => {
    const events = [makeEvent("e1")];
    cacheAdapterMock.loadInitialTurnWindow.mockResolvedValue({
      turns: [{ turnId: "e1" }],
      events,
    });
    const adapter = makeAdapter("agent", [makeEvent("fallback")]);

    const result = await loadPersistedHistory(
      adapter,
      "sdeagent-x",
      new AbortController().signal
    );

    expect(result).toBe(events);
    expect(adapter.loadHistory).not.toHaveBeenCalled();
  });

  it("hydrates collaboration replays with lightweight turn summaries only", async () => {
    const events = [makeEvent("turn-header")];
    cacheAdapterMock.loadInitialTurnWindow.mockResolvedValue({
      turns: [{ turnId: "turn-header" }],
      events,
    });
    const adapter = makeAdapter("agent", []);

    const result = await loadPersistedHistory(
      adapter,
      "imported-session-large",
      new AbortController().signal
    );

    expect(result).toBe(events);
    expect(cacheAdapterMock.loadInitialTurnWindow).toHaveBeenCalledWith(
      "imported-session-large",
      0
    );
  });

  it("rehydrates a failed collaboration-replay send outside its turn window", async () => {
    const indexedHistory = [
      {
        ...makeEvent("imported-session-restart~native-user"),
        createdAt: "2026-09-05T10:00:00Z",
      },
      {
        ...makeEvent("imported-session-restart~native-assistant"),
        createdAt: "2026-09-05T10:00:01Z",
      },
    ];
    const failed = {
      ...makeEvent("queued-user:queued-cloud-follow-up:"),
      sessionId: "imported-session-restart",
      createdAt: "2026-09-05T10:01:00Z",
      source: "user",
      functionName: "user_message",
      displayStatus: "failed",
      result: {
        syntheticUserInput: true,
        deliveryStatus: "failed",
        deliveryError: "provider-native execution diverged",
        turnIntentId: "cloud-turn-failed",
        message: { role: "user", content: "queued follow-up" },
      },
    } as SessionEvent;
    cacheAdapterMock.loadInitialTurnWindow.mockResolvedValue({
      turns: [{ turnId: "indexed-native-turn" }],
      events: indexedHistory,
    });
    cacheAdapterMock.getSessionMetadata.mockResolvedValue({
      sessionId: "imported-session-restart",
      eventCount: 3,
      cachedAt: 1,
    });
    cacheAdapterMock.loadEvents.mockResolvedValue([...indexedHistory, failed]);
    const adapter = makeAdapter("agent", []);

    const result = await loadPersistedHistory(
      adapter,
      "imported-session-restart",
      new AbortController().signal
    );

    expect(result.map((event) => event.id)).toEqual([
      "imported-session-restart~native-user",
      "imported-session-restart~native-assistant",
      "queued-user:queued-cloud-follow-up:",
    ]);
    expect(result[2]).toBe(failed);
    expect(adapter.loadHistory).not.toHaveBeenCalled();
    expect(cacheAdapterMock.loadEvents).toHaveBeenCalledWith(
      "imported-session-restart"
    );
  });

  it("falls back to adapter.loadHistory when the event cache is empty", async () => {
    cacheAdapterMock.loadInitialTurnWindow.mockResolvedValue({
      turns: [],
      events: [],
    });
    cacheAdapterMock.loadEvents.mockResolvedValue([]);
    const fallback = [makeEvent("from-agent-messages")];
    const adapter = makeAdapter("agent", fallback);

    const result = await loadPersistedHistory(
      adapter,
      "sdeagent-x",
      new AbortController().signal
    );

    expect(result).toBe(fallback);
    expect(adapter.loadHistory).toHaveBeenCalledTimes(1);
  });

  it("does not fall back when the signal is already aborted", async () => {
    cacheAdapterMock.loadInitialTurnWindow.mockResolvedValue({
      turns: [],
      events: [],
    });
    cacheAdapterMock.loadEvents.mockResolvedValue([]);
    const adapter = makeAdapter("agent", [makeEvent("fallback")]);
    const controller = new AbortController();
    controller.abort();

    const result = await loadPersistedHistory(
      adapter,
      "sdeagent-x",
      controller.signal
    );

    expect(result).toEqual([]);
    expect(adapter.loadHistory).not.toHaveBeenCalled();
  });

  it("uses adapter.loadHistory directly for non-agent categories", async () => {
    const fallback = [makeEvent("cli")];
    const adapter = makeAdapter("cli", fallback);

    const result = await loadPersistedHistory(
      adapter,
      "cli-x",
      new AbortController().signal
    );

    expect(result).toBe(fallback);
    expect(cacheAdapterMock.loadInitialTurnWindow).not.toHaveBeenCalled();
  });

  it("rehydrates a failed CLI user turn beside native history after restart", async () => {
    const nativeHistory = [
      {
        ...makeEvent("native-user"),
        createdAt: "2026-09-05T10:00:00Z",
      },
      {
        ...makeEvent("native-assistant"),
        createdAt: "2026-09-05T10:00:01Z",
      },
    ];
    const failed = {
      ...makeEvent("queued-user:q1:"),
      sessionId: "cliagent-restart",
      createdAt: "2026-09-05T10:01:00Z",
      source: "user",
      functionName: "user_message",
      displayStatus: "failed",
      result: {
        syntheticUserInput: true,
        deliveryStatus: "failed",
        deliveryError: "provider unavailable",
        turnIntentId: "turn-failed",
        message: { role: "user", content: "please retry" },
      },
    } as SessionEvent;
    cacheAdapterMock.getSessionMetadata.mockResolvedValue({
      sessionId: "cliagent-restart",
      eventCount: 1,
      cachedAt: 1,
    });
    cacheAdapterMock.loadEvents.mockResolvedValue([failed]);
    const adapter = makeAdapter("cli", nativeHistory);

    const result = await loadPersistedHistory(
      adapter,
      "cliagent-restart",
      new AbortController().signal
    );

    expect(result.map((event) => event.id)).toEqual([
      "native-user",
      "native-assistant",
      "queued-user:q1:",
    ]);
    expect(result[2]).toBe(failed);
    expect(adapter.loadHistory).toHaveBeenCalledTimes(1);
    expect(cacheAdapterMock.loadEvents).toHaveBeenCalledWith(
      "cliagent-restart"
    );
  });

  it("does not reparse native CLI history through an empty event cache", async () => {
    const history = [makeEvent("native")];
    const adapter = makeAdapter("cli", history);

    const result = await loadPersistedHistory(
      adapter,
      "cliagent-no-overlay",
      new AbortController().signal
    );

    expect(result).toBe(history);
    expect(cacheAdapterMock.loadEvents).not.toHaveBeenCalled();
  });
});
