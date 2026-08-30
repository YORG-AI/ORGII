import { describe, expect, it } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import {
  extractQuestionSignals,
  questionSignalsEqual,
} from "../questionSignals";

function askEvent(
  id: string,
  overrides: Partial<SessionEvent> = {}
): SessionEvent {
  return {
    id,
    chunk_id: id,
    sessionId: "session-1",
    createdAt: "2026-06-18T00:00:00.000Z",
    functionName: "ask_user_questions",
    uiCanonical: "ask_user_questions",
    actionType: "tool_call",
    args: {
      questions: [{ question: "Continue?", options: ["Yes", "No"] }],
    },
    result: {},
    source: "assistant",
    displayText: "",
    displayStatus: "awaiting_user",
    displayVariant: "tool_call",
    activityStatus: "agent",
    callId: id,
    ...overrides,
  } as SessionEvent;
}

describe("extractQuestionSignals", () => {
  it("returns empty signals when there are no questions", () => {
    expect(extractQuestionSignals([])).toEqual({
      batches: [],
      streamingCount: 0,
    });
  });

  it("extracts a renderable batch", () => {
    const signals = extractQuestionSignals([askEvent("q-1")]);
    expect(signals.streamingCount).toBe(0);
    expect(signals.batches).toHaveLength(1);
    expect(signals.batches[0].questionId).toBe("q-1");
    expect(signals.batches[0].questions[0].text).toBe("Continue?");
  });

  it("counts in-flight questions that are not yet renderable", () => {
    const signals = extractQuestionSignals([
      askEvent("q-stream", {
        args: { questions: [] },
        displayStatus: "running",
      }),
    ]);
    expect(signals.batches).toEqual([]);
    expect(signals.streamingCount).toBe(1);
  });
});

describe("questionSignalsEqual", () => {
  it("is true for identical extracted payloads", () => {
    const first = extractQuestionSignals([askEvent("q-1")]);
    const second = extractQuestionSignals([askEvent("q-1")]);
    expect(questionSignalsEqual(first, second)).toBe(true);
  });
});
