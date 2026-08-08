import { describe, expect, it } from "vitest";

import type { WorkItem } from "@src/types/core/workItem";

import {
  filterWorkItemsBySearchQuery,
  isDeletedWorkItem,
} from "./workItemsViewModel";

function workItem(deletedAt?: string): WorkItem {
  return {
    session_id: "CUT-0001",
    name: "Remote tombstone",
    ...(deletedAt ? { deletedAt } : {}),
  } as WorkItem;
}

describe("isDeletedWorkItem", () => {
  it("treats a retained remote tombstone as unavailable", () => {
    expect(isDeletedWorkItem(workItem("2026-07-21T08:52:03.453Z"))).toBe(true);
  });

  it("keeps a live work item available", () => {
    expect(isDeletedWorkItem(workItem())).toBe(false);
  });
});

describe("filterWorkItemsBySearchQuery", () => {
  const workItems = [
    {
      session_id: "CUT-0001",
      shortId: "CUT-1",
      name: "Fix login authentication",
      project: { id: "project-1", name: "Desktop" },
      assignee: { id: "member-1", name: "Alice" },
      labels: [{ id: "label-1", name: "Security", color: "#ff0000" }],
    },
    {
      session_id: "CUT-0002",
      shortId: "CUT-2",
      name: "Refresh dashboard",
      project: { id: "project-2", name: "Web" },
      labels: [],
    },
  ] as WorkItem[];

  it("shares title, id, project, assignee, and label matching", () => {
    expect(filterWorkItemsBySearchQuery(workItems, "login")).toHaveLength(1);
    expect(filterWorkItemsBySearchQuery(workItems, "cut-2")).toHaveLength(1);
    expect(filterWorkItemsBySearchQuery(workItems, "desktop")).toHaveLength(1);
    expect(filterWorkItemsBySearchQuery(workItems, "alice")).toHaveLength(1);
    expect(filterWorkItemsBySearchQuery(workItems, "security")).toHaveLength(1);
  });

  it("returns the original bounded result set for a blank query", () => {
    expect(filterWorkItemsBySearchQuery(workItems, "   ")).toBe(workItems);
  });
});
