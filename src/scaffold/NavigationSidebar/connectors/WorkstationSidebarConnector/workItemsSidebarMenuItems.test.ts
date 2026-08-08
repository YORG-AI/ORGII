import { describe, expect, it } from "vitest";

import {
  WORK_MANAGEMENT_PROJECTS_VIEW,
  WORK_MANAGEMENT_SECTION,
} from "@src/store/workstation";

import {
  KANBAN_MENU_ITEM_ID,
  WORK_ITEMS_GITHUB_ISSUES_MENU_ITEM_ID,
  WORK_ITEMS_GITHUB_PRS_MENU_ITEM_ID,
  WORK_ITEMS_MENU_ITEM_ID,
  WORK_ITEMS_PROJECTS_MENU_ITEM_ID,
  WORK_ITEMS_RUNS_MENU_ITEM_ID,
  isWorkManagementMenuItemId,
} from "../sidebarConnectorUtils";
import {
  buildWorkItemsSidebarMenuItems,
  resolveWorkItemsSidebarMenuItemId,
} from "./workItemsSidebarMenuItems";

describe("buildWorkItemsSidebarMenuItems", () => {
  it("builds the expandable Work Items destinations", () => {
    const items = buildWorkItemsSidebarMenuItems({
      workItems: "Work Items",
      projects: "Projects",
      githubIssues: "GitHub Issues",
      githubPrs: "GitHub PRs",
      runs: "Runs",
    });

    expect(items.map((item) => item.id)).toEqual([
      WORK_ITEMS_GITHUB_PRS_MENU_ITEM_ID,
      WORK_ITEMS_GITHUB_ISSUES_MENU_ITEM_ID,
      WORK_ITEMS_MENU_ITEM_ID,
      WORK_ITEMS_PROJECTS_MENU_ITEM_ID,
      WORK_ITEMS_RUNS_MENU_ITEM_ID,
    ]);
    expect(items[0]).toMatchObject({
      label: "GitHub PRs",
      iconName: "git-pull-request",
      dataTestId: "sidebar-work-items-github-prs",
    });
  });

  it("selects the active expanded child from canonical work management state", () => {
    expect(
      resolveWorkItemsSidebarMenuItemId({
        homeTab: WORK_MANAGEMENT_SECTION.PROJECTS,
        projectsView: WORK_MANAGEMENT_PROJECTS_VIEW.WORK_ITEMS,
      })
    ).toBe(WORK_ITEMS_MENU_ITEM_ID);
    expect(
      resolveWorkItemsSidebarMenuItemId({
        homeTab: WORK_MANAGEMENT_SECTION.GITHUB_PRS,
        projectsView: WORK_MANAGEMENT_PROJECTS_VIEW.PROJECTS,
      })
    ).toBe(WORK_ITEMS_GITHUB_PRS_MENU_ITEM_ID);
    expect(
      resolveWorkItemsSidebarMenuItemId({
        homeTab: WORK_MANAGEMENT_SECTION.KANBAN,
        projectsView: WORK_MANAGEMENT_PROJECTS_VIEW.WORK_ITEMS,
      })
    ).toBe(KANBAN_MENU_ITEM_ID);
  });

  it("routes Kanban and expanded Work Items rows to work management", () => {
    expect(isWorkManagementMenuItemId(KANBAN_MENU_ITEM_ID)).toBe(true);
    expect(isWorkManagementMenuItemId(WORK_ITEMS_MENU_ITEM_ID)).toBe(true);
    expect(isWorkManagementMenuItemId(WORK_ITEMS_PROJECTS_MENU_ITEM_ID)).toBe(
      true
    );
    expect(
      isWorkManagementMenuItemId(WORK_ITEMS_GITHUB_ISSUES_MENU_ITEM_ID)
    ).toBe(true);
    expect(isWorkManagementMenuItemId(WORK_ITEMS_GITHUB_PRS_MENU_ITEM_ID)).toBe(
      true
    );
    expect(isWorkManagementMenuItemId("session:example")).toBe(false);
  });
});
