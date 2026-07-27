import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import { markQuestionAnswered } from "../questionSubmitUtils";

const { getEventsSpy, upsertSpy } = vi.hoisted(() => ({
  getEventsSpy: vi.fn(),
  upsertSpy: vi.fn(),
}));

vi.mock("@src/engines/SessionCore/core/store/EventStoreProxy", () => ({
  eventStoreProxy: {
    getEvents: getEventsSpy,
    upsert: upsertSpy,
  },
}));

function pendingQuestionEvent(): SessionEvent {
  return {
    id: "tool-call-question-1",
    chunk_id: "tool-call-question-1",
    sessionId: "session-1",
    createdAt: "2026-07-21T00:00:00.000Z",
    functionName: "ask_user_questions",
    uiCanonical: "ask_user_questions",
    actionType: "tool_call",
    args: { questions: [{ question: "Proceed?" }] },
    result: {},
    source: "assistant",
    displayText: "ask_user_questions",
    displayStatus: "awaiting_user",
    displayVariant: "tool_call",
    activityStatus: "pending",
    callId: "question-1",
  };
}

describe("markQuestionAnswered", () => {
  beforeEach(() => {
    getEventsSpy.mockReset();
    upsertSpy.mockReset();
    upsertSpy.mockResolvedValue(undefined);
  });

  it("immediately completes the visible question in its owning session", async () => {
    getEventsSpy.mockResolvedValue([pendingQuestionEvent()]);

    const updated = await markQuestionAnswered(
      "session-1",
      "tool-call-question-1",
      [["Yes"]]
    );

    expect(updated).toBe(true);
    expect(getEventsSpy).toHaveBeenCalledWith("session-1");
    expect(upsertSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "tool-call-question-1",
        sessionId: "session-1",
        displayStatus: "completed",
        activityStatus: "processed",
        result: { answers: [["Yes"]], status: "answered" },
      }),
      "session-1"
    );
  });

  it("does not mutate another session when the event is absent", async () => {
    getEventsSpy.mockResolvedValue([]);

    await expect(
      markQuestionAnswered("session-2", "tool-call-question-1", [["Yes"]])
    ).resolves.toBe(false);
    expect(upsertSpy).not.toHaveBeenCalled();
  });
});
