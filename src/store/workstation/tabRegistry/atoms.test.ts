import { createStore } from "jotai/vanilla";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { workstationActiveSessionIdAtom } from "@src/store/session/viewAtom";
import {
  BROWSER_SESSIONS_STORAGE_KEY,
  browserSessionStateAtom,
  persistBrowserSessionState,
} from "@src/store/workstation/browser/sessionState";
import { createBrowserSessionTab } from "@src/store/workstation/browser/tabs";
import {
  activeTerminalIdAtom,
  initializedTerminalIdsAtom,
  terminalSessionsAtom,
  terminalSurfaceLifecycleAtom,
} from "@src/store/workstation/codeEditor/terminal";
import {
  workstationLayoutAtom,
  workstationTabsStateAtom,
} from "@src/store/workstation/tabs";
import type { WorkStationTab } from "@src/store/workstation/tabs";
import { emptyWorkstationTabsState } from "@src/store/workstation/tabs/storage";
import type { WorkstationWorkspaceState } from "@src/store/workstation/tabs/types";
import type { BrowserSession } from "@src/types/ui/tabs";
import { createInstrumentedStore } from "@src/util/core/state/instrumentedStore";

import {
  closeAllWorkstationTabsAtom,
  closeOtherTabsAtom,
  closeProjectOrgWorkStationTabsAtom,
  closeSavedTabsAtom,
  closeTabAtom,
  tabRegistryAtom,
} from "./atoms";

function tab(id: string, orgId?: string): WorkStationTab {
  return {
    id,
    type: "project-org",
    title: id,
    data: orgId ? { orgId } : {},
  };
}

function fileTab(id: string, hasUnsavedChanges = false): WorkStationTab {
  return {
    id,
    type: "file",
    title: id,
    data: { filePath: id.replace("file:", "") },
    hasUnsavedChanges,
  };
}

function browserSession(id: string): BrowserSession {
  const url = `https://${id}.example.com`;
  return {
    id,
    title: id,
    url,
    history: [url],
    historyIndex: 0,
    historyEntries: [{ url, title: id, visitedAt: 1 }],
    isLoading: false,
    error: null,
    incognito: false,
  };
}

function workspaceWithRefs(
  localTabs: WorkStationTab[],
  sharedTabIds: string[],
  activeTabId: string
): WorkstationWorkspaceState {
  const localIds = new Set(localTabs.map((item) => item.id));
  return {
    tabs: localTabs,
    activeTabRef: {
      partition: localIds.has(activeTabId) ? "workspace" : "shared",
      tabId: activeTabId,
    },
    tabOrder: [
      ...sharedTabIds.map((tabId) => ({
        partition: "shared" as const,
        tabId,
      })),
      ...localTabs.map((item) => ({
        partition: "workspace" as const,
        tabId: item.id,
      })),
    ],
  };
}

function setupBrowserCloseState() {
  const store = createStore();
  const state = emptyWorkstationTabsState();
  const browserTab = createBrowserSessionTab("browser-1", "Example", {
    url: "https://example.com",
  });
  const settingsTab: WorkStationTab = {
    id: "settings:main",
    type: "settings",
    title: "Settings",
    data: {},
  };
  state.shared.tabs = [browserTab, settingsTab];
  state.sessionWorkspaces.A = workspaceWithRefs(
    [fileTab("file:/a.ts", true)],
    [browserTab.id, settingsTab.id],
    browserTab.id
  );
  state.sessionWorkspaces.B = workspaceWithRefs(
    [fileTab("file:/b.ts", true)],
    [browserTab.id, settingsTab.id],
    browserTab.id
  );
  store.set(workstationTabsStateAtom, state);
  store.set(workstationActiveSessionIdAtom, "A");

  const sessionState = {
    sessions: [browserSession("browser-1")],
    activeSessionId: "browser-1",
  };
  store.set(browserSessionStateAtom, sessionState);
  persistBrowserSessionState(sessionState);
  return { store, browserTab, settingsTab };
}

function expectBrowserResourceClosed(
  store: ReturnType<typeof createStore>,
  browserTabId: string
) {
  const state = store.get(workstationTabsStateAtom);
  expect(state.shared.tabs.map((item) => item.id)).not.toContain(browserTabId);
  for (const workspace of Object.values(state.sessionWorkspaces)) {
    expect(workspace.tabOrder.map((ref) => ref.tabId)).not.toContain(
      browserTabId
    );
  }
  expect(store.get(browserSessionStateAtom)).toEqual({
    sessions: [],
    activeSessionId: "",
  });
  expect(localStorage.getItem(BROWSER_SESSIONS_STORAGE_KEY)).toBeNull();
}

beforeEach(() => {
  localStorage.clear();
});

