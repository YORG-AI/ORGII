import { describe, expect, it } from "vitest";

import type { WorkItem, WorkItemStatus } from "@src/types/core/workItem";

import {
  countWorkspaceWorkItemsByStatus,
  filterWorkspaceWorkItemsByStatus,
  getWorkspaceStatusFilterKeysForWorkItems,
  groupWorkspaceWorkItemsForStatusFilter,
} from "./workItemsViewModel";

function workItem(id: string, status: WorkItemStatus): WorkItem {
  return {
    session_id: id,
    name: id,
    status,
    workItemStatus: status,
  } as WorkItem;
}

describe("workspace work item status model", () => {
  const items = [
    workItem("github-open", "open"),
    workItem("github-closed", "closed"),
    workItem("local-active", "in_progress"),
    workItem("local-completed", "completed"),
  ];

  it("groups GitHub closed and local completed items under Completed", () => {
    const groups = groupWorkspaceWorkItemsForStatusFilter(items, "all");
    const completedGroup = groups.find((group) => group.status === "completed");

    expect(groups.some((group) => group.status === "closed")).toBe(false);
    expect(completedGroup?.items.map((item) => item.session_id)).toEqual([
      "github-closed",
      "local-completed",
    ]);
  });

  it("uses the Completed filter for both terminal status families", () => {
    expect(
      filterWorkspaceWorkItemsByStatus(items, "done").map(
        (item) => item.session_id
      )
    ).toEqual(["github-closed", "local-completed"]);
  });

  it("replaces the Closed filter with Completed and combines its count", () => {
    expect(getWorkspaceStatusFilterKeysForWorkItems(items)).not.toContain(
      "closed"
    );
    expect(getWorkspaceStatusFilterKeysForWorkItems(items)).toContain("done");

    const counts = countWorkspaceWorkItemsByStatus(items);
    expect(counts.done).toBe(2);
    expect(counts.closed).toBe(0);
  });

  it("still exposes an empty Completed group before its lazy bucket loads", () => {
    const groups = groupWorkspaceWorkItemsForStatusFilter(
      [workItem("github-open", "open")],
      "all"
    );

    expect(groups.find((group) => group.status === "completed")?.items).toEqual(
      []
    );
  });

  it("does not leak the Completed group into another selected filter", () => {
    const groups = groupWorkspaceWorkItemsForStatusFilter(
      [workItem("local-active", "in_progress")],
      "open"
    );

    expect(groups).toEqual([]);
  });
});
