import { createStore } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { chatEventsForSessionAtomFamily } from "@src/engines/SessionCore/derived/sessionScopedChatEvents";

const subscribers = new Map<string, (snapshot: unknown) => void>();

vi.mock("@src/engines/SessionCore/core/store/EventStoreProxy", () => ({
  eventStoreProxy: {
    getLatestSessionSnapshot: () => null,
    subscribeSession: (
      sessionId: string,
      listener: (snapshot: unknown) => void
    ) => {
      subscribers.set(sessionId, listener);
      return () => subscribers.delete(sessionId);
    },
    loadFromCache: () => Promise.resolve(),
  },
  isStreamingSnapshot: (snapshot: unknown) =>
    Boolean(
      (snapshot as { streaming?: boolean; events?: unknown })?.streaming &&
      !("events" in (snapshot as object))
    ),
  isSnapshotActivelyStreaming: (snapshot: unknown) =>
    Boolean((snapshot as { streaming?: boolean })?.streaming),
}));

function chatEvent(
  id: string,
  displayText: string,
  overrides: Partial<SessionEvent> = {}
): SessionEvent {
  return {
    id,
    chunk_id: id,
    sessionId: "session-1",
    createdAt: "2026-06-18T00:00:00.000Z",
    functionName: "agent_message",
    uiCanonical: "agent_message",
    actionType: "assistant",
    args: {},
    result: { observation: displayText },
    source: "assistant",
    displayText,
    displayStatus: "running",
    displayVariant: "message",
    activityStatus: "agent",
    isDelta: true,
    ...overrides,
  } as SessionEvent;
}

function streamingSnapshot(version: number, chatEvents: SessionEvent[]) {
  return {
    version,
    eventCount: chatEvents.length,
    chatEvents,
    sortedSimulatorEvents: [],
    lastEvent: chatEvents.at(-1) ?? null,
    streaming: true,
    hasRunningEvent: true,
  };
}

describe("chatEventsForSessionAtomFamily streaming stability", () => {
  let store: ReturnType<typeof createStore>;

  beforeEach(() => {
    store = createStore();
  });

  afterEach(() => {
    subscribers.clear();
  });

  it("keeps the same array reference when only last-delta displayText grows", async () => {
    const sessionId = "stability-stream";
    const chatAtom = chatEventsForSessionAtomFamily(sessionId);
    const unsub = store.sub(chatAtom, () => {});
    await Promise.resolve();

    const listener = subscribers.get(sessionId);
    expect(listener).toBeDefined();

    listener?.(streamingSnapshot(1, [chatEvent("live-1", "Hel")]));
    const first = store.get(chatAtom);

    listener?.(streamingSnapshot(2, [chatEvent("live-1", "Hello world")]));
    const second = store.get(chatAtom);

    expect(second).toBe(first);
    unsub();
  });

  it("returns a new array when the last event completes", async () => {
    const sessionId = "stability-complete";
    const chatAtom = chatEventsForSessionAtomFamily(sessionId);
    const unsub = store.sub(chatAtom, () => {});
    await Promise.resolve();

    const listener = subscribers.get(sessionId);
    listener?.(streamingSnapshot(1, [chatEvent("live-1", "Hello")]));
    const first = store.get(chatAtom);

    listener?.(
      streamingSnapshot(2, [
        chatEvent("live-1", "Hello", {
          isDelta: false,
          displayStatus: "completed",
        }),
      ])
    );
    const second = store.get(chatAtom);

    expect(second).not.toBe(first);
    expect(second.find((event) => event.id === "live-1")?.displayStatus).toBe(
      "completed"
    );
    unsub();
  });
});
