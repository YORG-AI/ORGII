import { describe, expect, it } from "vitest";

import {
  KANBAN_MENU_ITEM_ID,
  RUNTIME_MENU_ITEM_ID,
  TEAM_INBOX_MENU_ITEM_ID,
  WORK_ITEMS_MENU_ITEM_ID,
  WORK_ITEMS_PROJECTS_MENU_ITEM_ID,
} from "./sidebarConnectorUtils";
import {
  buildPinnedMenuItems,
  buildProjectsPinnedMenuItems,
} from "./workstationSidebarMenuItems";

describe("buildPinnedMenuItems", () => {
  it("renders Kanban separately from the expandable Work Items group", () => {
    const items = buildPinnedMenuItems({
      newSessionLabel: "New Session",
      newSessionShortcut: "⌘N",
      workItemsLabel: "Work Items",
      workItemDestinations: [
        {
          id: WORK_ITEMS_PROJECTS_MENU_ITEM_ID,
          key: WORK_ITEMS_PROJECTS_MENU_ITEM_ID,
          label: "Projects",
        },
      ],
      kanbanLabel: "Kanban",
      kanbanShortcut: "⌘O",
      runtimeLabel: "Runtime",
      teamInboxLabel: "Team Inbox",
    });

    expect(items.map((item) => item.id)).toEqual([
      "new-session",
      KANBAN_MENU_ITEM_ID,
      RUNTIME_MENU_ITEM_ID,
      TEAM_INBOX_MENU_ITEM_ID,
      WORK_ITEMS_MENU_ITEM_ID,
    ]);
    expect(items[4]?.children?.map((item) => item.id)).toEqual([
      WORK_ITEMS_PROJECTS_MENU_ITEM_ID,
    ]);
    expect(items[4]?.routePath).toBeUndefined();
    expect(items[3]).toMatchObject({
      label: "Team Inbox",
      dataTestId: "sidebar-team-inbox",
    });
    expect(items[2]).toMatchObject({
      label: "Runtime",
      dataTestId: "sidebar-runtime",
    });
    expect(items[0]?.openContextMenuOnSelectedClick).toBeUndefined();
  });

  it("keeps destination navigation available inside the Work Items layer", () => {
    const items = buildProjectsPinnedMenuItems({
      createProjectLabel: "Create Project",
      createWorkItemLabel: "Create Work Item",
      importGithubIssuesLabel: "Import GitHub Issues",
      workItemDestinations: [
        {
          id: WORK_ITEMS_PROJECTS_MENU_ITEM_ID,
          key: WORK_ITEMS_PROJECTS_MENU_ITEM_ID,
          label: "Projects",
        },
      ],
    });

    expect(items.at(-1)?.id).toBe(WORK_ITEMS_PROJECTS_MENU_ITEM_ID);
  });
});
