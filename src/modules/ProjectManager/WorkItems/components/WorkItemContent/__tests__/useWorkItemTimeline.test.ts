import { describe, expect, it } from "vitest";

import { WORK_ITEM_HISTORY_ACTION } from "@src/api/http/project/types";
import type { WorkItem } from "@src/types/core/workItem";

import { buildWorkItemTimelineEntries } from "../useWorkItemTimeline";

const translate = (key: string, options?: Record<string, unknown>) => {
  if (key === "workItems.activity.changedField") {
    return `changed ${String(options?.field)} from ${String(options?.from)} to ${String(options?.to)}`;
  }
  if (key === "workItems.activity.setField") {
    return `set ${String(options?.field)} to ${String(options?.value)}`;
  }
  if (key === "workItems.activity.changedDescription") {
    return "updated the description";
  }
  if (key === "workItems.activity.todoAdded") {
    return `added “${String(options?.todo)}”`;
  }
  if (key === "workItems.activity.todoRemoved") {
    return `removed “${String(options?.todo)}”`;
  }
  if (key === "workItems.activity.todoCompleted") {
    return `completed “${String(options?.todo)}”`;
  }
  if (key.startsWith("workItems.statusLabels.")) {
    const value = key.slice("workItems.statusLabels.".length);
    return (
      {
        in_review: "In Review",
        in_progress: "In Progress",
      }[value] ?? value
    );
  }
  if (key.startsWith("workItems.priorityLabels.")) {
    const value = key.slice("workItems.priorityLabels.".length);
    return value.charAt(0).toUpperCase() + value.slice(1);
  }
  const fieldPrefix = "workItems.activity.fields.";
  if (key.startsWith(fieldPrefix)) {
    return key.slice(fieldPrefix.length);
  }
  return key;
};

function workItemWithTimeline(
  timelineFields: Pick<WorkItem, "history" | "comments">
): WorkItem {
  return {
    session_id: "session-1",
    user_id: "user-1",
    name: "Test item",
    status: "todo",
    spec: "",
    star: false,
    target_date: null,
    created_time: "2026-01-01T00:00:00Z",
    updated_time: "2026-01-01T00:00:00Z",
    ...timelineFields,
  };
}

