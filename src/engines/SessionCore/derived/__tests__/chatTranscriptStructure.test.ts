import { describe, expect, it } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import {
  areChatTranscriptsStructurallyEqual,
  chatTranscriptStructureKey,
  createChatTranscriptVersionTracker,
} from "../chatTranscriptStructure";

function event(
  id: string,
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
    result: { observation: id },
    source: "assistant",
    displayText: id,
    displayStatus: "completed",
    displayVariant: "message",
    activityStatus: "agent",
    ...overrides,
  } as SessionEvent;
}

describe("chatTranscriptStructureKey", () => {
  it("returns a stable empty key", () => {
    expect(chatTranscriptStructureKey([])).toBe("0");
  });

  it("ignores displayText growth on the last delta event", () => {
    const before = [
      event("user-1", { source: "user", displayVariant: "message" }),
      event("live-1", {
        isDelta: true,
        displayStatus: "running",
        displayText: "Hel",
      }),
    ];
    const after = [
      event("user-1", { source: "user", displayVariant: "message" }),
      event("live-1", {
        isDelta: true,
        displayStatus: "running",
        displayText: "Hello world",
      }),
    ];
    expect(chatTranscriptStructureKey(before)).toBe(
      chatTranscriptStructureKey(after)
    );
  });

  it("changes when a completed event's displayText changes", () => {
    const before = [event("msg-1", { displayText: "old" })];
    const after = [event("msg-1", { displayText: "new" })];
    expect(chatTranscriptStructureKey(before)).not.toBe(
      chatTranscriptStructureKey(after)
    );
  });
});

describe("createChatTranscriptVersionTracker", () => {
  it("does not bump for token-only last-delta growth", () => {
    const tracker = createChatTranscriptVersionTracker();
    const first = tracker.next([
      event("live-1", {
        isDelta: true,
        displayStatus: "running",
        displayText: "Hel",
      }),
    ]);
    const second = tracker.next([
      event("live-1", {
        isDelta: true,
        displayStatus: "running",
        displayText: "Hello",
      }),
    ]);
    expect(second).toBe(first);
  });

  it("bumps when an event id or status changes", () => {
    const tracker = createChatTranscriptVersionTracker();
    const first = tracker.next([
      event("live-1", { isDelta: true, displayStatus: "running" }),
    ]);
    const second = tracker.next([
      event("live-1", { isDelta: false, displayStatus: "completed" }),
    ]);
    expect(second).toBe(first + 1);
  });
});

describe("areChatTranscriptsStructurallyEqual", () => {
  it("treats streaming last-event displayText as equal", () => {
    const prev = [
      event("live-1", {
        isDelta: true,
        displayStatus: "running",
        displayText: "Hel",
      }),
    ];
    const next = [
      event("live-1", {
        isDelta: true,
        displayStatus: "running",
        displayText: "Hello",
      }),
    ];
    expect(areChatTranscriptsStructurallyEqual(next, prev, true)).toBe(true);
    expect(areChatTranscriptsStructurallyEqual(next, prev, false)).toBe(false);
  });
});
