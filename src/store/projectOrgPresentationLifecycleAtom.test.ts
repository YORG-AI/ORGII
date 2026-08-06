import { createStore } from "jotai/vanilla";
import { beforeEach, describe, expect, it } from "vitest";

import { chatPanelTabsAtom } from "@src/store/chatPanel/chatPanelTabsState";
import { workstationTabsStateAtom } from "@src/store/workstation/tabs/atoms";
import { emptyWorkstationTabsState } from "@src/store/workstation/tabs/storage";

import { invalidateProjectOrgPresentationAtom } from "./projectOrgPresentationLifecycleAtom";

beforeEach(() => {
  localStorage.clear();
});

describe("invalidateProjectOrgPresentationAtom", () => {
  it("removes a deleted org from ChatPanel and every WorkStation workspace", () => {
    const store = createStore();
    store.set(chatPanelTabsAtom, {
      tabs: [
        { id: "launch", type: "start-page", title: "Launchpad" },
        {
          id: "project-deleted",
          type: "project",
          title: "Deleted",
          project: {
            project: {
              id: "project-deleted",
              name: "Deleted",
              status: "in_progress",
              priority: "medium",
              health: "on_track",
              createdAt: "2026-08-05T00:00:00.000Z",
              updatedAt: "2026-08-05T00:00:00.000Z",
            },
            projectSlug: "deleted",
            orgId: "org-deleted",
          },
        },
        {
          id: "project-live",
          type: "project",
          title: "Live",
          project: {
            project: {
              id: "project-live",
              name: "Live",
              status: "in_progress",
              priority: "medium",
              health: "on_track",
              createdAt: "2026-08-05T00:00:00.000Z",
              updatedAt: "2026-08-05T00:00:00.000Z",
            },
            projectSlug: "live",
            orgId: "org-live",
          },
        },
      ],
      activeTabId: "launch",
    });

    const workstation = emptyWorkstationTabsState();
    workstation.shared.tabs = [
      {
        id: "project-org:deleted",
        type: "project-org",
        title: "Deleted",
        data: { orgId: "org-deleted" },
      },
      {
        id: "project-org:live",
        type: "project-org",
        title: "Live",
        data: { orgId: "org-live" },
      },
    ];
    workstation.sessionWorkspaces.A = {
      tabs: [],
      activeTabRef: {
        partition: "shared",
        tabId: "project-org:deleted",
      },
      tabOrder: [
        { partition: "shared", tabId: "project-org:deleted" },
        { partition: "shared", tabId: "project-org:live" },
      ],
    };
    workstation.sessionWorkspaces.B = {
      tabs: [],
      activeTabRef: {
        partition: "shared",
        tabId: "project-org:deleted",
      },
      tabOrder: [
        { partition: "shared", tabId: "project-org:deleted" },
        { partition: "shared", tabId: "project-org:live" },
      ],
    };
    store.set(workstationTabsStateAtom, workstation);

    store.set(invalidateProjectOrgPresentationAtom, "org-deleted");

    expect(store.get(chatPanelTabsAtom).tabs.map((tab) => tab.id)).toEqual([
      "launch",
      "project-live",
    ]);
    const next = store.get(workstationTabsStateAtom);
    expect(next.shared.tabs.map((tab) => tab.id)).toEqual(["project-org:live"]);
    for (const workspace of Object.values(next.sessionWorkspaces)) {
      expect(workspace.tabOrder).toEqual([
        { partition: "shared", tabId: "project-org:live" },
      ]);
    }
  });
});
