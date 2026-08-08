import { createStore } from "jotai/vanilla";
import { beforeEach, describe, expect, it } from "vitest";

import { workstationActiveSessionIdAtom } from "@src/store/session/viewAtom";
import { workstationTabsStateAtom } from "@src/store/workstation/tabs/atoms";
import { emptyWorkstationTabsState } from "@src/store/workstation/tabs/storage";
import type {
  WorkStationTab,
  WorkstationWorkspaceState,
} from "@src/store/workstation/tabs/types";

import {
  browserTabsAtom,
  closeBrowserTabAtom,
  closeOtherBrowserTabsAtom,
  closeSavedBrowserTabsAtom,
  createBrowserSessionTab,
  removeBrowserResourceTabAtom,
  sharedBrowserTabsAtom,
} from "../index";

function localWorkspace(tabId: string): WorkstationWorkspaceState {
  const tab: WorkStationTab = {
    id: tabId,
    type: "file",
    title: tabId,
    data: { filePath: tabId.replace("file:", "") },
  };
  return {
    tabs: [tab],
    activeTabRef: { partition: "workspace", tabId: tab.id },
    tabOrder: [{ partition: "workspace", tabId: tab.id }],
  };
}

beforeEach(() => {
  localStorage.clear();
});

describe("browserTabsAtom shared-resource integration", () => {
  it("projects shared browser resources only in workspaces that reference them", () => {
    const store = createStore();
    const state = emptyWorkstationTabsState();
    const browserTab = createBrowserSessionTab("browser-1", "Example", {
      url: "https://example.com",
    });
    state.shared.tabs = [browserTab];
    state.sessionWorkspaces.A = {
      ...localWorkspace("file:/a.ts"),
      tabOrder: [
        { partition: "shared", tabId: browserTab.id },
        { partition: "workspace", tabId: "file:/a.ts" },
      ],
    };
    state.sessionWorkspaces.B = localWorkspace("file:/b.ts");
    store.set(workstationTabsStateAtom, state);

    store.set(workstationActiveSessionIdAtom, "A");
    expect(store.get(browserTabsAtom).tabs).toEqual([browserTab]);

    store.set(workstationActiveSessionIdAtom, "B");
    expect(store.get(browserTabsAtom).tabs).toEqual([]);
    expect(store.get(workstationTabsStateAtom).shared.tabs).toEqual([
      browserTab,
    ]);
    expect(
      store.get(workstationTabsStateAtom).sessionWorkspaces.A.tabs
    ).toHaveLength(1);
  });

  it("writes browser-family changes to shared state without replacing workspace-local tabs", () => {
    const store = createStore();
    const state = emptyWorkstationTabsState();
    state.sessionWorkspaces.A = localWorkspace("file:/a.ts");
    state.sessionWorkspaces.B = localWorkspace("file:/b.ts");
    store.set(workstationTabsStateAtom, state);
    store.set(workstationActiveSessionIdAtom, "A");

    const browserTab = createBrowserSessionTab("browser-1", "Example", {
      url: "https://example.com",
    });
    store.set(browserTabsAtom, {
      tabs: [browserTab],
      activeTabId: browserTab.id,
    });

    const next = store.get(workstationTabsStateAtom);
    expect(next.shared.tabs).toEqual([browserTab]);
    expect(next.sessionWorkspaces.A.tabs[0]?.id).toBe("file:/a.ts");
    expect(next.sessionWorkspaces.B.tabs[0]?.id).toBe("file:/b.ts");
    expect(next.sessionWorkspaces.A.activeTabRef).toEqual({
      partition: "shared",
      tabId: browserTab.id,
    });
  });

  it("hides a browser tab without tearing down its shared resource", () => {
    const store = createStore();
    const state = emptyWorkstationTabsState();
    const browserTab = createBrowserSessionTab("browser-1", "Example", {
      url: "https://example.com",
    });
    state.shared.tabs = [browserTab];
    state.sessionWorkspaces.A = localWorkspace("file:/a.ts");
    state.sessionWorkspaces.B = {
      ...localWorkspace("file:/b.ts"),
      tabOrder: [
        { partition: "shared", tabId: browserTab.id },
        { partition: "workspace", tabId: "file:/b.ts" },
      ],
    };
    store.set(workstationTabsStateAtom, state);

    store.set(workstationActiveSessionIdAtom, "B");
    expect(store.get(browserTabsAtom).tabs).toEqual([browserTab]);

    store.set(browserTabsAtom, { tabs: [], activeTabId: null });
    expect(store.get(workstationTabsStateAtom).shared.tabs).toEqual([
      browserTab,
    ]);
    expect(store.get(browserTabsAtom).tabs).toEqual([]);
    expect(
      store.get(workstationTabsStateAtom).sessionWorkspaces.A.tabs[0]?.id
    ).toBe("file:/a.ts");
    expect(
      store.get(workstationTabsStateAtom).sessionWorkspaces.B.tabs[0]?.id
    ).toBe("file:/b.ts");
  });

  it("keeps a browser resource alive but hidden when another workspace closes its reference", () => {
    const store = createStore();
    const state = emptyWorkstationTabsState();
    const browserTab = createBrowserSessionTab("browser-1", "Example", {
      url: "https://example.com",
    });
    state.shared.tabs = [browserTab];
    state.sessionWorkspaces.A = {
      ...localWorkspace("file:/a.ts"),
      activeTabRef: { partition: "shared", tabId: browserTab.id },
      tabOrder: [
        { partition: "shared", tabId: browserTab.id },
        { partition: "workspace", tabId: "file:/a.ts" },
      ],
    };
    state.sessionWorkspaces.B = localWorkspace("file:/b.ts");
    store.set(workstationTabsStateAtom, state);

    store.set(workstationActiveSessionIdAtom, "A");
    store.set(browserTabsAtom, { tabs: [], activeTabId: null });

    expect(store.get(workstationTabsStateAtom).shared.tabs).toEqual([
      browserTab,
    ]);
    expect(store.get(browserTabsAtom).tabs).toEqual([]);
    store.set(workstationActiveSessionIdAtom, "B");
    expect(store.get(browserTabsAtom).tabs).toEqual([]);
  });

  it("keeps the global browser-resource view stable across workspace switches", () => {
    const store = createStore();
    const state = emptyWorkstationTabsState();
    const browserTab = createBrowserSessionTab("browser-1", "Example");
    state.shared.tabs = [browserTab];
    state.sessionWorkspaces.A = {
      ...localWorkspace("file:/a.ts"),
      tabOrder: [
        { partition: "shared", tabId: browserTab.id },
        { partition: "workspace", tabId: "file:/a.ts" },
      ],
    };
    state.sessionWorkspaces.B = localWorkspace("file:/b.ts");
    store.set(workstationTabsStateAtom, state);

    store.set(workstationActiveSessionIdAtom, "A");
    expect(store.get(sharedBrowserTabsAtom)).toEqual([browserTab]);
    store.set(workstationActiveSessionIdAtom, "B");
    expect(store.get(browserTabsAtom).tabs).toEqual([]);
    expect(store.get(sharedBrowserTabsAtom)).toEqual([browserTab]);
  });

  it("removes a browser resource globally through the normal close action", () => {
    const store = createStore();
    const state = emptyWorkstationTabsState();
    const browserTab = createBrowserSessionTab("browser-1", "Example");
    state.shared.tabs = [browserTab];
    state.sessionWorkspaces.A = {
      ...localWorkspace("file:/a.ts"),
      tabOrder: [
        { partition: "shared", tabId: browserTab.id },
        { partition: "workspace", tabId: "file:/a.ts" },
      ],
    };
    store.set(workstationTabsStateAtom, state);
    store.set(workstationActiveSessionIdAtom, "A");

    store.set(closeBrowserTabAtom, browserTab.id);

    expect(store.get(workstationTabsStateAtom).shared.tabs).toEqual([]);
    expect(store.get(sharedBrowserTabsAtom)).toEqual([]);
  });

  it("removes a browser resource globally only through the explicit owner action", () => {
    const store = createStore();
    const state = emptyWorkstationTabsState();
    const browserTab = createBrowserSessionTab("browser-1", "Example");
    state.shared.tabs = [browserTab];
    state.sessionWorkspaces.A = localWorkspace("file:/a.ts");
    store.set(workstationTabsStateAtom, state);

    store.set(removeBrowserResourceTabAtom, browserTab.id);

    expect(store.get(workstationTabsStateAtom).shared.tabs).toEqual([]);
  });

  it("tears down omitted resources through browser-owned bulk close actions", () => {
    const store = createStore();
    const browserA = createBrowserSessionTab("browser-1", "One");
    const browserB = createBrowserSessionTab("browser-2", "Two");
    const browserC = createBrowserSessionTab("browser-3", "Three");
    store.set(browserTabsAtom, {
      tabs: [browserA, browserB, browserC],
      activeTabId: browserB.id,
    });

    store.set(closeOtherBrowserTabsAtom, browserA.id);
    expect(store.get(sharedBrowserTabsAtom)).toEqual([browserA]);

    store.set(closeSavedBrowserTabsAtom);
    expect(store.get(sharedBrowserTabsAtom)).toEqual([]);
  });
});
