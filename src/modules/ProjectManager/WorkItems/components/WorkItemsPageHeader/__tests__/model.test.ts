import { describe, expect, it } from "vitest";

import {
  shouldShowCollapseAll,
  shouldShowWorkItemStatusFilter,
  supportsWorkItemStatusFilter,
} from "../model";

describe("WorkItemsPageHeader model", () => {
  it.each([
    ["List", true],
    ["Kanban", true],
    ["Overview", false],
    ["Gantt", false],
    ["Calendar", false],
    ["Settings", false],
  ] as const)("reports status-filter support for %s", (tab, expected) => {
    expect(supportsWorkItemStatusFilter(tab)).toBe(expected);
  });

  it("requires a filter value and change handler", () => {
    expect(shouldShowWorkItemStatusFilter("List", "all", true)).toBe(true);
    expect(shouldShowWorkItemStatusFilter("List", undefined, true)).toBe(false);
    expect(shouldShowWorkItemStatusFilter("List", "all", false)).toBe(false);
    expect(shouldShowWorkItemStatusFilter("Overview", "all", true)).toBe(false);
  });

  it("shows collapse-all only for list views with a handler", () => {
    expect(shouldShowCollapseAll("List", true)).toBe(true);
    expect(shouldShowCollapseAll("List", false)).toBe(false);
    expect(shouldShowCollapseAll("Kanban", true)).toBe(false);
  });
});
