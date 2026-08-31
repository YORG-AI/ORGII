import { describe, expect, it } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import {
  buildOwnerUserRow,
  findUserEventByIntent,
  sliceOwnerTurnTail,
} from "./conversationOwnerPublisher";

function event(overrides: Partial<SessionEvent>): SessionEvent {
  return {
    id: "evt",
    chunk_id: "evt",
    sessionId: "owner-session",
    createdAt: "2026-08-21T10:00:00Z",
    functionName: "assistant_message",
    uiCanonical: "assistant_message",
    actionType: "assistant",
    args: {},
    result: {},
    source: "assistant",
    displayText: "hello",
    displayStatus: "completed",
    displayVariant: "message",
    activityStatus: "agent",
    payloadRefs: [],
    ...overrides,
  } as SessionEvent;
}

function userEvent(id: string, turnIntentId: string, synthetic = true) {
  return event({
    id,
    functionName: "user_message",
    source: "user",
    displayText: `ask ${turnIntentId}`,
    result: {
      type: "user",
      message: { content: `ask ${turnIntentId}`, role: "user" },
      ...(synthetic ? { syntheticUserInput: true } : {}),
      turnIntentId,
    },
  });
}

describe("findUserEventByIntent", () => {
  it("finds the user row minted for the dispatch and ignores other turns", () => {
    const events = [userEvent("u1", "tii-1"), userEvent("u2", "tii-2")];
    expect(findUserEventByIntent(events, "tii-2")?.id).toBe("u2");
    expect(findUserEventByIntent(events, "tii-9")).toBeNull();
  });
});

describe("buildOwnerUserRow", () => {
  it("pushes only the visible words under the local id and intent", () => {
    const local = userEvent("u1", "tii-1");
    const pushed = buildOwnerUserRow(local, "what the user typed");
    expect(pushed.id).toBe("u1");
    expect(pushed.displayText).toBe("what the user typed");
    expect(pushed.result).toEqual({
      type: "user",
      message: { content: "what the user typed", role: "user" },
      turnIntentId: "tii-1",
    });
    expect(pushed.createdAt).toBe(local.createdAt);
  });
});

describe("sliceOwnerTurnTail", () => {
  it("collects the agent rows after the turn's user row up to the next turn", () => {
    const events = [
      event({ id: "old-reply" }),
      userEvent("u1", "tii-1"),
      event({ id: "thinking-1", source: "assistant" }),
      userEvent("u1-backend", "tii-1", false),
      event({ id: "tool-1", source: "system" }),
      event({ id: "reply-1" }),
      userEvent("u2", "tii-2"),
      event({ id: "reply-2" }),
    ];
    expect(sliceOwnerTurnTail(events, "tii-1")?.map((item) => item.id)).toEqual(
      ["thinking-1", "tool-1", "reply-1"]
    );
    expect(sliceOwnerTurnTail(events, "tii-2")?.map((item) => item.id)).toEqual(
      ["reply-2"]
    );
  });

  it("returns null when the dispatch removed its user row", () => {
    expect(sliceOwnerTurnTail([event({ id: "x" })], "tii-1")).toBeNull();
  });
});
