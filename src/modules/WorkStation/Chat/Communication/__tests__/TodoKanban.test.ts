import { describe, expect, it } from "vitest";

import type { AgentOrgTask } from "@src/api/tauri/agent";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import {
  buildAgentOrgTaskTimeline,
  buildTimeline,
  buildTodoKanbanTimeline,
} from "../TodoKanban";
import type { MessageEntry } from "../types";

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

  it("does not materialize a rejected Agent Org task attempt", () => {
    const eventId = "rejected-task-create";
    const rejectedMessage: MessageEntry = {
      eventId,
      event: {
        id: eventId,
        displayStatus: "completed",
        result: {
          created: false,
          requires_dependency_confirmation: true,
        },
        extracted: {
          kind: "orgTask",
          action: "create",
          outcome: "rejected",
          task: {
            id: "",
            subject: "Verify final output",
            owner: "sde-tester",
            status: "pending",
          },
          tasks: [],
        },
      } as unknown as SessionEvent,
      type: "todo",
      content: "",
      sender: "agent",
      timestamp: "2026-07-10T10:00:00Z",
      order: 0,
      isCurrent: false,
    };

    expect(buildTimeline([rejectedMessage]).todos).toEqual([]);
  });

  it("adds every task from a persisted task graph without replacing existing rows", () => {
    const graphMessage: MessageEntry = {
      eventId: "task-graph",
      event: {
        id: "task-graph",
        functionName: "task_graph_create",
        displayStatus: "completed",
        result: { created: true, tasks: [{ id: "task-a" }, { id: "task-b" }] },
        extracted: {
          kind: "orgTask",
          action: "create",
          outcome: "succeeded",
          tasks: [
            {
              id: "task-a",
              subject: "Implement change",
              status: "pending",
              blocks: [],
              blockedBy: [],
            },
            {
              id: "task-b",
              subject: "Review change",
              status: "pending",
              blocks: [],
              blockedBy: ["task-a"],
            },
          ],
        },
      } as unknown as SessionEvent,
      type: "todo",
      content: "",
      sender: "agent",
      timestamp: "2026-07-10T10:00:01Z",
      order: 1,
      isCurrent: false,
    };

    const { todos } = buildTimeline([
      todoMessage("existing", 0, [
        { id: "existing", content: "Existing task", status: "pending" },
      ]),
      graphMessage,
    ]);

    expect(todos.map((task) => task.id)).toEqual([
      "existing",
      "task-a",
      "task-b",
    ]);
  });

  it("does not clear replay state for a legacy graph event without extraction", () => {
    const legacyGraphMessage: MessageEntry = {
      eventId: "legacy-task-graph",
      event: {
        id: "legacy-task-graph",
        functionName: "task_graph_create",
        displayStatus: "completed",
        result: { created: true, tasks: [{ id: "task-a" }] },
      } as unknown as SessionEvent,
      type: "todo",
      content: "",
      sender: "agent",
      timestamp: "2026-07-10T10:00:01Z",
      order: 1,
      isCurrent: false,
    };

    expect(
      buildTimeline([
        todoMessage("existing", 0, [
          { id: "existing", content: "Existing task", status: "pending" },
        ]),
        legacyGraphMessage,
      ]).todos
    ).toEqual([
      { id: "existing", content: "Existing task", status: "pending" },
    ]);
  });

  it("removes a durably deleted task instead of moving it to Cancelled", () => {
    const deleteMessage: MessageEntry = {
      eventId: "delete-task",
      event: {
        id: "delete-task",
        functionName: "task_update",
        displayStatus: "completed",
        result: { deleted: true, id: "task-a" },
        extracted: {
          kind: "orgTask",
          action: "delete",
          outcome: "succeeded",
          task: {
            id: "task-a",
            subject: "Retired task",
            status: "deleted",
            blocks: [],
            blockedBy: [],
          },
          tasks: [],
        },
      } as unknown as SessionEvent,
      type: "todo",
      content: "",
      sender: "agent",
      timestamp: "2026-07-10T10:00:01Z",
      order: 1,
      isCurrent: false,
    };

    expect(
      buildTimeline([
        todoMessage("existing", 0, [
          { id: "task-a", content: "Retired task", status: "pending" },
          { id: "task-b", content: "Keep task", status: "pending" },
        ]),
        deleteMessage,
      ]).todos
    ).toEqual([{ id: "task-b", content: "Keep task", status: "pending" }]);
  });
});

describe("buildAgentOrgTaskTimeline", () => {
  it("uses the durable task status and timestamps", () => {
    const task: AgentOrgTask = {
      id: "task-1",
      orgRunId: "run-1",
      subject: "Review summaries",
      description: "Check accuracy",
      owner: "sde-reviewer",
      ownerMember: {
        memberId: "sde-reviewer",
        name: "Reviewer",
        role: "Reviews correctness",
        agentId: "builtin:sde",
      },
      status: "completed",
      blocks: [],
      blockedBy: [],
      executionMode: "build",
      createdAt: "2026-07-10T10:00:00Z",
      updatedAt: "2026-07-10T10:05:00Z",
    };

    const { todos, timeline } = buildAgentOrgTaskTimeline([task]);

    expect(todos).toEqual([
      {
        id: "task-1",
        content: "Review summaries",
        description: "Check accuracy",
        status: "completed",
        ownerName: "Reviewer · Reviews correctness",
        owner: "sde-reviewer",
      },
    ]);
    expect(timeline.get("task-1")).toEqual({
      createdTs: "2026-07-10T10:00:00Z",
      updatedTs: "2026-07-10T10:05:00Z",
    });
  });

  it("prefers an available durable snapshot over event-projected tasks", () => {
    const ghostMessage: MessageEntry = {
      eventId: "legacy-ghost",
      event: {
        id: "legacy-ghost",
        displayStatus: "completed",
        result: { task: { id: "ghost" } },
        extracted: {
          kind: "orgTask",
          action: "create",
          outcome: "succeeded",
          task: {
            id: "ghost",
            subject: "Event-only task",
            status: "pending",
            blocks: [],
            blockedBy: [],
          },
          tasks: [],
        },
      } as unknown as SessionEvent,
      type: "todo",
      content: "",
      sender: "agent",
      timestamp: "2026-07-10T10:00:00Z",
      order: 0,
      isCurrent: false,
    };

    expect(buildTodoKanbanTimeline([ghostMessage], []).todos).toEqual([]);
  });
});
