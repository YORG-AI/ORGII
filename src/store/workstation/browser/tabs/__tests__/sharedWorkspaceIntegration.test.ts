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
  createBrowserSessionTab,
  createTokenCategoryTab,
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
  it("projects the same browser resources after switching agent workspaces", () => {
    const store = createStore();
    const state = emptyWorkstationTabsState();
    const browserTab = createBrowserSessionTab("browser-1", "Example", {
      url: "https://example.com",
    });
    state.shared.tabs = [browserTab];
    state.sessionWorkspaces.A = localWorkspace("file:/a.ts");
    state.sessionWorkspaces.B = localWorkspace("file:/b.ts");
    store.set(workstationTabsStateAtom, state);

    store.set(workstationActiveSessionIdAtom, "A");
    expect(store.get(browserTabsAtom).tabs).toEqual([browserTab]);

    store.set(workstationActiveSessionIdAtom, "B");
    expect(store.get(browserTabsAtom).tabs).toEqual([browserTab]);
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
    const tokenTab = createTokenCategoryTab("colors");
    store.set(browserTabsAtom, {
      tabs: [browserTab, tokenTab],
      activeTabId: browserTab.id,
    });

    const next = store.get(workstationTabsStateAtom);
    expect(next.shared.tabs).toEqual([browserTab, tokenTab]);
    expect(next.sessionWorkspaces.A.tabs[0]?.id).toBe("file:/a.ts");
    expect(next.sessionWorkspaces.B.tabs[0]?.id).toBe("file:/b.ts");
    expect(next.sessionWorkspaces.A.activeTabRef).toEqual({
      partition: "shared",
      tabId: browserTab.id,
    });
  });

  it("removes a browser resource only on an explicit browser slice write", () => {
    const store = createStore();
    const state = emptyWorkstationTabsState();
    const browserTab = createBrowserSessionTab("browser-1", "Example", {
      url: "https://example.com",
    });
    state.shared.tabs = [browserTab];
    state.sessionWorkspaces.A = localWorkspace("file:/a.ts");
    state.sessionWorkspaces.B = localWorkspace("file:/b.ts");
    store.set(workstationTabsStateAtom, state);

    store.set(workstationActiveSessionIdAtom, "A");
    store.set(workstationActiveSessionIdAtom, "B");
    expect(store.get(workstationTabsStateAtom).shared.tabs).toEqual([
      browserTab,
    ]);

    store.set(browserTabsAtom, { tabs: [], activeTabId: null });
    expect(store.get(workstationTabsStateAtom).shared.tabs).toEqual([]);
    expect(
      store.get(workstationTabsStateAtom).sessionWorkspaces.A.tabs[0]?.id
    ).toBe("file:/a.ts");
    expect(
      store.get(workstationTabsStateAtom).sessionWorkspaces.B.tabs[0]?.id
    ).toBe("file:/b.ts");
  });
});
