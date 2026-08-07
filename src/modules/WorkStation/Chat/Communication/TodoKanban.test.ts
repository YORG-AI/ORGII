import { describe, expect, it } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import { buildTimeline } from "./TodoKanban";
import type { MessageEntry } from "./types";

function todoMessage(
  id: string,
  order: number,
  todos: Array<{ id: string; content: string; status: string }>
): MessageEntry {
  return {
    eventId: id,
    event: {
      id,
      extracted: { kind: "todo", todos, wasMerge: false },
    } as SessionEvent,
    type: "todo",
    content: "",
    sender: "agent",
    timestamp: `2026-07-10T10:00:0${order}Z`,
    order,
    isCurrent: false,
  };
}

describe("buildTimeline", () => {
  it("preserves a prior title when a replacement snapshot carries empty content", () => {
    const { todos } = buildTimeline([
      todoMessage("todo-write", 0, [
        { id: "0", content: "Review repository structure", status: "pending" },
      ]),
      todoMessage("todo-update", 1, [
        { id: "0", content: "", status: "completed" },
      ]),
    ]);

    expect(todos).toEqual([
      {
        id: "0",
        content: "Review repository structure",
        status: "completed",
      },
    ]);
  });
});
