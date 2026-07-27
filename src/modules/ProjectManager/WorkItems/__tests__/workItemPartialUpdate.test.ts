import { describe, expect, it } from "vitest";

import { toWorkItemPartialUpdate } from "../workItemPartialUpdate";

describe("toWorkItemPartialUpdate", () => {
  it("maps editable Work Item fields to the project-store payload", () => {
    expect(
      toWorkItemPartialUpdate({
        name: "Inbox thread",
        spec: "Unified body",
        workItemStatus: "in_progress",
        priority: "high",
        assignee: { id: "member-1", name: "Ada" },
        labels: [{ id: "label-1", name: "UX", color: "#000000" }],
      })
    ).toMatchObject({
      title: "Inbox thread",
      body: "Unified body",
      status: "in_progress",
      priority: "high",
      assignee: "member-1",
      labels: ["label-1"],
    });
  });

  it("preserves explicit clears", () => {
    expect(
      toWorkItemPartialUpdate({
        assignee: null,
        milestone: null,
        labels: [],
        endDate: null,
      })
    ).toMatchObject({
      assignee: null,
      milestone: null,
      labels: [],
      targetDate: null,
    });
  });

  it("returns an empty payload when no persisted field changes", () => {
    expect(toWorkItemPartialUpdate({})).toEqual({});
  });
});
