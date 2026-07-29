import { describe, expect, it } from "vitest";

import { describeTodoHistoryChange } from "../todoHistory";

const translate = (key: string, options?: Record<string, unknown>) => {
  const todo = String(options?.todo ?? "");
  switch (key) {
    case "workItems.activity.todoAdded":
      return `added “${todo}”`;
    case "workItems.activity.todoRemoved":
      return `removed “${todo}”`;
    case "workItems.activity.todoCompleted":
      return `completed “${todo}”`;
    case "workItems.activity.todoReopened":
      return `reopened “${todo}”`;
    case "workItems.activity.todoStarted":
      return `started “${todo}”`;
    case "workItems.activity.todoMarkedPending":
      return `marked “${todo}” as pending`;
    case "workItems.activity.todoUpdated":
      return `updated “${todo}”`;
    case "workItems.activity.todoRenamed":
      return `renamed “${String(options?.from)}” to “${String(options?.to)}”`;
    default:
      return key;
  }
};

const todo = (id: string, content: string, status = "pending") => ({
  id,
  content,
  status,
});

describe("describeTodoHistoryChange", () => {
  it("describes additions and removals by checklist item", () => {
    expect(
      describeTodoHistoryChange(
        [todo("one", "Keep"), todo("removed", "Remove me")],
        [todo("one", "Keep"), todo("added", "Ship it")],
        translate
      )
    ).toEqual(["added “Ship it”", "removed “Remove me”"]);
  });

  it("describes every supported checklist status transition", () => {
    expect(
      describeTodoHistoryChange(
        [
          todo("complete", "Complete me"),
          todo("reopen", "Reopen me", "completed"),
          todo("start", "Start me"),
          todo("pause", "Pause me", "in_progress"),
        ],
        [
          todo("complete", "Complete me", "completed"),
          todo("reopen", "Reopen me"),
          todo("start", "Start me", "in_progress"),
          todo("pause", "Pause me"),
        ],
        translate
      )
    ).toEqual([
      "completed “Complete me”",
      "reopened “Reopen me”",
      "started “Start me”",
      "marked “Pause me” as pending",
    ]);
  });

  it("keeps rename and status changes as separate meaningful actions", () => {
    expect(
      describeTodoHistoryChange(
        [todo("one", "Draft")],
        [todo("one", "Final", "completed")],
        translate
      )
    ).toEqual(["renamed “Draft” to “Final”", "completed “Final”"]);
  });

  it("falls back for malformed, duplicate, or reorder-only snapshots", () => {
    expect(
      describeTodoHistoryChange("not-a-checklist", [], translate)
    ).toBeNull();
    expect(
      describeTodoHistoryChange(
        [todo("same", "One"), todo("same", "Two")],
        [],
        translate
      )
    ).toBeNull();
    expect(
      describeTodoHistoryChange(
        [todo("one", "One"), todo("two", "Two")],
        [todo("two", "Two"), todo("one", "One")],
        translate
      )
    ).toBeNull();
  });
});
