import { createStore } from "jotai";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  derivedSnapshotAtom,
  streamingDeltaContentAtom,
} from "@src/engines/SessionCore/core/atoms/events";
import {
  pendingSyntheticEventAtom,
  sessionIdAtom,
} from "@src/engines/SessionCore/core/atoms/metadata";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { chatEventsAtom } from "@src/engines/SessionCore/derived/chatEvents";
import { messagesEventsAtom } from "@src/engines/SessionCore/derived/simulatorEvents";
import { messageQueueAtom } from "@src/store/ui/messageQueueAtom";

function makeSnapshot(chatEvents: SessionEvent[] = [], streaming = true) {
  return {
    version: 1,
    eventCount: chatEvents.length,
    events: chatEvents,
    chatEvents,
    messagesEvents: chatEvents,
    sortedSimulatorEvents: [],
    lastEvent: chatEvents.at(-1) ?? null,
    eventIndex: Object.fromEntries(
      chatEvents.map((event, index) => [event.id, index])
    ),
    chatEventCount: chatEvents.length,
    hasRunningEvent: streaming,
    streaming,
  };
}

function makeChatEvent(
  id: string,
  createdAt: string,
  overrides: Partial<SessionEvent> = {}
): SessionEvent {
  return {
    id,
    chunk_id: null,
    sessionId: "session-1",
    createdAt,
    functionName: "thinking",
    uiCanonical: "thinking",
    actionType: "llm_thinking",
    args: {},
    result: { observation: id },
    source: "assistant",
    displayText: id,
    displayStatus: "completed",
    displayVariant: "thinking",
    activityStatus: "agent",
    ...overrides,
  };
}

function setLiveContent(
  store: ReturnType<typeof createStore>,
  sessionId: string,
  content: string
) {
  store.set(
    streamingDeltaContentAtom,
    new Map([[sessionId, { kind: "message" as const, content }]])
  );
}

afterEach(() => {
  const store = createStore();
  store.set(sessionIdAtom, "session-1");
  store.set(streamingDeltaContentAtom, new Map());
  store.get(chatEventsAtom);
  vi.useRealTimers();
});