describe("closeProjectOrgWorkStationTabsAtom", () => {
  it("closes every surface for the deleted org and keeps other tabs", () => {
    const store = createInstrumentedStore();
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

  it("invalidates the deleted org across non-presented workspaces", () => {
    const store = createStore();
    const state = emptyWorkstationTabsState();
    const deletedA = tab("deleted-a", "org-deleted");
    const deletedB = tab("deleted-b", "org-deleted");
    const live = tab("live", "org-live");
    state.shared.tabs = [deletedA, deletedB, live];
    state.globalWorkspace = workspaceWithRefs([], [deletedA.id], deletedA.id);
    state.sessionWorkspaces.A = workspaceWithRefs(
      [fileTab("file:/a.ts")],
      [deletedA.id, live.id],
      deletedA.id
    );
    state.sessionWorkspaces.B = workspaceWithRefs(
      [fileTab("file:/b.ts")],
      [deletedB.id, live.id],
      deletedB.id
    );
    state.legacySeed = workspaceWithRefs(
      [],
      [deletedA.id, live.id],
      deletedA.id
    );
    store.set(workstationTabsStateAtom, state);
    store.set(workstationActiveSessionIdAtom, "A");

    store.set(closeProjectOrgWorkStationTabsAtom, "org-deleted");

    const next = store.get(workstationTabsStateAtom);
    expect(next.shared.tabs).toEqual([live]);
    expect(next.globalWorkspace.tabOrder).toEqual([]);
    expect(next.sessionWorkspaces.A.tabOrder.map((ref) => ref.tabId)).toEqual([
      live.id,
      "file:/a.ts",
    ]);
    expect(next.sessionWorkspaces.B.tabOrder.map((ref) => ref.tabId)).toEqual([
      live.id,
      "file:/b.ts",
    ]);
    expect(next.legacySeed?.tabOrder.map((ref) => ref.tabId)).toEqual([
      live.id,
    ]);
  });
});

describe("resource-aware WorkStation close commands", () => {
  it("closes a browser tab at its authoritative session source", () => {
    const { store, browserTab, settingsTab } = setupBrowserCloseState();

    // This is the command used by the visible unified TabBar close button.
    store.set(closeTabAtom, { tabId: browserTab.id });

    expectBrowserResourceClosed(store, browserTab.id);
    expect(store.get(workstationTabsStateAtom).shared.tabs).toContainEqual(
      settingsTab
    );
    expect(store.get(tabRegistryAtom).map((entry) => entry.tab.id)).toEqual([
      settingsTab.id,
      "file:/a.ts",
    ]);

    // Switching workspaces cannot resurrect the removed shared resource.
    store.set(workstationActiveSessionIdAtom, "B");
    expect(store.get(tabRegistryAtom).map((entry) => entry.tab.id)).toEqual([
      settingsTab.id,
      "file:/b.ts",
    ]);
  });

  it("applies the same resource teardown to close-other", () => {
    const { store, browserTab } = setupBrowserCloseState();

    store.set(closeOtherTabsAtom, { keepTabId: "file:/a.ts" });

    expectBrowserResourceClosed(store, browserTab.id);
    expect(store.get(tabRegistryAtom).map((entry) => entry.tab.id)).toEqual([
      "file:/a.ts",
    ]);
  });

  it("applies the same resource teardown to close-saved", () => {
    const { store, browserTab } = setupBrowserCloseState();

    store.set(closeSavedTabsAtom);

    expectBrowserResourceClosed(store, browserTab.id);
    expect(store.get(tabRegistryAtom).map((entry) => entry.tab.id)).toEqual([
      "file:/a.ts",
    ]);
  });

  it("applies the same resource teardown to close-all", () => {
    const { store, browserTab } = setupBrowserCloseState();

    store.set(closeAllWorkstationTabsAtom);

    expectBrowserResourceClosed(store, browserTab.id);
    expect(store.get(tabRegistryAtom)).toEqual([]);
  });

  it("tears down the Terminal owner once and removes every workspace ref", async () => {
    const store = createStore();
    const state = emptyWorkstationTabsState();
    const terminalTab: WorkStationTab = {
      id: "terminal:main",
      type: "terminal",
      title: "Terminal",
      data: { sessionId: "main" },
    };
    state.shared.tabs = [terminalTab];
    state.sessionWorkspaces.A = workspaceWithRefs(
      [fileTab("file:/a.ts")],
      [terminalTab.id],
      terminalTab.id
    );
    state.sessionWorkspaces.B = workspaceWithRefs(
      [fileTab("file:/b.ts")],
      [terminalTab.id],
      terminalTab.id
    );
    store.set(workstationTabsStateAtom, state);
    store.set(workstationActiveSessionIdAtom, "A");
    store.set(terminalSessionsAtom, [
      { id: "shell-old", name: "Shell", isActive: true },
      { id: "chatpanel-live", name: "Chat", isActive: false },
    ]);
    store.set(activeTerminalIdAtom, "shell-old");
    store.set(
      initializedTerminalIdsAtom,
      new Set(["shell-old", "chatpanel-live"])
    );
    store.set(terminalSurfaceLifecycleAtom, {
      generation: 0,
      phase: "open",
    });

    store.set(closeTabAtom, { tabId: terminalTab.id });

    const next = store.get(workstationTabsStateAtom);
    expect(next.shared.tabs).toEqual([]);
    expect(next.sessionWorkspaces.A.tabOrder.map((ref) => ref.tabId)).toEqual([
      "file:/a.ts",
    ]);
    expect(next.sessionWorkspaces.B.tabOrder.map((ref) => ref.tabId)).toEqual([
      "file:/b.ts",
    ]);
    expect(store.get(terminalSessionsAtom).map(({ id }) => id)).toContain(
      "chatpanel-live"
    );
    expect(store.get(terminalSessionsAtom).map(({ id }) => id)).not.toContain(
      "shell-old"
    );

    store.set(workstationActiveSessionIdAtom, "B");
    expect(store.get(tabRegistryAtom).map((entry) => entry.tab.id)).toEqual([
      "file:/b.ts",
    ]);
    await vi.waitFor(() => {
      expect(store.get(terminalSurfaceLifecycleAtom).phase).toBe("closed");
    });
  });
});
