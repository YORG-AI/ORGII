import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import { loadPersistedHistory } from "../sessionSyncUtils";
import type { SessionAdapter } from "../types";

const cacheAdapterMock = vi.hoisted(() => ({
  loadInitialTurnWindow: vi.fn(),
  loadEvents: vi.fn(),
}));

vi.mock("@src/engines/SessionCore/storage/cacheAdapter", () => ({
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
});
