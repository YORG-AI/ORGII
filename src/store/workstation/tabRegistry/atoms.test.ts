import { createStore } from "jotai/vanilla";
import { describe, expect, it } from "vitest";

import { workstationActiveSessionIdAtom } from "@src/store/session/viewAtom";
import { chatPanelMaximizedAtom } from "@src/store/ui/chatPanelAtom";
import { stationModeAtom } from "@src/store/ui/simulatorAtom";
import { createBrowserSessionTab } from "@src/store/workstation/browser/tabs";
import {
  type WorkStationTab,
  createStartTab,
  workstationLayoutAtom,
  workstationTabsStateAtom,
} from "@src/store/workstation/tabs";
import {
  WORKSTATION_V3_SHARED_KEY,
  emptyWorkstationTabsState,
} from "@src/store/workstation/tabs/storage";

import {
  closeActiveWorkStationTabAtom,
  closeOtherTabsAtom,
  closeProjectOrgWorkStationTabsAtom,
  closeSavedTabsAtom,
  closeTabAtom,
} from "./atoms";

function tab(id: string, orgId?: string): WorkStationTab {
  return {
    id,
    type: "project-org",
    title: id,
    data: orgId ? { orgId } : {},
  };
}

describe("closeTabAtom", () => {
  it("maximizes chat when the sole My Station Launchpad closes", () => {
    const store = createStore();
    const launchpad = createStartTab();
    store.set(stationModeAtom, "my-station");
    store.set(chatPanelMaximizedAtom, false);
    store.set(workstationLayoutAtom, {
      mainPane: { tabs: [launchpad], activeTabId: launchpad.id },
    });

    store.set(closeTabAtom, { tabId: launchpad.id });

    expect(store.get(workstationLayoutAtom).mainPane).toEqual({
      tabs: [],
      activeTabId: null,
    });
    expect(store.get(chatPanelMaximizedAtom)).toBe(true);
  });

  it("does not maximize chat when a non-Launchpad last tab closes", () => {
    const store = createStore();
    const file = tab("file:/a.ts");
    store.set(stationModeAtom, "my-station");
    store.set(chatPanelMaximizedAtom, false);
    store.set(workstationLayoutAtom, {
      mainPane: { tabs: [file], activeTabId: file.id },
    });

    store.set(closeTabAtom, { tabId: file.id });

    expect(store.get(chatPanelMaximizedAtom)).toBe(false);
  });

  it("does not maximize chat from Agent Station", () => {
    const store = createStore();
    const launchpad = createStartTab();
    store.set(stationModeAtom, "agent-station");
    store.set(chatPanelMaximizedAtom, false);
    store.set(workstationLayoutAtom, {
      mainPane: { tabs: [launchpad], activeTabId: launchpad.id },
    });

    store.set(closeTabAtom, { tabId: launchpad.id });

    expect(store.get(chatPanelMaximizedAtom)).toBe(false);
  });
});

describe("closeProjectOrgWorkStationTabsAtom", () => {
  it("closes every surface for the deleted org and keeps other tabs", () => {
    const store = createStore();
    store.set(workstationLayoutAtom, {
      mainPane: {
        tabs: [
          tab("deleted-org", "org-deleted"),
          tab("deleted-project", "org-deleted"),
          tab("live-org", "org-live"),
          tab("unscoped"),
        ],
        activeTabId: "deleted-project",
      },
    });

    store.set(closeProjectOrgWorkStationTabsAtom, "org-deleted");

    expect(
      store.get(workstationLayoutAtom).mainPane.tabs.map((item) => item.id)
    ).toEqual(["live-org", "unscoped"]);
    expect(store.get(workstationLayoutAtom).mainPane.activeTabId).toBe(
      "live-org"
    );
  });
});

