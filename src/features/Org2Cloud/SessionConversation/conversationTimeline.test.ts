import { describe, expect, it } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import type { CloudConversationEvent } from "../org2CloudConversationEventsClient";
import { CONVERSATION_SENDER_ARG } from "./continuationEvents";
import {
  conversationEventKey,
  mergePlaneIntoTranscript,
} from "./conversationTimeline";

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

function userEvent(overrides: Partial<SessionEvent>): SessionEvent {
  return event({
    functionName: "user_message",
    uiCanonical: "user_message",
    actionType: "raw",
    source: "user",
    ...overrides,
  });
}

function row(
  seq: number,
  inner: SessionEvent,
  overrides: Partial<CloudConversationEvent> = {}
): CloudConversationEvent {
  return {
    id: `row-${seq}`,
    rootSessionId: "owner-session",
    authorUserId: "owner",
    authorDisplayName: "Owner",
    turnId: `turn-${seq}`,
    seq,
    event: inner,
    createdAt: inner.createdAt,
    ...overrides,
  };
}

describe("conversationEventKey", () => {
  it("keys user rows on the turn intent so synthetic, backend and plane rows collapse", () => {
    const synthetic = userEvent({
      id: "user-input-1",
      result: { syntheticUserInput: true, turnIntentId: "tii-1" },
    });
    const backend = userEvent({
      id: "backend-7",
      result: { turnIntentId: "tii-1" },
    });
    const plane = userEvent({
      id: "user-input-1",
      sessionId: "conversation",
      result: { turnIntentId: "tii-1" },
    });
    expect(conversationEventKey(synthetic)).toBe("intent:tii-1");
    expect(conversationEventKey(backend)).toBe("intent:tii-1");
    expect(conversationEventKey(plane)).toBe("intent:tii-1");
  });

  it("peels import namespaces for every other event", () => {
    const copy = event({
      id: "imported-session-abc~evt-9",
      sessionId: "imported-session-abc",
    });
    expect(conversationEventKey(copy)).toBe("event:evt-9");
    expect(conversationEventKey(event({ id: "evt-9" }))).toBe("event:evt-9");
  });
});

describe("mergePlaneIntoTranscript", () => {
  const ownerUser = userEvent({
    id: "user-input-1",
    createdAt: "2026-08-21T10:00:00Z",
    result: { syntheticUserInput: true, turnIntentId: "tii-1" },
  });
  const ownerReply = event({
    id: "evt-reply",
    createdAt: "2026-08-21T10:00:05Z",
    displayText: "owner reply",
  });
  const memberUser = userEvent({
    id: "convturn-user-2",
    sessionId: "conversation",
    createdAt: "2026-08-21T10:01:00Z",
    displayText: "member asks",
  });
  const memberReply = event({
    id: "runner-evt-1",
    sessionId: "runner-session",
    createdAt: "2026-08-21T10:01:09Z",
    displayText: "member reply",
  });

  it("renders the owner's local twins at the plane position, keeping their identity", () => {
    const base = [ownerUser, ownerReply];
    const rows = [
      row(1, { ...ownerUser, sessionId: "conversation" }),
      row(2, ownerReply),
    ];
    const merged = mergePlaneIntoTranscript(
      base,
      rows,
      "owner-session",
      "owner"
    );
    expect(merged).toHaveLength(2);
    expect(merged[0]).toBe(ownerUser);
    expect(merged[1]).toBe(ownerReply);
  });

  it("stamps other authors' user rows on the twin but leaves the viewer's own untouched", () => {
    const copyUser = userEvent({
      id: "imported-session-x~user-input-1",
      sessionId: "imported-session-x",
      result: { syntheticUserInput: true, turnIntentId: "tii-1" },
    });
    const rows = [row(1, { ...ownerUser, sessionId: "conversation" })];
    const asMember = mergePlaneIntoTranscript(
      [copyUser],
      rows,
      "imported-session-x",
      "member"
    );
    expect(asMember[0].id).toBe(copyUser.id);
    expect(asMember[0].args[CONVERSATION_SENDER_ARG]).toEqual({
      userId: "owner",
      displayName: "Owner",
    });
    const asOwner = mergePlaneIntoTranscript(
      [ownerUser],
      rows,
      "owner-session",
      "owner"
    );
    expect(asOwner[0]).toBe(ownerUser);
  });

  it("orders plane-backed turns by seq even when a sender clock is skewed", () => {
    const skewedMemberUser = {
      ...memberUser,
      createdAt: "2026-08-21T09:00:00Z",
    };
    const base = [ownerUser, ownerReply];
    const rows = [
      row(1, { ...ownerUser, sessionId: "conversation" }),
      row(2, ownerReply),
      row(3, skewedMemberUser, { authorUserId: "member", turnId: "t-m" }),
      row(4, memberReply, { authorUserId: "member", turnId: "t-m" }),
    ];
    const merged = mergePlaneIntoTranscript(
      base,
      rows,
      "owner-session",
      "owner"
    );
    expect(merged.map((item) => item.displayText)).toEqual([
      "hello",
      "owner reply",
      "member asks",
      "member reply",
    ]);
    expect(merged[2].id).toBe("convplane-row-3");
  });

  it("keeps pre-plane history before the plane and a running owner turn after it", () => {
    const legacy = event({
      id: "evt-legacy",
      createdAt: "2026-08-21T09:30:00Z",
      displayText: "legacy",
    });
    const running = event({
      id: "evt-running",
      createdAt: "2026-08-21T10:02:00Z",
      displayText: "running",
    });
    const base = [legacy, ownerUser, ownerReply, running];
    const rows = [
      row(1, { ...ownerUser, sessionId: "conversation" }),
      row(2, ownerReply),
      row(3, memberUser, { authorUserId: "member" }),
      row(4, memberReply, { authorUserId: "member" }),
    ];
    const merged = mergePlaneIntoTranscript(
      base,
      rows,
      "owner-session",
      "owner"
    );
    expect(merged.map((item) => item.displayText)).toEqual([
      "legacy",
      "hello",
      "owner reply",
      "member asks",
      "member reply",
      "running",
    ]);
  });

  it("returns the base untouched without plane rows", () => {
    const base = [ownerUser, ownerReply];
    expect(mergePlaneIntoTranscript(base, [], "owner-session")).toEqual(base);
  });
});
