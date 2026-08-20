import { beforeEach, describe, expect, it, vi } from "vitest";

import { rejectQuestion, respondQuestion } from "@src/api/tauri/agent";
import { markQuestionAnswered } from "@src/engines/ChatPanel/InputArea/AskQuestionCard/questionSubmitUtils";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import { interceptPendingQuestionBatches } from "../questionIntercept";

vi.mock("@src/api/tauri/agent", () => ({
  respondQuestion: vi.fn(),
  rejectQuestion: vi.fn(),
}));

vi.mock(
  "@src/engines/ChatPanel/InputArea/AskQuestionCard/questionSubmitUtils",
  () => ({
    markQuestionAnswered: vi.fn().mockResolvedValue(true),
  })
);

function makeCliQuestionEvent(
  options: string[][] = [["Option A", "Option B"]]
): SessionEvent {
  return {
    id: "tool-call-ask-1",
    chunk_id: null,
    sessionId: "cliagent-1",
    createdAt: "2026-08-14T10:00:00.000Z",
    functionName: "ask_user_questions",
    uiCanonical: "ask_user_questions",
    actionType: "tool_call",
    callId: "call-ask-1",
    source: "assistant",
    args: {
      questions: options.map((opts, idx) => ({
        question: `Question ${idx + 1}?`,
        options: opts,
      })),
    },
    result: {},
    displayText: "",
    displayStatus: "pending",
    displayVariant: "tool",
    activityStatus: "pending",
  } as unknown as SessionEvent;
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("interceptPendingQuestionBatches", () => {
  beforeEach(() => {
    vi.mocked(respondQuestion).mockReset().mockResolvedValue(undefined);
    vi.mocked(rejectQuestion).mockReset().mockResolvedValue(undefined);
    vi.mocked(markQuestionAnswered).mockClear();
  });

  it("finalizes an option-based CLI question locally when the native reject has no bridge", async () => {
    vi.mocked(rejectQuestion).mockRejectedValue(
      new Error("No session found for question reject")
    );

    interceptPendingQuestionBatches(
      [makeCliQuestionEvent()],
      "cliagent-1",
      "just continue without my answer",
      "Skipped"
    );
    await flushMicrotasks();

    expect(rejectQuestion).toHaveBeenCalledWith("cliagent-1", "call-ask-1");
    expect(markQuestionAnswered).toHaveBeenCalledWith(
      "cliagent-1",
      "tool-call-ask-1",
      [["Skipped"]],
      "rejected"
    );
  });

  it("forwards the typed text as the answer for a free-text question and finalizes on failure", async () => {
    vi.mocked(respondQuestion).mockRejectedValue(
      new Error("No session found for question response")
    );

    interceptPendingQuestionBatches(
      [makeCliQuestionEvent([[]])],
      "cliagent-1",
      "my typed answer",
      "Skipped"
    );
    await flushMicrotasks();

    expect(respondQuestion).toHaveBeenCalledWith("cliagent-1", "call-ask-1", [
      ["my typed answer"],
    ]);
    expect(markQuestionAnswered).toHaveBeenCalledWith(
      "cliagent-1",
      "tool-call-ask-1",
      [["my typed answer"]]
    );
  });

  it("also finalizes locally when the native command succeeds (belt and braces)", async () => {
    interceptPendingQuestionBatches(
      [makeCliQuestionEvent()],
      "cliagent-1",
      "hello",
      "Skipped"
    );
    await flushMicrotasks();

    expect(markQuestionAnswered).toHaveBeenCalledWith(
      "cliagent-1",
      "tool-call-ask-1",
      [["Skipped"]],
      "rejected"
    );
  });

  it("ignores events from other sessions and already-completed questions", async () => {
    const otherSession = {
      ...makeCliQuestionEvent(),
      sessionId: "other-session",
    };
    const completed = {
      ...makeCliQuestionEvent(),
      id: "tool-call-ask-2",
      displayStatus: "completed",
    } as unknown as SessionEvent;

    interceptPendingQuestionBatches(
      [otherSession, completed],
      "cliagent-1",
      "hello",
      "Skipped"
    );
    await flushMicrotasks();

    expect(rejectQuestion).not.toHaveBeenCalled();
    expect(respondQuestion).not.toHaveBeenCalled();
    expect(markQuestionAnswered).not.toHaveBeenCalled();
  });
});
