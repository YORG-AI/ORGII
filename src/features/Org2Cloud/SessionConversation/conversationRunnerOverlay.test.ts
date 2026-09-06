import { describe, expect, it } from "vitest";

import {
  NATIVE_SOURCE_EVENT_ID_ARG,
  nativeSourceEventId,
} from "@src/engines/SessionCore/conversations/nativeConversationMaterializer";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import {
  conversationRunnerOverlaysEqual,
  selectConversationRunnerTail,
} from "./conversationRunnerOverlay";

function event(text: string): SessionEvent {
  return {
    id: "runlive-answer",
    chunk_id: "runlive-answer",
    sessionId: "root",
    createdAt: "2026-08-20T10:00:00Z",
    functionName: "assistant_message",
    uiCanonical: "assistant_message",
    actionType: "assistant",
    args: {},
    result: { observation: text },
    source: "assistant",
    displayText: text,
    displayStatus: "running",
    displayVariant: "message",
    activityStatus: "agent",
    payloadRefs: [],
  } as SessionEvent;
}

function completedTool(
  id: string,
  output: string,
  sourceEventId?: string
): SessionEvent {
  return {
    ...event(output),
    id,
    chunk_id: id,
    functionName: "read_file",
    uiCanonical: "tool_call",
    actionType: "tool_call",
    callId: `call-${id}`,
    args: {
      path: "/repo/README.md",
      ...(sourceEventId ? { [NATIVE_SOURCE_EVENT_ID_ARG]: sourceEventId } : {}),
    },
    result: { status: "completed", output },
    displayStatus: "completed",
    displayVariant: "tool_call",
  } as SessionEvent;
}

describe("conversation runner overlay stability", () => {
  it("reuses equal projections but publishes visible streaming changes", () => {
    const first = event("working");
    expect(
      conversationRunnerOverlaysEqual(
        [first],
        [{ ...first, args: first.args, result: first.result }]
      )
    ).toBe(true);
    expect(
      conversationRunnerOverlaysEqual(
        [first],
        [{ ...first, displayText: "new output" }]
      )
    ).toBe(false);
  });

  it("does not expose a fresh child's materialized prefix before the current turn lands", () => {
    const runner = {
      runnerSessionId: "fresh-child",
      turnId: "current-turn",
      // This belongs to the raw provider transcript, not this filtered array.
      eventStartIndex: 1,
    };
    const historical = event("historical answer");

    expect(selectConversationRunnerTail(runner, [historical])).toEqual([]);

    const currentUser = {
      ...event("current prompt"),
      id: "current-user",
      chunk_id: "current-user",
      source: "user",
      functionName: "user_message",
      result: { turnIntentId: "current-turn" },
    } as SessionEvent;
    const currentAssistant = {
      ...event("current answer"),
      id: "current-assistant",
      chunk_id: "current-assistant",
    };
    expect(
      selectConversationRunnerTail(runner, [
        historical,
        currentUser,
        currentAssistant,
      ])
    ).toEqual([currentAssistant]);
  });

  it("removes a fresh child's materialized prefix after the accepted user while keeping active tool rows", () => {
    const runner = {
      runnerSessionId: "fresh-codex-child",
      turnId: "current-turn",
      eventStartIndex: 40,
    };
    const historicalAnswer = {
      ...event("historical answer"),
      id: "historical-answer",
      chunk_id: "historical-answer",
    };
    const historicalTool = completedTool(
      "historical-tool",
      "old file contents"
    );
    const currentUser = {
      ...event("inspect the current repository"),
      id: "current-user",
      chunk_id: "current-user",
      source: "user",
      functionName: "user_message",
      result: { turnIntentId: "current-turn" },
    } as SessionEvent;
    const copiedAnswer = {
      ...historicalAnswer,
      id: "codex-copy-answer",
      chunk_id: "codex-copy-answer",
      // Current native writers persist the globally scoped canonical identity.
      // A raw provider-local hint is deliberately untrusted because it can
      // collide with a genuine later row in the same provider Session.
      args: {
        [NATIVE_SOURCE_EVENT_ID_ARG]: nativeSourceEventId(historicalAnswer),
      },
    };
    const copiedTool = completedTool(
      "codex-copy-tool",
      "old file contents",
      nativeSourceEventId(historicalTool)
    );
    const currentTool = completedTool("current-tool", "current file contents");
    const currentAnswer = {
      ...event("still working"),
      id: "current-answer",
      chunk_id: "current-answer",
    };

    expect(
      selectConversationRunnerTail(
        runner,
        [currentUser, copiedAnswer, copiedTool, currentTool, currentAnswer],
        [historicalAnswer, historicalTool]
      ).map((candidate) => candidate.id)
    ).toEqual(["current-tool", "current-answer"]);
  });
});