describe("work item history timeline", () => {
  it("uses persisted history event comments", () => {
    const entries = buildWorkItemTimelineEntries(
      workItemWithTimeline({
        comments: [],
        history: [
          {
            id: "history-1",
            action: WORK_ITEM_HISTORY_ACTION.COMMENTED,
            timestamp: "2026-01-01T00:00:00Z",
            actorName: "Ada",
            changes: [
              {
                field: "comments",
                oldValue: null,
                newValue: {
                  id: "comment-1",
                  author: "Ada",
                  content: "Persisted comment",
                  created_at: "2026-01-01T00:00:00Z",
                },
              },
            ],
          },
        ],
      }),
      translate
    );

    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe(WORK_ITEM_HISTORY_ACTION.COMMENTED);
    expect(entries[0].userName).toBe("Ada");
    expect(entries[0].descriptions).toEqual(["Persisted comment"]);
  });

  it("does not duplicate a legacy comment already represented by history", () => {
    const entries = buildWorkItemTimelineEntries(
      workItemWithTimeline({
        comments: [
          {
            id: "comment-1",
            author: "Ada",
            content: "Persisted comment",
            created_at: "2026-01-01T00:00:00Z",
          },
        ],
        history: [
          {
            id: "history-1",
            action: WORK_ITEM_HISTORY_ACTION.COMMENTED,
            timestamp: "2026-01-01T00:00:00Z",
            actorName: "Ada",
            changes: [
              {
                field: "comments",
                oldValue: null,
                newValue: {
                  id: "comment-1",
                  author: "Ada",
                  content: "Persisted comment",
                  created_at: "2026-01-01T00:00:00Z",
                },
              },
            ],
          },
        ],
      }),
      translate
    );

    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe("history-1");
  });

  it("renders multiple field changes as descriptions", () => {
    const entries = buildWorkItemTimelineEntries(
      workItemWithTimeline({
        comments: [],
        history: [
          {
            id: "history-2",
            action: WORK_ITEM_HISTORY_ACTION.UPDATED,
            timestamp: "2026-01-01T00:00:00Z",
            changes: [
              { field: "title", oldValue: "Old", newValue: "New" },
              { field: "body", oldValue: "Old body", newValue: "New body" },
            ],
          },
        ],
      }),
      translate
    );

    expect(entries[0].type).toBe(WORK_ITEM_HISTORY_ACTION.UPDATED);
    expect(entries[0].descriptions).toEqual([
      "changed title from Old to New",
      "updated the description",
    ]);
    expect(entries[0].changeFields).toEqual(["title", "description"]);
    expect(entries[0].changeFieldKeys).toEqual(["title", "body"]);
  });

  it("uses localized labels for status and priority values", () => {
    const entries = buildWorkItemTimelineEntries(
      workItemWithTimeline({
        comments: [],
        history: [
          {
            id: "history-labels",
            action: WORK_ITEM_HISTORY_ACTION.UPDATED,
            timestamp: "2026-01-01T00:00:00Z",
            changes: [
              {
                field: "status",
                oldValue: "in_review",
                newValue: "in_progress",
              },
              {
                field: "priority",
                oldValue: "medium",
                newValue: "urgent",
              },
            ],
          },
        ],
      }),
      translate
    );

    expect(entries[0].descriptions).toEqual([
      "changed status from In Review to In Progress",
      "changed priority from Medium to Urgent",
    ]);
  });

  it("formats date fields without leaking ISO storage values", () => {
    const entries = buildWorkItemTimelineEntries(
      workItemWithTimeline({
        comments: [],
        history: [
          {
            id: "history-dates",
            action: WORK_ITEM_HISTORY_ACTION.UPDATED,
            timestamp: "2026-07-28T01:15:00Z",
            changes: [
              {
                field: "targetDate",
                oldValue: "2026-07-28T12:00:00.000Z",
                newValue: "2026-07-29T12:00:00.000Z",
              },
            ],
          },
        ],
      }),
      translate
    );

    expect(entries[0].descriptions[0]).toContain("Jul 28, 2026");
    expect(entries[0].descriptions[0]).toContain("Jul 29, 2026");
    expect(entries[0].descriptions[0]).not.toContain("T12:00:00.000Z");
  });

  it("turns whole-checklist snapshots into item-level activity", () => {
    const entries = buildWorkItemTimelineEntries(
      workItemWithTimeline({
        comments: [],
        history: [
          {
            id: "history-todos",
            action: WORK_ITEM_HISTORY_ACTION.UPDATED,
            timestamp: "2026-07-28T12:54:00Z",
            changes: [
              {
                field: "todos",
                oldValue: [
                  { id: "one", content: "Keep", status: "pending" },
                  { id: "two", content: "Remove", status: "pending" },
                ],
                newValue: [
                  { id: "one", content: "Keep", status: "completed" },
                  { id: "three", content: "Add", status: "pending" },
                ],
              },
            ],
          },
        ],
      }),
      translate
    );

    expect(entries[0].descriptions).toEqual([
      "completed “Keep”",
      "added “Add”",
      "removed “Remove”",
    ]);
    expect(entries[0].changeFields).toEqual(["todos"]);
    expect(entries[0].changeFieldKeys).toEqual(["todos"]);
  });

  it("keeps malformed legacy checklist history on the generic fallback", () => {
    const entries = buildWorkItemTimelineEntries(
      workItemWithTimeline({
        comments: [],
        history: [
          {
            id: "history-invalid-todos",
            action: WORK_ITEM_HISTORY_ACTION.UPDATED,
            timestamp: "2026-07-28T12:54:00Z",
            changes: [
              {
                field: "todos",
                oldValue: "legacy",
                newValue: [{ content: "Missing id" }],
              },
            ],
          },
        ],
      }),
      translate
    );

    expect(entries[0].descriptions).toEqual([
      "workItems.activity.changedFieldShort",
    ]);
  });

  it("orders activity chronologically like the shared issue timeline", () => {
    const entries = buildWorkItemTimelineEntries(
      workItemWithTimeline({
        comments: [
          {
            id: "comment-early",
            author: "Ada",
            content: "First comment",
            created_at: "2026-01-01T00:00:00Z",
          },
        ],
        history: [
          {
            id: "history-late",
            action: WORK_ITEM_HISTORY_ACTION.UPDATED,
            timestamp: "2026-01-02T00:00:00Z",
            actorName: "Grace",
            summary: "Updated later",
          },
        ],
      }),
      translate
    );

    expect(entries.map((entry) => entry.id)).toEqual([
      "comment-early",
      "history-late",
    ]);
  });

  it("resolves stored member ids in history and legacy comments", () => {
    const entries = buildWorkItemTimelineEntries(
      workItemWithTimeline({
        comments: [
          {
            id: "comment-member",
            author: "member-2",
            content: "Member comment",
            created_at: "2026-01-02T00:00:00Z",
          },
        ],
        history: [
          {
            id: "history-member",
            action: WORK_ITEM_HISTORY_ACTION.UPDATED,
            timestamp: "2026-01-01T00:00:00Z",
            actorId: "member-2",
            actorName: "member-2",
            summary: "Updated",
          },
        ],
      }),
      translate,
      [
        {
          id: "member-2",
          name: "Lin",
          avatar: "https://example.com/lin.png",
          color: "#1677ff",
        },
      ]
    );

    expect(entries.map((entry) => entry.userName)).toEqual(["Lin", "Lin"]);
    expect(entries.map((entry) => entry.userAvatar)).toEqual([
      "https://example.com/lin.png",
      "https://example.com/lin.png",
    ]);
    expect(entries.map((entry) => entry.userColor)).toEqual([
      "#1677ff",
      "#1677ff",
    ]);
  });
});
