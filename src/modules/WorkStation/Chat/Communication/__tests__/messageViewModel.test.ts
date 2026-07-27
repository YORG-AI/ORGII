import { describe, expect, it } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import {
  buildCommunicationMessageViewModel,
  selectCommunicationMessages,
} from "../messageViewModel";
import type { MessageEntry, MessageViewMode } from "../types";

function message(
  id: string,
  type: MessageViewMode,
  timestamp: string,
  order: number,
  functionName = "assistant"
): MessageEntry {
  return {
    eventId: id,
    event: { id, functionName } as SessionEvent,
    type,
    content: id,
    sender: "agent",
    timestamp,
    order,
    isCurrent: false,
  };
}

describe("Communication message view model", () => {
  const chat = message("chat", "chat", "2026-01-01T00:00:02Z", 0);
  const think = message("think", "think", "2026-01-01T00:00:01Z", 2);
  const todo = message("todo", "todo", "2026-01-01T00:00:01Z", 1);
  const plan = message(
    "plan",
    "interaction",
    "2026-01-01T00:00:03Z",
    0,
    "plan_approval"
  );
  const interaction = message(
    "question",
    "interaction",
    "2026-01-01T00:00:04Z",
    0,
    "ask_user_questions"
  );
  const interactionMessages = [plan, interaction];
  const viewModel = buildCommunicationMessageViewModel({
    chatMessages: [chat],
    thinkMessages: [think],
    todoMessages: [todo],
    interactionMessages,
  });

  it("sorts the transcript by timestamp and stable event order", () => {
    expect(viewModel.transcriptMessages.map((item) => item.eventId)).toEqual([
      "todo",
      "think",
      "chat",
      "plan",
      "question",
    ]);
  });

  it("keeps only plan display events in preview", () => {
    expect(viewModel.previewMessages.map((item) => item.eventId)).toEqual([
      "plan",
    ]);
  });

  it.each<[MessageViewMode, MessageEntry[]]>([
    ["chat", viewModel.transcriptMessages],
    ["think", [think]],
    ["todo", [todo]],
    ["preview", [plan]],
    ["interaction", interactionMessages],
  ])("selects the %s message bucket", (viewMode, expected) => {
    expect(
      selectCommunicationMessages({
        viewMode,
        viewModel,
        thinkMessages: [think],
        todoMessages: [todo],
        interactionMessages,
      })
    ).toEqual(expected);
  });
});
