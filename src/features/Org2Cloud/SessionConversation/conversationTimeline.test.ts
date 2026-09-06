import { describe, expect, it } from "vitest";

import { CONVERSATION_SENDER_ARG } from "@src/engines/SessionCore/conversations/conversationSenderMetadata";
import {
  NATIVE_SOURCE_EVENT_ID_ARG,
  projectNativeConversationItems,
} from "@src/engines/SessionCore/conversations/nativeConversationMaterializer";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import type { CloudConversationEvent } from "../org2CloudConversationEventsClient";
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
  const encoded = (value: string) =>
    btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

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

  it("recovers canonical identity from a native Agent materialization row", () => {
    const user = userEvent({
      id: `imported-session-x~user-message-org2-turn-v1.${encoded("turn-9")}.${encoded("source-user-9")}.nonce`,
      sessionId: "imported-session-x",
      result: { message: { role: "user", content: "continue" } },
    });
    const assistant = event({
      id: `imported-session-x~org2-native-v1.${encoded("source-answer-9")}.nonce`,
      sessionId: "imported-session-x",
    });
    expect(conversationEventKey(user)).toBe("intent:turn-9");
    expect(conversationEventKey(assistant)).toBe("event:source-answer-9");
  });

  it("recovers materialized turn identity through stacked import namespaces", () => {
    const user = userEvent({
      id: `fork-copy~import-copy~user-message-org2-turn-v1.${encoded("turn-stacked")}.${encoded("source-stacked")}.nonce`,
      sessionId: "fork-copy",
      result: { message: { role: "user", content: "continue again" } },
    });
    expect(conversationEventKey(user)).toBe("intent:turn-stacked");
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
    const merged = mergePlaneIntoTranscript(base, rows, "owner-session", {
      status: "known",
      userId: "owner",
    });
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
      { status: "known", userId: "member" }
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
      { status: "known", userId: "owner" }
    );
    expect(asOwner[0]).toBe(ownerUser);
  });

  it("does not stamp a local self twin while viewer auth is loading", () => {
    const rows = [row(1, { ...ownerUser, sessionId: "conversation" })];

    const loading = mergePlaneIntoTranscript(
      [ownerUser],
      rows,
      "owner-session",
      { status: "loading" }
    );
    const hydrated = mergePlaneIntoTranscript(
      [ownerUser],
      rows,
      "owner-session",
      { status: "known", userId: "owner" }
    );

    expect(loading[0]).toBe(ownerUser);
    expect(hydrated[0]).toBe(ownerUser);
    expect(loading[0].args[CONVERSATION_SENDER_ARG]).toBeUndefined();
  });

  it("preserves an existing remote stamp while viewer auth is loading", () => {
    const remoteTwin = userEvent({
      id: "imported-session-x~user-input-1",
      sessionId: "imported-session-x",
      result: { syntheticUserInput: true, turnIntentId: "tii-1" },
      args: {
        [CONVERSATION_SENDER_ARG]: { userId: "owner" },
      },
    });
    const rows = [row(1, { ...ownerUser, sessionId: "conversation" })];

    const loading = mergePlaneIntoTranscript(
      [remoteTwin],
      rows,
      "imported-session-x",
      { status: "loading" }
    );
    const hydrated = mergePlaneIntoTranscript(
      [remoteTwin],
      rows,
      "imported-session-x",
      { status: "known", userId: "member" }
    );

    expect(loading[0]).toBe(remoteTwin);
    expect(loading[0].args[CONVERSATION_SENDER_ARG]).toEqual({
      userId: "owner",
    });
    expect(hydrated[0].args[CONVERSATION_SENDER_ARG]).toEqual({
      userId: "owner",
      displayName: "Owner",
    });
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
    const merged = mergePlaneIntoTranscript(base, rows, "owner-session", {
      status: "known",
      userId: "owner",
    });
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
    const merged = mergePlaneIntoTranscript(base, rows, "owner-session", {
      status: "known",
      userId: "owner",
    });
    expect(merged.map((item) => item.displayText)).toEqual([
      "legacy",
      "hello",
      "owner reply",
      "member asks",
      "member reply",
      "running",
    ]);
  });

  it("matches a positional native/import echo to its plane event semantically", () => {
    const canonical = event({
      id: "member-answer",
      displayText: "same source event",
    });
    const nativeEcho = event({
      // Codex exposes positional ids after parsing a materialized transcript,
      // so this intentionally cannot match the plane row by event id.
      id: "imported-session-x~codex-asst-10",
      sessionId: "imported-session-x",
      displayText: "same source event",
    });

    const merged = mergePlaneIntoTranscript(
      [nativeEcho],
      [row(1, canonical, { authorUserId: "member" })],
      "imported-session-x",
      { status: "known", userId: "viewer" }
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]).toBe(nativeEcho);
  });

  it("matches repeated equal native messages one-to-one instead of collapsing the conversation", () => {
    const first = event({ id: "native-a", displayText: "OK" });
    const second = event({ id: "native-b", displayText: "OK" });
    const planeFirst = event({ id: "plane-a", displayText: "OK" });
    const planeSecond = event({ id: "plane-b", displayText: "OK" });

    const merged = mergePlaneIntoTranscript(
      [first, second],
      [row(1, planeFirst), row(2, planeSecond)],
      "owner-session",
      { status: "known", userId: "owner" }
    );

    expect(merged).toEqual([first, second]);
  });

  it("collapses a plane row that republishes an existing source identity", () => {
    const first = event({ id: "member-answer", displayText: "answer" });
    const republished = event({
      id: "org2-native-v1.bWVtYmVyLWFuc3dlcg.nonce",
      displayText: "answer",
    });

    const merged = mergePlaneIntoTranscript(
      [],
      [row(1, first), row(2, republished)],
      "owner-session",
      { status: "known", userId: "owner" }
    );

    expect(merged).toHaveLength(1);
    expect(merged[0].displayText).toBe("answer");
  });

  it("collapses a global native source copy even when user turn intents differ", () => {
    const sourceId = "orgii_evt_0c2481a309205d2abd70fd14234cf0f5";
    const nativeUser = userEvent({
      id: "codex-user-97",
      args: { [NATIVE_SOURCE_EVENT_ID_ARG]: sourceId },
      result: {
        turnIntentId: "native-intent",
        message: { role: "user", content: "retry me" },
      },
      displayText: "retry me",
    });
    const planeUser = userEvent({
      id: "claude-user-14",
      sessionId: "conversation",
      args: { [NATIVE_SOURCE_EVENT_ID_ARG]: sourceId },
      result: {
        turnIntentId: "plane-intent",
        message: { role: "user", content: "retry me" },
      },
      displayText: "retry me",
    });
    const sameTextDifferentSource = userEvent({
      id: "claude-user-15",
      sessionId: "conversation",
      args: {
        [NATIVE_SOURCE_EVENT_ID_ARG]:
          "orgii_evt_11111111111111111111111111111111",
      },
      result: {
        turnIntentId: "distinct-intent",
        message: { role: "user", content: "retry me" },
      },
      displayText: "retry me",
    });
    const failed = userEvent({
      id: "failed-user",
      args: {
        [NATIVE_SOURCE_EVENT_ID_ARG]:
          "orgii_evt_22222222222222222222222222222222",
      },
      result: {
        turnIntentId: "failed-intent",
        deliveryStatus: "failed",
        message: { role: "user", content: "failed retry" },
      },
      displayStatus: "failed",
      displayText: "failed retry",
    });

    const merged = mergePlaneIntoTranscript(
      [nativeUser, failed],
      [
        row(1, planeUser, { turnId: "plane-intent" }),
        row(2, sameTextDifferentSource, { turnId: "distinct-intent" }),
      ],
      "owner-session",
      { status: "known", userId: "owner" }
    );

    expect(
      merged.filter(
        (item) => item.args[NATIVE_SOURCE_EVENT_ID_ARG] === sourceId
      )
    ).toEqual([nativeUser]);
    expect(
      merged.filter((item) => item.displayText === "retry me")
    ).toHaveLength(2);
    expect(merged).toContain(failed);
    expect(
      projectNativeConversationItems(merged).map((item) => item.id)
    ).toEqual([sourceId, "orgii_evt_11111111111111111111111111111111"]);
  });

  it("returns the base untouched without plane rows", () => {
    const base = [ownerUser, ownerReply];
    expect(mergePlaneIntoTranscript(base, [], "owner-session")).toEqual(base);
  });
});