describe("chatEventsAtom live streaming overlay", () => {
  it("projects a durable queued turn immediately and replaces it by intent identity", () => {
    const store = createStore();
    store.set(sessionIdAtom, "session-1");
    store.set(derivedSnapshotAtom, makeSnapshot([], false));
    store.set(messageQueueAtom, [
      {
        id: "queue-1",
        turnIntentId: "turn-queued",
        sessionId: "session-1",
        content: "same request",
        displayContent: "same request",
        priority: "next",
        status: "queued",
        createdAt: "2026-06-06T20:00:01.000Z",
      },
    ]);

    expect(store.get(chatEventsAtom)).toEqual([
      expect.objectContaining({
        id: "queued-user-turn-queued",
        displayText: "same request",
        displayStatus: "pending",
        result: expect.objectContaining({
          deliveryStatus: "pending",
          queueMessageId: "queue-1",
          turnIntentId: "turn-queued",
        }),
      }),
    ]);

    const providerRow = makeChatEvent(
      "provider-user-turn-queued",
      "2026-06-06T20:00:02.000Z",
      {
        source: "user",
        functionName: "user",
        displayVariant: "message",
        displayText: "same request",
        result: {
          turnIntentId: "turn-queued",
          message: { content: "same request", role: "user" },
        },
      }
    );
    store.set(derivedSnapshotAtom, makeSnapshot([providerRow], false));
    expect(store.get(chatEventsAtom)).toEqual([providerRow]);
  });

  it("projects a held durable delivery failure as failed after hydration", () => {
    const store = createStore();
    store.set(sessionIdAtom, "session-1");
    store.set(derivedSnapshotAtom, makeSnapshot([], false));
    store.set(messageQueueAtom, [
      {
        id: "queue-failed",
        turnIntentId: "turn-failed",
        sessionId: "session-1",
        content: "retry this request",
        displayContent: "retry this request",
        priority: "next",
        requiresExplicitDispatch: true,
        status: "queued",
        deliveryError: "provider unavailable",
        createdAt: "2026-06-06T20:00:01.000Z",
      },
    ]);

    expect(store.get(chatEventsAtom)).toEqual([
      expect.objectContaining({
        id: "queued-user-turn-failed",
        displayText: "retry this request",
        displayStatus: "failed",
        result: expect.objectContaining({
          deliveryStatus: "failed",
          deliveryError: "provider unavailable",
          queueMessageId: "queue-failed",
          turnIntentId: "turn-failed",
        }),
      }),
    ]);
  });

  it("overlays a durable delivery failure onto its unpatched optimistic row", () => {
    const store = createStore();
    store.set(sessionIdAtom, "session-1");
    const optimisticRow = makeChatEvent(
      "queued-user:queue-stale:",
      "2026-06-06T20:00:01.000Z",
      {
        source: "user",
        functionName: "user",
        displayVariant: "message",
        displayStatus: "pending",
        displayText: "retry this request",
        result: {
          deliveryStatus: "pending",
          queueMessageId: "queue-stale",
          turnIntentId: "turn-stale",
          message: { content: "retry this request", role: "user" },
        },
      }
    );
    store.set(derivedSnapshotAtom, makeSnapshot([optimisticRow], false));
    store.set(messageQueueAtom, [
      {
        id: "queue-stale",
        turnIntentId: "turn-stale",
        sessionId: "session-1",
        content: "retry this request",
        displayContent: "retry this request",
        priority: "next",
        requiresExplicitDispatch: true,
        status: "queued",
        deliveryError: "shared session is no longer available",
        createdAt: "2026-06-06T20:00:01.000Z",
      },
    ]);

    expect(store.get(chatEventsAtom)).toEqual([
      expect.objectContaining({
        id: "queued-user:queue-stale:",
        displayStatus: "failed",
        result: expect.objectContaining({
          deliveryStatus: "failed",
          deliveryError: "shared session is no longer available",
          queueMessageId: "queue-stale",
          turnIntentId: "turn-stale",
        }),
      }),
    ]);
  });

  it("suppresses the pending overlay after the provider's real user echo", () => {
    const store = createStore();
    const pending = makeChatEvent(
      "user-input-pending",
      "2026-06-06T20:00:01.000Z",
      {
        source: "user",
        functionName: "user_message",
        uiCanonical: "",
        actionType: "user_message",
        displayText: "next request",
        result: { syntheticUserInput: true, message: "next request" },
        displayVariant: "message",
      }
    );
    const echo = makeChatEvent(
      "provider-user-echo",
      "2026-06-06T20:00:02.000Z",
      {
        source: "user",
        functionName: "user",
        uiCanonical: "user",
        actionType: "user_message",
        displayText: "next request",
        result: { message: { content: "next request" } },
        displayVariant: "message",
      }
    );
    store.set(sessionIdAtom, "session-1");
    store.set(pendingSyntheticEventAtom, pending);
    store.set(derivedSnapshotAtom, makeSnapshot([echo], false));

    expect(store.get(chatEventsAtom)).toEqual([echo]);
  });

  it("renders live assistant text without writing a durable EventStore event", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-06T20:00:00.000Z"));
    const store = createStore();
    store.set(sessionIdAtom, "session-1");
    store.set(derivedSnapshotAtom, makeSnapshot());

    setLiveContent(store, "session-1", "hello live");

    expect(store.get(chatEventsAtom)).toEqual([
      expect.objectContaining({
        id: "live-assistant-session-1",
        sessionId: "session-1",
        createdAt: "2026-06-06T20:00:00.000Z",
        functionName: "agent_message",
        displayText: "\u200b",
        displayStatus: "running",
        args: { syntheticLive: true },
        isDelta: true,
      }),
    ]);
  });

  it("renders live assistant text in Agent Station messages events", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-06T20:00:00.000Z"));
    const store = createStore();
    store.set(sessionIdAtom, "session-1");
    store.set(derivedSnapshotAtom, makeSnapshot());

    setLiveContent(store, "session-1", "hello station");

    expect(store.get(messagesEventsAtom)).toEqual([
      expect.objectContaining({
        id: "live-assistant-session-1",
        sessionId: "session-1",
        createdAt: "2026-06-06T20:00:00.000Z",
        functionName: "agent_message",
        displayText: "hello station",
        displayStatus: "running",
        args: { syntheticLive: true },
        isDelta: true,
      }),
    ]);
  });

  it("does not render live thinking as an Agent Station assistant message", () => {
    const store = createStore();
    store.set(sessionIdAtom, "session-1");
    store.set(derivedSnapshotAtom, makeSnapshot());
    store.set(
      streamingDeltaContentAtom,
      new Map([
        [
          "session-1",
          { kind: "thinking" as const, content: "reasoning token" },
        ],
      ])
    );

    expect(store.get(messagesEventsAtom)).toEqual([]);
  });

  it("keeps the live assistant after existing thinking and preserves first-live timestamp", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-06T20:01:00.000Z"));
    const store = createStore();
    store.set(sessionIdAtom, "session-1");
    store.set(
      derivedSnapshotAtom,
      makeSnapshot([makeChatEvent("thinking-1", "2026-06-06T20:00:58.000Z")])
    );

    setLiveContent(store, "session-1", "first token");
    const first = store.get(chatEventsAtom);
    expect(first.map((event) => event.id)).toEqual([
      "thinking-1",
      "live-assistant-session-1",
    ]);
    const firstLiveCreatedAt = first.at(-1)?.createdAt;
    expect(firstLiveCreatedAt).toBe("2026-06-06T20:01:00.000Z");

    vi.setSystemTime(new Date("2026-06-06T20:01:30.000Z"));
    setLiveContent(store, "session-1", "first token plus more");
    const second = store.get(chatEventsAtom);

    expect(second.map((event) => event.id)).toEqual([
      "thinking-1",
      "live-assistant-session-1",
    ]);
    expect(second.at(-1)?.createdAt).toBe(firstLiveCreatedAt);
    expect(second.at(-1)?.displayText).toBe("\u200b");
  });

  it("keeps the live assistant after newly arriving durable events while streaming", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-06T20:04:00.000Z"));
    const store = createStore();
    store.set(sessionIdAtom, "session-1");
    store.set(
      derivedSnapshotAtom,
      makeSnapshot([makeChatEvent("thinking-1", "2026-06-06T20:03:59.000Z")])
    );

    setLiveContent(store, "session-1", "live answer");
    store.set(
      derivedSnapshotAtom,
      makeSnapshot([
        makeChatEvent("thinking-1", "2026-06-06T20:03:59.000Z"),
        makeChatEvent("turn-summary-1", "2026-06-06T20:04:20.000Z", {
          functionName: "turn_summary",
          uiCanonical: "turn_summary",
          actionType: "turn_summary",
          displayVariant: "summary",
        }),
      ])
    );

    expect(store.get(chatEventsAtom).map((event) => event.id)).toEqual([
      "thinking-1",
      "turn-summary-1",
      "live-assistant-session-1",
    ]);
  });

  it("does not render a stale synthetic live duplicate once final assistant is durable", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-06T20:05:00.000Z"));
    const store = createStore();
    store.set(sessionIdAtom, "session-1");
    store.set(derivedSnapshotAtom, makeSnapshot());

    setLiveContent(store, "session-1", "final answer");
    expect(store.get(chatEventsAtom).map((event) => event.id)).toEqual([
      "live-assistant-session-1",
    ]);

    store.set(
      derivedSnapshotAtom,
      makeSnapshot([
        makeChatEvent("assistant-final-1", "2026-06-06T20:05:10.000Z", {
          functionName: "agent_message",
          uiCanonical: "assistant_message",
          actionType: "assistant",
          result: { observation: "final answer" },
          displayText: "final answer",
          displayStatus: "completed",
          displayVariant: "message",
          isDelta: false,
        }),
      ])
    );

    expect(store.get(chatEventsAtom).map((event) => event.id)).toEqual([
      "assistant-final-1",
    ]);
  });

  it("clears live timestamp when streaming content is removed", () => {
    vi.useFakeTimers();
    const store = createStore();
    store.set(sessionIdAtom, "session-1");
    store.set(derivedSnapshotAtom, makeSnapshot());

    vi.setSystemTime(new Date("2026-06-06T20:02:00.000Z"));
    setLiveContent(store, "session-1", "turn one");
    expect(store.get(chatEventsAtom).at(-1)?.createdAt).toBe(
      "2026-06-06T20:02:00.000Z"
    );

    store.set(streamingDeltaContentAtom, new Map());
    store.set(derivedSnapshotAtom, makeSnapshot([], false));
    expect(store.get(chatEventsAtom)).toEqual([]);

    vi.setSystemTime(new Date("2026-06-06T20:03:00.000Z"));
    store.set(derivedSnapshotAtom, makeSnapshot());
    setLiveContent(store, "session-1", "turn two");
    expect(store.get(chatEventsAtom).at(-1)?.createdAt).toBe(
      "2026-06-06T20:03:00.000Z"
    );
  });
});
