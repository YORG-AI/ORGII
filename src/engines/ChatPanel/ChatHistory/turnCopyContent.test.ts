import { describe, expect, it } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import type { OptimizedChatItem } from "./chatItemPipeline/types";
import {
  collectAssistantTurnCopyEventIds,
  formatAssistantTurnCopyContent,
} from "./turnCopyContent";

function item(
  id: string,
  overrides: Partial<SessionEvent> = {}
): OptimizedChatItem {
  return {
    chunk_id: id,
    type: "activity",
    event: {
      id,
      chunk_id: id,
      sessionId: "session-a",
      createdAt: `2026-08-25T00:00:${id.padStart(2, "0")}.000Z`,
      functionName: "agent_message",
      actionType: "assistant",
      source: "assistant",
      displayText: `assistant-${id}`,
      displayStatus: "completed",
      displayVariant: "message",
      args: {},
      result: {},
      ...overrides,
    } as SessionEvent,
  };
}

describe("assistant turn copy content", () => {
  it("collects every settled assistant message before collapse", () => {
    const items = [
      item("1", { displayText: "first update" }),
      item("2", {
        actionType: "tool_call",
        functionName: "read_file",
        displayVariant: "tool_call",
      }),
      item("3", { displayText: "still streaming", displayStatus: "running" }),
      item("4", { displayText: "final answer" }),
    ];

    expect(collectAssistantTurnCopyEventIds(items)).toEqual(["1", "4"]);
  });

  it("formats visible assistant prose in source order at click time", () => {
    const items = [
      item("1", {
        displayText: "fallback",
        result: { message: "<think>private</think>First update" },
      }),
      item("2", { displayText: "Final answer" }),
      item("3", { displayText: "unrelated answer" }),
    ];

    expect(formatAssistantTurnCopyContent(items, ["1", "2"])).toBe(
      "First update\n\nFinal answer"
    );
  });

  it("excludes unloaded previews and ignores stale event ids", () => {
    const items = [
      item("1", {
        args: { turnPreviewOnly: true },
        displayText: "bounded preview",
      }),
      item("2", { displayText: "resident answer" }),
    ];

    expect(collectAssistantTurnCopyEventIds(items)).toEqual(["2"]);
    expect(formatAssistantTurnCopyContent(items, ["missing", "2"])).toBe(
      "resident answer"
    );
  });
});