describe("live shared-resource close semantics", () => {
  function fileTab(id: string, hasUnsavedChanges = false): WorkStationTab {
    return {
      id,
      type: "file",
      title: id,
      data: { filePath: id.replace("file:", "") },
      hasUnsavedChanges,
    };
  }

  function sharedTab(
    id: string,
    type: "project-settings" | "terminal"
  ): WorkStationTab {
    return { id, type, title: id, data: {} };
  }

  it("tears down a browser resource through the unified TabBar close path", () => {
    const store = createStore();
    const state = emptyWorkstationTabsState();
    const browser = createBrowserSessionTab("browser-1", "Example");
    const local = fileTab("file:/a.ts");
    state.shared.tabs = [browser];
    state.sessionWorkspaces.A = {
      tabs: [local],
      activeTabRef: { partition: "shared", tabId: browser.id },
      tabOrder: [
        { partition: "shared", tabId: browser.id },
        { partition: "workspace", tabId: local.id },
      ],
    };
    state.sessionWorkspaces.B = {
      tabs: [],
      activeTabRef: { partition: "shared", tabId: browser.id },
      tabOrder: [{ partition: "shared", tabId: browser.id }],
    };
    store.set(workstationTabsStateAtom, state);
    store.set(workstationActiveSessionIdAtom, "A");

    store.set(closeTabAtom, { tabId: browser.id });

    const next = store.get(workstationTabsStateAtom);
    expect(next.shared.tabs).toEqual([]);
    expect(next.sessionWorkspaces.A.tabOrder).toEqual([
      { partition: "workspace", tabId: local.id },
    ]);
    expect(next.sessionWorkspaces.B.tabOrder).toEqual([]);
    expect(
      JSON.parse(localStorage.getItem(WORKSTATION_V3_SHARED_KEY) ?? "null")
    ).toEqual({ tabs: [] });

    store.set(workstationActiveSessionIdAtom, "B");
    expect(store.get(workstationLayoutAtom).mainPane.tabs).toEqual([]);
  });

  it("uses the same resource teardown for the active-tab shortcut path", () => {
    const store = createStore();
    const browser = createBrowserSessionTab("browser-1", "Example");
    store.set(workstationLayoutAtom, {
      mainPane: { tabs: [browser], activeTabId: browser.id },
    });

    expect(store.set(closeActiveWorkStationTabAtom)).toBe(true);

    expect(store.get(workstationTabsStateAtom).shared.tabs).toEqual([]);
  });

  it("batch-closes live resources once while retaining hidden lightweight shared tabs", () => {
    const store = createStore();
    const browserA = createBrowserSessionTab("browser-1", "One");
    const browserB = createBrowserSessionTab("browser-2", "Two");
    const terminal = sharedTab("terminal:main", "terminal");
    const settings = sharedTab("project-settings:main", "project-settings");
    const dirtyFile = fileTab("file:/dirty.ts", true);
    store.set(workstationLayoutAtom, {
      mainPane: {
        tabs: [browserA, browserB, terminal, settings, dirtyFile],
        activeTabId: browserB.id,
      },
    });

    store.set(closeSavedTabsAtom);

    const next = store.get(workstationTabsStateAtom);
    expect(next.shared.tabs).toEqual([settings]);
    expect(store.get(workstationLayoutAtom).mainPane).toEqual({
      tabs: [dirtyFile],
      activeTabId: dirtyFile.id,
    });
  });

  it("removes every omitted live resource through Close Others", () => {
    const store = createStore();
    const browserA = createBrowserSessionTab("browser-1", "One");
    const browserB = createBrowserSessionTab("browser-2", "Two");
    const terminal = sharedTab("terminal:main", "terminal");
    const settings = sharedTab("project-settings:main", "project-settings");
    store.set(workstationLayoutAtom, {
      mainPane: {
        tabs: [browserA, browserB, terminal, settings],
        activeTabId: browserB.id,
      },
    });

    store.set(closeOtherTabsAtom, { keepTabId: browserA.id });

    expect(store.get(workstationTabsStateAtom).shared.tabs).toEqual([
      browserA,
      settings,
    ]);
    expect(store.get(workstationLayoutAtom).mainPane).toEqual({
      tabs: [browserA],
      activeTabId: browserA.id,
    });
  });
});
