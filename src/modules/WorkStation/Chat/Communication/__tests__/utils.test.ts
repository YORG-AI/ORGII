/**
 * SimulatorMessages utilities: extraction, sender, truncation.
 */
import { describe, expect, it } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import { deriveMessagesState } from "../config";
import { derivePlanTitle } from "../planDocUtils";
import {
  convertToMessageEntry,
  extractMessageContent,
  getCommunicationUnloadedTurnMeta,
  getMessageSender,
  isChatEvent,
  isThinkEvent,
  truncateContent,
} from "../utils";

function minimalSessionEvent(
  overrides: Partial<SessionEvent> = {}
): SessionEvent {
  return {
    chunk_id: null,
    id: "evt-1",
    sessionId: "sess-1",
    createdAt: "2026-03-29T12:00:00.000Z",
    functionName: "assistant",
    uiCanonical: "",
    actionType: "tool_call",
    args: {},
    result: {},
    source: "assistant",
    displayText: "",
    displayStatus: "completed",
    displayVariant: "tool_call",
    activityStatus: "agent",
    ...overrides,
  };
}

describe("isChatEvent / isThinkEvent", () => {
  it("detects chat-related function names", () => {
    expect(isChatEvent("send_message")).toBe(true);
    expect(isChatEvent("assistant_delta")).toBe(true);
    expect(isChatEvent("agent_message")).toBe(true);
    expect(isChatEvent("agent_message_delta")).toBe(true);
  });

  it("detects thinking-related function names", () => {
    expect(isThinkEvent("thinking_delta")).toBe(true);
    expect(isThinkEvent("llm_thinking")).toBe(true);
  });
});

describe("extractMessageContent", () => {
  it("prefers args.message then args.content", () => {
    expect(
      extractMessageContent(
        minimalSessionEvent({ args: { message: "from args" } })
      )
    ).toBe("from args");
    expect(
      extractMessageContent(minimalSessionEvent({ args: { content: "body" } }))
    ).toBe("body");
  });

  it("reads result.message.content string (Rust shape)", () => {
    const event = minimalSessionEvent({
      result: {
        message: { content: "hello from rust", role: "assistant" },
      },
    });
    expect(extractMessageContent(event)).toBe("hello from rust");
  });

  it("reads text blocks from result.message.content array (market shape)", () => {
    const event = minimalSessionEvent({
      result: {
        message: {
          content: [{ type: "text", text: "chunk" }],
        },
      },
    });
    expect(extractMessageContent(event)).toBe("chunk");
  });
});

describe("getCommunicationUnloadedTurnMeta / convertToMessageEntry", () => {
  // Guards the PR #561 lazy-replay invariant: the Communication ("Messages")
  // app inside the Workstation replay panel must never surface the backend's
  // raw "turn is not loaded yet" placeholder as if it were real chat content.
  // Regression: that raw text used to render verbatim as a message bubble
  // (bug from PR #561 review) because this module extracted
  // `result.observation` without checking for the `unloadedTurn` tag the
  // Codex/imported-history/Cursor IDE turn loaders stamp onto the
  // placeholder chunk.
  it("returns null for an ordinary assistant message", () => {
    const event = minimalSessionEvent({
      result: { observation: "Here is the real reply." },
    });
    expect(getCommunicationUnloadedTurnMeta(event)).toBeNull();
    expect(convertToMessageEntry(event, "chat", false).unloadedTurn).toBeNull();
  });

  it("extracts the placeholder's turn metadata by the shared wire shape", () => {
    const event = minimalSessionEvent({
      result: {
        observation: "Codex turn codex-user-42 is not loaded yet.",
        unloadedTurn: {
          turnId: "codex-user-42",
          nextTurnId: "codex-user-43",
          startedAt: "2026-07-01T00:00:00.000Z",
          endedAt: "2026-07-01T00:00:05.000Z",
          durationMs: 5000,
          eventCount: 12,
          bodyEventCount: 9,
        },
      },
    });

    expect(getCommunicationUnloadedTurnMeta(event)).toEqual({
      turnId: "codex-user-42",
      nextTurnId: "codex-user-43",
      bodyEventCount: 9,
    });

    const message = convertToMessageEntry(event, "chat", false);
    // `content` still carries the raw placeholder text — extraction is
    // unaware of unloadedTurn by design — but every consumer must gate on
    // `unloadedTurn` before rendering `content` as real chat text.
    expect(message.content).toBe("Codex turn codex-user-42 is not loaded yet.");
    expect(message.unloadedTurn).toEqual({
      turnId: "codex-user-42",
      nextTurnId: "codex-user-43",
      bodyEventCount: 9,
    });
  });

  it("ignores a malformed unloadedTurn payload missing turnId", () => {
    const event = minimalSessionEvent({
      result: { observation: "x", unloadedTurn: { nextTurnId: "y" } },
    });
    expect(getCommunicationUnloadedTurnMeta(event)).toBeNull();
  });
});

