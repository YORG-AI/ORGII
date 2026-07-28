import { describe, expect, it } from "vitest";

import type { WorkItemFrontmatter } from "@src/api/http/project";
import type { WorkItem } from "@src/types/core/workItem";

import {
  applyStandaloneWorkItemUpdates,
  getAdjacentWorkItemId,
  getWorkItemNavigationState,
} from "../model";

const workItems = ["one", "two", "three"].map(
  (session_id) => ({ session_id }) as WorkItem
);

describe("WorkItemDetailPage model", () => {
  it("derives navigation around the active item", () => {
    expect(getWorkItemNavigationState(workItems, "one")).toEqual({
      index: 0,
      hasPrev: false,
      hasNext: true,
    });
    expect(getWorkItemNavigationState(workItems, "two")).toEqual({
      index: 1,
      hasPrev: true,
      hasNext: true,
    });
    expect(getWorkItemNavigationState(workItems, "missing")).toEqual({
      index: -1,
      hasPrev: false,
      hasNext: false,
    });
  });

  it("returns adjacent work item ids without crossing list bounds", () => {
    expect(getAdjacentWorkItemId(workItems, 1, "prev")).toBe("one");
    expect(getAdjacentWorkItemId(workItems, 1, "next")).toBe("three");
    expect(getAdjacentWorkItemId(workItems, 0, "prev")).toBeNull();
    expect(getAdjacentWorkItemId(workItems, 2, "next")).toBeNull();
  });

  it("maps supported standalone UI updates to frontmatter", () => {
    const frontmatter = {
      title: "Before",
      status: "todo",
      priority: "low",
      target_date: "2026-07-01",
    } as WorkItemFrontmatter;

    expect(
      applyStandaloneWorkItemUpdates(frontmatter, {
        name: "After",
        workItemStatus: "in_progress",
        priority: "high",
        endDate: undefined,
      })
    ).toMatchObject({
      title: "After",
      status: "in_progress",
      priority: "high",
      target_date: undefined,
    });
    expect(frontmatter.title).toBe("Before");
  });
});
