import { describe, expect, it } from "vitest";

import {
  KANBAN_MENU_ITEM_ID,
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
    });

    expect(items.map((item) => item.id)).toEqual([
      "new-session",
      KANBAN_MENU_ITEM_ID,
      WORK_ITEMS_MENU_ITEM_ID,
    ]);
    expect(items[2]?.children?.map((item) => item.id)).toEqual([
      WORK_ITEMS_PROJECTS_MENU_ITEM_ID,
    ]);
    expect(items[2]?.routePath).toBeUndefined();
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
