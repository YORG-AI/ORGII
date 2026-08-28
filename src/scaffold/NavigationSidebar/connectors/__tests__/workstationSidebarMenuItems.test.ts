import type React from "react";
import { describe, expect, it } from "vitest";

import { TrelloIcon } from "@src/icons";
import { GENERAL_LAYOUT_TOUR_TARGETS } from "@src/scaffold/Tutorials/generalLayoutTourConfig";

import {
  KANBAN_MENU_ITEM_ID,
  RUNTIME_MENU_ITEM_ID,
  TEAM_INBOX_MENU_ITEM_ID,
  WORK_ITEMS_PROJECTS_MENU_ITEM_ID,
} from "../sidebarConnectorUtils";
import {
  buildChannelsPinnedMenuItems,
  buildPinnedMenuItems,
  buildProjectsPinnedMenuItems,
} from "../workstationSidebarMenuItems";

describe("buildPinnedMenuItems", () => {
  it("does not repeat the top-level Work Items tab inside Sessions", () => {
    const items = buildPinnedMenuItems({
      newSessionLabel: "New Session",
      newSessionShortcut: "⌘N",
      kanbanLabel: "Kanban",
      kanbanShortcut: "⌘O",
      runtimeLabel: "Runtime",
      teamInboxLabel: "Inbox",
    });

    expect(items.map((item) => item.id)).toEqual([
      "new-session",
      KANBAN_MENU_ITEM_ID,
      RUNTIME_MENU_ITEM_ID,
      TEAM_INBOX_MENU_ITEM_ID,
    ]);
    expect(items[3]).toMatchObject({
      label: "Inbox",
      dataTestId: "sidebar-team-inbox",
    });
    expect(items[2]).toMatchObject({
      label: "Runtime",
      dataTestId: "sidebar-runtime",
      tourTarget: GENERAL_LAYOUT_TOUR_TARGETS.runtimeNavigation,
    });
    expect(items[1]).toMatchObject({
      icon: TrelloIcon,
      iconName: "trello",
    });
    expect(items[0]?.openContextMenuOnSelectedClick).toBeUndefined();
  });

  it("translates the unread badge aria-label when one is supplied", () => {
    const items = buildPinnedMenuItems({
      newSessionLabel: "New Session",
      newSessionShortcut: "⌘N",
      kanbanLabel: "Kanban",
      kanbanShortcut: "⌘O",
      runtimeLabel: "Runtime",
      teamInboxLabel: "Team Inbox",
      teamInboxUnreadCount: 3,
      teamInboxUnreadAriaLabel: "3 no leídos",
    });

    const badge = items[3]?.trailingElement as React.ReactElement<{
      "aria-label"?: string;
    }>;
    expect(badge?.props["aria-label"]).toBe("3 no leídos");
  });

  it("falls back to an English badge aria-label when none is supplied", () => {
    const items = buildPinnedMenuItems({
      newSessionLabel: "New Session",
      newSessionShortcut: "⌘N",
      kanbanLabel: "Kanban",
      kanbanShortcut: "⌘O",
      runtimeLabel: "Runtime",
      teamInboxLabel: "Team Inbox",
      teamInboxUnreadCount: 5,
    });

    const badge = items[3]?.trailingElement as React.ReactElement<{
      "aria-label"?: string;
    }>;
    expect(badge?.props["aria-label"]).toBe("5 unread");
  });

  it("keeps destination navigation available inside the Work Items layer", () => {
    const items = buildProjectsPinnedMenuItems({
      browseLabel: "Browse",
      createProjectLabel: "Create Project",
      createWorkItemLabel: "Create Work Item",
      importGithubIssuesLabel: "Import GitHub Issues",
      teamInboxLabel: "Inbox",
      workItemDestinations: [
        {
          id: WORK_ITEMS_PROJECTS_MENU_ITEM_ID,
          key: WORK_ITEMS_PROJECTS_MENU_ITEM_ID,
          label: "Projects",
        },
      ],
    });

    expect(items.at(-2)).toMatchObject({
      id: "separator-work-items-browse",
      label: "Browse",
    });
    expect(items.at(-1)?.id).toBe(WORK_ITEMS_PROJECTS_MENU_ITEM_ID);
    expect(
      items.find((item) => item.id === TEAM_INBOX_MENU_ITEM_ID)
    ).toMatchObject({
      label: "Inbox",
      dataTestId: "sidebar-team-inbox",
    });
  });

  it("keeps the same Inbox entry available in Channels", () => {
    expect(buildChannelsPinnedMenuItems({ teamInboxLabel: "Inbox" })).toEqual([
      expect.objectContaining({
        id: TEAM_INBOX_MENU_ITEM_ID,
        label: "Inbox",
        dataTestId: "sidebar-team-inbox",
      }),
    ]);
  });
});