describe("getMessageSender", () => {
  it("returns user for explicit user source", () => {
    expect(getMessageSender(minimalSessionEvent({ source: "user" }))).toBe(
      "user"
    );
  });

  it("returns user for user_response in function name", () => {
    expect(
      getMessageSender(
        minimalSessionEvent({ functionName: "user_response_submit" })
      )
    ).toBe("user");
  });

  it("defaults to agent for assistant-style events", () => {
    expect(getMessageSender(minimalSessionEvent())).toBe("agent");
  });

  it("returns user for ui_canonical user function", () => {
    expect(
      getMessageSender(minimalSessionEvent({ functionName: "user" }))
    ).toBe("user");
  });

  it("returns agent for ui_canonical agent_message function", () => {
    expect(
      getMessageSender(
        minimalSessionEvent({
          functionName: "agent_message",
          source: "assistant",
        })
      )
    ).toBe("agent");
  });

  it("returns agent for Agent Team inbox transcripts persisted as user messages", () => {
    expect(
      getMessageSender(
        minimalSessionEvent({
          functionName: "user_message",
          source: "user",
          args: { agentOrgInboxTranscript: true },
          result: {
            type: "user",
            agentOrgInboxTranscript: true,
            message: {
              content: "Reviewed messages from subagents.",
              role: "user",
            },
          },
        })
      )
    ).toBe("agent");
  });
});

describe("derivePlanTitle", () => {
  it("falls back to the first markdown heading", () => {
    expect(derivePlanTitle("", "# Improve Button Component\n\nBody")).toBe(
      "Improve Button Component"
    );
  });
});

