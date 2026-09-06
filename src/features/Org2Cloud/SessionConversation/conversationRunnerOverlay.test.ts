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
      result: {
        observation: "current answer",
        turnIntentId: "current-turn",
      },
    };
    expect(
      selectConversationRunnerTail(runner, [
        historical,
        currentUser,
        currentAssistant,
      ])
    ).toEqual([currentAssistant]);
  });

  it("selects only exact current-turn output from a fresh child's materialized prefix", () => {
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
    currentTool.result.turnIntentId = "current-turn";
    const currentAnswer = {
      ...event("still working"),
      id: "current-answer",
      chunk_id: "current-answer",
      result: { observation: "still working", turnIntentId: "current-turn" },
    };

    expect(
      selectConversationRunnerTail(runner, [
        currentUser,
        copiedAnswer,
        copiedTool,
        currentTool,
        currentAnswer,
      ]).map((candidate) => candidate.id)
    ).toEqual(["current-tool", "current-answer"]);
  });

  it("shows intent-stamped native output without a private user anchor", () => {
    const runner = {
      runnerSessionId: "reused-codex-child",
      turnId: "current-turn",
      // Raw provider history and the visible chat projection have different
      // lengths, so this value must not be applied to the projected array.
      eventStartIndex: 40,
    };
    const historicalAnswer = {
      ...event("historical answer"),
      id: "historical-answer",
      chunk_id: "historical-answer",
    };
    const copiedHistoricalAnswer = {
      ...historicalAnswer,
      id: "copied-historical-answer",
      chunk_id: "copied-historical-answer",
      args: {
        [NATIVE_SOURCE_EVENT_ID_ARG]: nativeSourceEventId(historicalAnswer),
      },
    };
    const nativeUserWithoutPrivateIntent = {
      ...event("inspect the repository"),
      id: "native-current-user",
      chunk_id: "native-current-user",
      source: "user",
      functionName: "user_message",
      result: { message: { role: "user", content: "inspect the repository" } },
    } as SessionEvent;
    const currentTool = completedTool("current-tool", "package contents");
    currentTool.result.turnIntentId = "current-turn";
    const currentProgress = {
      ...event("still inspecting"),
      id: "current-progress",
      chunk_id: "current-progress",
      result: { observation: "still inspecting", turnIntentId: "current-turn" },
    };

    expect(
      selectConversationRunnerTail(runner, [
        copiedHistoricalAnswer,
        nativeUserWithoutPrivateIntent,
        currentTool,
        currentProgress,
      ]).map((candidate) => candidate.id)
    ).toEqual(["current-tool", "current-progress"]);
  });

  it("uses the exact accepted user boundary for Rust Agent output", () => {
    const runner = {
      runnerSessionId: "sde-child",
      turnId: "current-turn",
      eventStartIndex: 14,
    };
    const acceptedUser = {
      ...event("inspect the repository"),
      id: "accepted-user",
      chunk_id: "accepted-user",
      source: "user",
      functionName: "user_message",
      result: { turnIntentId: "current-turn" },
    } as SessionEvent;
    const copiedPrefix = {
      ...event("copied historical answer"),
      id: "copied-prefix",
      chunk_id: "copied-prefix",
      args: {
        [NATIVE_SOURCE_EVENT_ID_ARG]: nativeSourceEventId(
          event("historical answer")
        ),
      },
    };
    const currentTool = completedTool("sde-tool", "package contents");
    const currentAnswer = {
      ...event("repository summary"),
      id: "sde-answer",
      chunk_id: "sde-answer",
      // Rust Agent terminal/error rows already carry the durable identity,
      // while ordinary tool rows in the same turn currently rely on the
      // accepted-user boundary. Both must survive in original order.
      result: {
        observation: "repository summary",
        turnIntentId: "current-turn",
      },
    };
    const anotherTurn = {
      ...event("another answer"),
      id: "another-answer",
      chunk_id: "another-answer",
    };
    const anotherUser = {
      ...event("next prompt"),
      id: "another-user",
      chunk_id: "another-user",
      source: "user",
      functionName: "user_message",
      result: { turnIntentId: "other-turn" },
    } as SessionEvent;

    expect(
      selectConversationRunnerTail(runner, [
        acceptedUser,
        copiedPrefix,
        currentTool,
        currentAnswer,
        anotherUser,
        anotherTurn,
      ]).map((candidate) => candidate.id)
    ).toEqual(["sde-tool", "sde-answer"]);
  });

  it("does not expose a fresh native prefix without an intent anchor", () => {
    const runner = {
      runnerSessionId: "fresh-native-child",
      turnId: "current-turn",
      eventStartIndex: 2,
    };
    const historical = {
      ...event("historical answer"),
      id: "historical-answer",
      chunk_id: "historical-answer",
    };
    const copied = {
      ...historical,
      id: "copied-historical-answer",
      chunk_id: "copied-historical-answer",
      args: {
        [NATIVE_SOURCE_EVENT_ID_ARG]: nativeSourceEventId(historical),
      },
    };

    expect(selectConversationRunnerTail(runner, [copied])).toEqual([]);
  });

  it("does not expose any native row while the runner boundary is preparing", () => {
    const historical = {
      ...event("historical answer"),
      id: "historical-answer",
      chunk_id: "historical-answer",
    };
    const current = {
      ...event("current output"),
      id: "current-output",
      chunk_id: "current-output",
    };

    expect(
      selectConversationRunnerTail(
        {
          runnerSessionId: "preparing-child",
          turnId: "current-turn",
          eventStartIndex: Number.MAX_SAFE_INTEGER,
        },
        [historical, current]
      )
    ).toEqual([]);
  });

  it("keeps a same-text assistant when its current-turn identity is explicit", () => {
    const repeatedAnswer = {
      ...event("same answer"),
      id: "repeated-answer",
      chunk_id: "repeated-answer",
      result: { observation: "same answer", turnIntentId: "current-turn" },
    };

    expect(
      selectConversationRunnerTail(
        {
          runnerSessionId: "reused-child",
          turnId: "current-turn",
          eventStartIndex: 20,
        },
        [repeatedAnswer]
      ).map((candidate) => candidate.id)
    ).toEqual(["repeated-answer"]);
  });

  it("never applies the raw provider index to an untagged chat projection", () => {
    const runner = {
      runnerSessionId: "fresh-empty-child",
      turnId: "current-turn",
      eventStartIndex: 1,
    };
    const materialized = {
      ...event("materialized setup"),
      id: "materialized",
      chunk_id: "materialized",
    };
    const current = {
      ...event("current output"),
      id: "current",
      chunk_id: "current",
    };

    expect(selectConversationRunnerTail(runner, [materialized])).toEqual([]);
    expect(
      selectConversationRunnerTail(runner, [materialized, current])
    ).toEqual([]);
  });
});
