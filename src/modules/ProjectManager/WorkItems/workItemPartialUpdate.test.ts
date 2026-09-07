import { describe, expect, it } from "vitest";

import {
  buildBatchQuickFieldUpdate,
  toWorkItemPartialUpdate,
} from "./workItemPartialUpdate";

describe("toWorkItemPartialUpdate", () => {
  it("maps editable Work Item fields to the project-store payload", () => {
    expect(
      toWorkItemPartialUpdate(
        {
          name: "Inbox thread",
          spec: "Unified body",
          workItemStatus: "in_progress",
          priority: "high",
          assignee: { id: "member-1", name: "Ada" },
          labels: [{ id: "label-1", name: "UX", color: "#000000" }],
        },
        { id: "member-1", name: " Ada " }
      )
    ).toMatchObject({
      title: "Inbox thread",
      body: "Unified body",
      status: "in_progress",
      priority: "high",
      assignee: "member-1",
      labels: ["label-1"],
      actor: { id: "member-1", name: "Ada" },
    });
  });

  it("preserves explicit clears", () => {
    expect(
      toWorkItemPartialUpdate({
        assignee: null,
        milestone: null,
        project: null,
        labels: [],
        endDate: null,
      })
    ).toMatchObject({
      assignee: null,
      milestone: null,
      project: null,
      labels: [],
      targetDate: null,
    });
  });

  it("returns an empty payload when no persisted field changes", () => {
    expect(
      toWorkItemPartialUpdate({}, { id: "member-1", name: "Ada" })
    ).toEqual({});
  });
});

describe("buildBatchQuickFieldUpdate", () => {
  it("builds a status payload", () => {
    expect(buildBatchQuickFieldUpdate("status", "in_progress")).toEqual({
      status: "in_progress",
    });
  });

  it("builds a priority payload", () => {
    expect(buildBatchQuickFieldUpdate("priority", "urgent")).toEqual({
      priority: "urgent",
    });
  });

  it("builds an assignee payload for a real member", () => {
    expect(buildBatchQuickFieldUpdate("assignee", "member-1")).toEqual({
      assignee: "member-1",
      assigneeType: "human",
    });
  });

  it("clears both assignee fields for the no-assignee sentinel", () => {
    expect(buildBatchQuickFieldUpdate("assignee", "none")).toEqual({
      assignee: null,
      assigneeType: null,
    });
  });
});
