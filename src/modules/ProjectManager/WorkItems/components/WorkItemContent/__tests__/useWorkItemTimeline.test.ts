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
});