describe("deriveMessagesState", () => {
  it("tags an unloaded-turn placeholder chunk so bubble rendering can gate on it", () => {
    const placeholderEvent = minimalSessionEvent({
      id: "codex-unloaded-turn-codex-user-7",
      functionName: "assistant",
      source: "assistant",
      result: {
        observation: "Codex turn codex-user-7 is not loaded yet.",
        role: "assistant",
        unloadedTurn: { turnId: "codex-user-7" },
      },
    });

    const state = deriveMessagesState([placeholderEvent], null);

    expect(state.chatMessages).toHaveLength(1);
    expect(state.chatMessages[0].unloadedTurn).toEqual({
      turnId: "codex-user-7",
      nextTurnId: null,
      bodyEventCount: undefined,
    });
  });

  it("drops a stale unloaded-turn placeholder once its turn's real body events are already in the stream", () => {
    // Regression: for imported-history sessions, the placeholder chunk's
    // shape (`imported-unloaded-turn-<turnId>`, function "assistant" — see
    // `imported_history/window.rs::build_unloaded_turn_placeholder_chunk`)
    // never matches Rust's `is_turn_placeholder()` (which only recognizes
    // the own-db/Codex-app shape: `turn-placeholder-<turnId>` / function
    // "turn_placeholder"). So `merge_round_window_events` never strips it
    // from the EventStore once the real body merges in, and the stale
    // placeholder sits in `messagesEvents` forever, right alongside the
    // body it stood in for — the exact "8 tap-to-retry rows next to loaded
    // bodies" bug. This surface must drop it itself instead of relying on
    // Rust having removed it.
    const header = minimalSessionEvent({
      id: "turn-1",
      functionName: "user_message",
      source: "user",
      displayText: "do the thing",
      result: { message: { role: "user", content: "do the thing" } },
    });
    const stalePlaceholder = minimalSessionEvent({
      id: "imported-unloaded-turn-turn-1",
      functionName: "assistant",
      source: "assistant",
      result: {
        observation: "Imported turn turn-1 is not loaded yet.",
        unloadedTurn: { turnId: "turn-1", nextTurnId: null },
      },
    });
    const body = minimalSessionEvent({
      id: "turn-1-body-1",
      functionName: "assistant",
      source: "assistant",
      result: { observation: "Here is the real reply." },
    });

    // Placeholder sorted after the body it stands in for — the shape Rust's
    // timeline sort produces once the body has merged but the placeholder
    // (whose timestamp mirrors the turn's end time) wasn't removed.
    const state = deriveMessagesState([header, body, stalePlaceholder], null);

    expect(state.chatMessages.map((message) => message.eventId)).toEqual([
      "turn-1",
      "turn-1-body-1",
    ]);
  });

  it("keeps the placeholder while its turn's body has not merged in yet, even once the header is present", () => {
    const header = minimalSessionEvent({
      id: "turn-2",
      functionName: "user_message",
      source: "user",
      displayText: "do another thing",
      result: { message: { role: "user", content: "do another thing" } },
    });
    const placeholder = minimalSessionEvent({
      id: "imported-unloaded-turn-turn-2",
      functionName: "assistant",
      source: "assistant",
      result: {
        observation: "Imported turn turn-2 is not loaded yet.",
        unloadedTurn: { turnId: "turn-2", nextTurnId: null },
      },
    });

    const state = deriveMessagesState([header, placeholder], null);

    expect(state.chatMessages.map((message) => message.eventId)).toEqual([
      "turn-2",
      "imported-unloaded-turn-turn-2",
    ]);
    expect(state.chatMessages[1].unloadedTurn).toEqual({
      turnId: "turn-2",
      nextTurnId: null,
      bodyEventCount: undefined,
    });
  });

  it("only treats events within [turnId, nextTurnId) as resolving evidence for a placeholder", () => {
    const header1 = minimalSessionEvent({
      id: "turn-1",
      functionName: "user_message",
      source: "user",
      result: { message: { role: "user", content: "first" } },
    });
    const placeholder1 = minimalSessionEvent({
      id: "imported-unloaded-turn-turn-1",
      functionName: "assistant",
      source: "assistant",
      result: {
        observation: "Imported turn turn-1 is not loaded yet.",
        unloadedTurn: { turnId: "turn-1", nextTurnId: "turn-2" },
      },
    });
    const header2 = minimalSessionEvent({
      id: "turn-2",
      functionName: "user_message",
      source: "user",
      result: { message: { role: "user", content: "second" } },
    });
    const body2 = minimalSessionEvent({
      id: "turn-2-body-1",
      functionName: "assistant",
      source: "assistant",
      result: { observation: "second reply" },
    });

    const state = deriveMessagesState(
      [header1, placeholder1, header2, body2],
      null
    );

    // turn-1's placeholder has nothing between it and turn-2's header (its
    // declared `nextTurnId` boundary) — turn-2's own body must not count as
    // evidence that turn-1's body loaded.
    expect(state.chatMessages.map((message) => message.eventId)).toEqual([
      "turn-1",
      "imported-unloaded-turn-turn-1",
      "turn-2",
      "turn-2-body-1",
    ]);
  });

  it("keeps thinking events in the Messages view when they are current", () => {
    const thinkingEvent = minimalSessionEvent({
      id: "thinking-1",
      functionName: "llm_thinking",
      result: { thought: "Planning the next step" },
    });

    const state = deriveMessagesState([thinkingEvent], "thinking-1");

    expect(state.viewMode).toBe("chat");
    expect(state.thinkMessages.map((message) => message.eventId)).toEqual([
      "thinking-1",
    ]);
  });

  it("replaces optimistic user echo with the backend user message in Communication chat", () => {
    const optimisticUserMessage = minimalSessionEvent({
      id: "user-input-1",
      functionName: "user_message",
      source: "user",
      displayText: "探索一下repo",
      result: {
        syntheticUserInput: true,
        message: { role: "user", content: "探索一下repo" },
      },
    });
    const backendUserMessage = minimalSessionEvent({
      id: "user-1-loaded-copy",
      functionName: "user_message",
      source: "user",
      displayText: "探索一下repo",
      result: { message: { role: "user", content: "探索一下repo" } },
    });

    const state = deriveMessagesState(
      [optimisticUserMessage, backendUserMessage],
      null
    );

    expect(state.chatMessages.map((message) => message.eventId)).toEqual([
      "user-1-loaded-copy",
    ]);
  });

  it("does not treat user-input-prefixed backend messages as optimistic echoes", () => {
    const firstUserMessage = minimalSessionEvent({
      id: "user-input-backend-1",
      functionName: "user_message",
      source: "user",
      displayText: "探索一下repo",
      result: { message: { role: "user", content: "探索一下repo" } },
    });
    const secondUserMessage = minimalSessionEvent({
      id: "user-2",
      functionName: "user_message",
      source: "user",
      displayText: "探索一下repo",
      result: { message: { role: "user", content: "探索一下repo" } },
    });

    const state = deriveMessagesState(
      [firstUserMessage, secondUserMessage],
      null
    );

    expect(state.chatMessages.map((message) => message.eventId)).toEqual([
      "user-input-backend-1",
      "user-2",
    ]);
  });

  it("keeps same user text when resent in the same session", () => {
    const firstUserMessage = minimalSessionEvent({
      id: "user-1",
      functionName: "user_message",
      source: "user",
      displayText: "探索一下repo",
      result: { message: { role: "user", content: "探索一下repo" } },
    });
    const secondUserMessage = minimalSessionEvent({
      id: "user-2",
      functionName: "user_message",
      source: "user",
      displayText: "探索一下repo",
      result: { message: { role: "user", content: "探索一下repo" } },
    });

    const state = deriveMessagesState(
      [firstUserMessage, secondUserMessage],
      null
    );

    expect(state.chatMessages.map((message) => message.eventId)).toEqual([
      "user-1",
      "user-2",
    ]);
  });

  it("keeps same user text in different sessions", () => {
    const firstUserMessage = minimalSessionEvent({
      id: "user-1",
      sessionId: "session-a",
      functionName: "raw_event",
      source: "user",
      result: { type: "user", message: "探索一下repo" },
    });
    const secondUserMessage = minimalSessionEvent({
      id: "user-2",
      sessionId: "session-b",
      functionName: "user_message",
      source: "user",
      displayText: "探索一下repo",
      result: { message: { role: "user", content: "探索一下repo" } },
    });

    const state = deriveMessagesState(
      [firstUserMessage, secondUserMessage],
      null
    );

    expect(state.chatMessages.map((message) => message.eventId)).toEqual([
      "user-1",
      "user-2",
    ]);
  });

  it("keeps plan documents in the interaction bucket for aggregate Messages rendering", () => {
    const userMessage = minimalSessionEvent({
      id: "user-1",
      functionName: "raw_event",
      source: "user",
      result: { type: "user", message: "Please write a plan" },
    });
    const planEvent = minimalSessionEvent({
      id: "plan-event-1",
      callId: "tool-call-plan-1",
      functionName: "create_plan",
      uiCanonical: "create_plan",
      source: "assistant",
      args: {
        planId: "plan-1",
        planRevisionId: "plan-revision-1",
        title: "",
        content: "# Improve Button Component\n\nBody",
        streamContent: "# Improve Button Component\n\nBody",
      },
      result: { status: "pending" },
    });

    const state = deriveMessagesState([userMessage, planEvent], null);

    expect(state.chatMessages.map((message) => message.order)).toEqual([0]);
    expect(state.interactionMessages.map((message) => message.order)).toEqual([
      1,
    ]);
    expect(state.chatMessages.map((message) => message.eventId)).toEqual([
      "user-1",
    ]);
    expect(state.interactionMessages.map((message) => message.eventId)).toEqual(
      ["plan-event-1"]
    );
  });

  it("anchors archived plan revisions to their original turn order", () => {
    const firstPlan = minimalSessionEvent({
      id: "plan-event-1",
      callId: "tool-call-plan-1",
      functionName: "create_plan",
      uiCanonical: "create_plan",
      source: "assistant",
      args: {
        planId: "plan-1",
        planRevisionId: "plan-revision-1",
        title: "First Plan",
        content: "# First Plan",
      },
      result: { status: "pending" },
    });
    const secondUserMessage = minimalSessionEvent({
      id: "user-2",
      functionName: "raw_event",
      source: "user",
      result: { type: "user", message: "Update it" },
    });
    const secondPlan = minimalSessionEvent({
      id: "plan-event-2",
      callId: "tool-call-plan-2",
      functionName: "create_plan",
      uiCanonical: "create_plan",
      source: "assistant",
      args: {
        planId: "plan-1",
        planRevisionId: "plan-revision-2",
        title: "Second Plan",
        content: "# Second Plan",
      },
      result: { status: "pending" },
    });
    const archivedFirstPlan = minimalSessionEvent({
      id: "plan-archived-1",
      functionName: "plan_approval",
      uiCanonical: "plan_approval",
      actionType: "plan_approval",
      source: "assistant",
      args: {
        planId: "plan-1",
        planRevisionId: "plan-revision-1",
        originToolCallId: "plan-1",
      },
      result: {
        status: "archived",
        planId: "plan-1",
        planRevisionId: "plan-revision-1",
        originToolCallId: "plan-1",
      },
    });

    const state = deriveMessagesState(
      [firstPlan, secondUserMessage, secondPlan, archivedFirstPlan],
      null
    );

    expect(state.interactionMessages.map((message) => message.order)).toEqual([
      0, 2,
    ]);
    expect(
      state.interactionMessages.map((message) => message.event.result.status)
    ).toEqual(["archived", "pending"]);
    expect(state.interactionMessages[0].event.args.title).toBe("First Plan");
  });

  it("keeps archived plan status updates at their revision timestamp without loaded anchor", () => {
    const firstUserMessage = minimalSessionEvent({
      id: "user-1",
      functionName: "raw_event",
      source: "user",
      createdAt: "2026-05-15T00:00:00.000Z",
      result: { type: "user", message: "Make a plan" },
    });
    const archivedFirstPlan = minimalSessionEvent({
      id: "plan-archived-1",
      functionName: "plan_approval",
      uiCanonical: "plan_approval",
      actionType: "plan_approval",
      source: "assistant",
      createdAt: "2026-05-15T00:00:01.000Z",
      args: {
        planId: "plan-1",
        planRevisionId: "plan-revision-1",
        title: "First Plan",
        content: "# First Plan",
      },
      result: {
        status: "archived",
        planId: "plan-1",
        planRevisionId: "plan-revision-1",
      },
    });
    const secondUserMessage = minimalSessionEvent({
      id: "user-2",
      functionName: "raw_event",
      source: "user",
      createdAt: "2026-05-15T00:00:02.000Z",
      result: { type: "user", message: "Update it" },
    });
    const secondPlan = minimalSessionEvent({
      id: "plan-event-2",
      callId: "tool-call-plan-2",
      functionName: "create_plan",
      uiCanonical: "create_plan",
      source: "assistant",
      createdAt: "2026-05-15T00:00:03.000Z",
      args: {
        planId: "plan-1",
        planRevisionId: "plan-revision-2",
        title: "Second Plan",
        content: "# Second Plan",
      },
      result: { status: "pending" },
    });

    const state = deriveMessagesState(
      [firstUserMessage, secondUserMessage, secondPlan, archivedFirstPlan],
      null
    );

    expect(state.interactionMessages.map((message) => message.eventId)).toEqual(
      ["plan-archived-1", "plan-event-2"]
    );
    expect(state.interactionMessages.map((message) => message.order)).toEqual([
      3, 2,
    ]);
    expect(
      [...state.chatMessages, ...state.interactionMessages]
        .sort((messageA, messageB) => {
          const timestampDelta =
            new Date(messageA.timestamp).getTime() -
            new Date(messageB.timestamp).getTime();
          return timestampDelta || messageA.order - messageB.order;
        })
        .map((message) => message.eventId)
    ).toEqual(["user-1", "plan-archived-1", "user-2", "plan-event-2"]);
  });
});

