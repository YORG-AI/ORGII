import { describe, expect, it, vi } from "vitest";

import { PROJECTS_NEW_WORK_ITEM_MENU_ITEM_ID } from "../sidebarConnectorUtils";
import {
  openNewWorkItemFromSidebar,
  tryOpenLinkedSessionFromSidebar,
} from "./useProjectsMenuItemClick";

describe("openNewWorkItemFromSidebar", () => {
  it("opens the shared work-item creator from a sidebar action", () => {
    const calls: string[] = [];
    const resetWorkManagementStateForProjectsContent = vi.fn(() =>
      calls.push("reset")
    );
    const setProjectsSelectedMenuItemId = vi.fn(() => calls.push("select"));
    const openWorkItemCreator = vi.fn(() =>
      calls.push("open-work-item-creator")
    );

    openNewWorkItemFromSidebar({
      openWorkItemCreator,
      resetWorkManagementStateForProjectsContent,
      setProjectsSelectedMenuItemId,
    });

    expect(setProjectsSelectedMenuItemId).toHaveBeenCalledWith(
      PROJECTS_NEW_WORK_ITEM_MENU_ITEM_ID
    );
    expect(openWorkItemCreator).toHaveBeenCalledOnce();
    expect(calls).toEqual(["reset", "select", "open-work-item-creator"]);
  });
});

describe("tryOpenLinkedSessionFromSidebar", () => {
  it("selects and opens a linked-session child row", () => {
    const setProjectsSelectedMenuItemId = vi.fn();
    const openLinkedSession = vi.fn();
    const item = {
      id: "session-1",
      key: "work-item-linked-session:work-item-1:session-1",
      label: "SDE #1",
    };

    expect(
      tryOpenLinkedSessionFromSidebar({
        item,
        linkedSessionIds: new Set(["session-1"]),
        setProjectsSelectedMenuItemId,
        openLinkedSession,
      })
    ).toBe(true);
    expect(setProjectsSelectedMenuItemId).toHaveBeenCalledWith(item.key);
    expect(openLinkedSession).toHaveBeenCalledWith(item);
  });
});