describe("truncateContent", () => {
  it("returns empty for empty input", () => {
    expect(truncateContent("", 80)).toBe("");
  });

  it("strips markdown noise and truncates with ellipsis", () => {
    const long = `# Title\n\n${"word ".repeat(40)}`;
    const out = truncateContent(long, 20);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(21);
  });
});

describe("deriveMessagesState memoization", () => {
  it("reuses the built lists for the same events array identity", () => {
    const events = [
      minimalSessionEvent({
        id: "m-1",
        functionName: "assistant",
        result: { observation: "hello" },
      }),
    ];
    const first = deriveMessagesState(events, null);
    const second = deriveMessagesState(events, null);
    expect(second.chatMessages).toBe(first.chatMessages);
  });

  it("rebuilds for a new events array and keeps earlier results usable", () => {
    // Regression for the old single-slot module memo: building for session B
    // used to overwrite (and pin) session A's lists; the WeakMap memo keeps
    // per-array results independent so an earlier array still hits its own
    // memo — and can be garbage-collected once dropped.
    const eventsA = [
      minimalSessionEvent({ id: "a-1", result: { observation: "A" } }),
    ];
    const eventsB = [
      minimalSessionEvent({ id: "b-1", result: { observation: "B" } }),
    ];
    const a1 = deriveMessagesState(eventsA, null);
    const b1 = deriveMessagesState(eventsB, null);
    expect(b1.chatMessages).not.toBe(a1.chatMessages);
    const a2 = deriveMessagesState(eventsA, null);
    expect(a2.chatMessages).toBe(a1.chatMessages);
    expect(a2.chatMessages.map((m) => m.eventId)).toEqual(["a-1"]);
  });
});
