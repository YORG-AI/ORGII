import { beforeEach, describe, expect, it, vi } from "vitest";

import { selectWorkstationPanel } from "../atoms";
import {
  LAYOUT_STORAGE_KEY,
  WORKSTATION_V3_GLOBAL_KEY,
  WORKSTATION_V3_LEGACY_SEED_KEY,
  WORKSTATION_V3_MANIFEST_KEY,
  WORKSTATION_V3_SHARED_KEY,
  deletePersistedWorkstationWorkspace,
  emptyWorkstationTabsState,
  loadWorkstationTabsState,
  persistWorkstationTabsState,
  sanitizeWorkspaceState,
  workstationWorkspaceId,
} from "../storage";
import type {
  WorkStationTab,
  WorkStationTabType,
  WorkstationWorkspaceState,
} from "../types";

const SESSION_PREFIX = "workstation:tabs:v3:session:";

function tab(
  id: string,
  type: WorkStationTabType = "file",
  overrides: Partial<WorkStationTab> = {}
): WorkStationTab {
  return {
    id,
    type,
    title: id,
    data: {},
    ...overrides,
  };
}

function workspace(
  tabs: WorkStationTab[],
  activeTabId: string | null = tabs[0]?.id ?? null
): WorkstationWorkspaceState {
  return {
    tabs,
    activeTabRef: activeTabId
      ? { partition: "workspace", tabId: activeTabId }
      : null,
    tabOrder: tabs.map((item) => ({
      partition: "workspace" as const,
      tabId: item.id,
    })),
  };
}

function sessionKey(sessionId: string): string {
  return `${SESSION_PREFIX}${encodeURIComponent(sessionId)}`;
}

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("sanitizeWorkspaceState", () => {
  it("keeps the first duplicate tab, drops shared tabs, and repairs dirty state", () => {
    const result = sanitizeWorkspaceState({
      tabs: [
        tab("file:/first.ts", "file", { hasUnsavedChanges: true }),
        tab("file:/first.ts", "file", { title: "duplicate" }),
        tab("project-settings:main", "project-settings"),
        { id: "missing-data", type: "file", title: "invalid" },
      ],
      activeTabRef: { partition: "workspace", tabId: "file:/first.ts" },
      tabOrder: [
        { partition: "workspace", tabId: "file:/first.ts" },
        { partition: "workspace", tabId: "file:/first.ts" },
        { partition: "workspace", tabId: "missing" },
        { partition: "shared", tabId: "project-settings:main" },
      ],
    });

    expect(result.tabs).toEqual([
      tab("file:/first.ts", "file", { hasUnsavedChanges: false }),
    ]);
    expect(result.tabOrder).toEqual([
      { partition: "workspace", tabId: "file:/first.ts" },
      { partition: "shared", tabId: "project-settings:main" },
    ]);
    expect(result.activeTabRef).toEqual({
      partition: "workspace",
      tabId: "file:/first.ts",
    });
  });

  it("nulls an orphaned local active ref and appends omitted valid tabs to order", () => {
    const result = sanitizeWorkspaceState({
      tabs: [tab("file:/a.ts"), tab("file:/b.ts")],
      activeTabRef: { partition: "workspace", tabId: "file:/missing.ts" },
      tabOrder: [{ partition: "workspace", tabId: "file:/b.ts" }],
    });

    expect(result.activeTabRef).toBeNull();
    expect(result.tabOrder).toEqual([
      { partition: "workspace", tabId: "file:/b.ts" },
      { partition: "workspace", tabId: "file:/a.ts" },
    ]);
  });

  it("preserves a shared active ref for validation against shared state at projection", () => {
    expect(
      sanitizeWorkspaceState({
        tabs: [],
        activeTabRef: { partition: "shared", tabId: "project-settings:main" },
        tabOrder: [{ partition: "shared", tabId: "project-settings:main" }],
      }).activeTabRef
    ).toEqual({ partition: "shared", tabId: "project-settings:main" });
  });
});

describe("v2 migration", () => {
  it("splits shared resources from workspace-local tabs and leaves local tabs as a seed", () => {
    localStorage.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({
        mainPane: {
          tabs: [
            tab("file:/legacy.ts"),
            tab("project-settings:main", "project-settings"),
            tab("browser:resource", "browser-session", {
              data: { sessionId: "browser-resource" },
            }),
          ],
          activeTabId: "file:/legacy.ts",
        },
      })
    );

    const migrated = loadWorkstationTabsState();

    expect(migrated.shared.tabs.map((item) => item.id)).toEqual([
      "project-settings:main",
      "browser:resource",
    ]);
    expect(migrated.globalWorkspace.tabs).toEqual([]);
    expect(migrated.sessionWorkspaces).toEqual({});
    expect(migrated.legacySeed?.tabs.map((item) => item.id)).toEqual([
      "file:/legacy.ts",
    ]);
    expect(migrated.legacySeed?.activeTabRef).toEqual({
      partition: "workspace",
      tabId: "file:/legacy.ts",
    });
    expect(migrated.legacySeed?.tabOrder).toEqual([
      { partition: "workspace", tabId: "file:/legacy.ts" },
      { partition: "shared", tabId: "project-settings:main" },
      { partition: "shared", tabId: "browser:resource" },
    ]);
    expect(localStorage.getItem(LAYOUT_STORAGE_KEY)).not.toBeNull();
    expect(localStorage.getItem(WORKSTATION_V3_MANIFEST_KEY)).not.toBeNull();
    expect(localStorage.getItem(WORKSTATION_V3_LEGACY_SEED_KEY)).not.toBeNull();
  });

  it("does not expose a seed when v2 contains only shared resources", () => {
    localStorage.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({
        mainPane: {
          tabs: [tab("project-settings:main", "project-settings")],
          activeTabId: "project-settings:main",
        },
      })
    );

    const migrated = loadWorkstationTabsState();

    expect(migrated.shared.tabs).toHaveLength(1);
    expect(migrated.legacySeed).toBeNull();
    expect(localStorage.getItem(LAYOUT_STORAGE_KEY)).toBeNull();
  });

  it("prefers committed v3 state over a leftover v2 recovery source", () => {
    const state = emptyWorkstationTabsState();
    state.globalWorkspace = workspace([tab("file:/v3.ts")]);
    expect(persistWorkstationTabsState(state)).toBe(true);
    localStorage.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({
        mainPane: {
          tabs: [tab("file:/stale-v2.ts")],
          activeTabId: "file:/stale-v2.ts",
        },
      })
    );

    expect(loadWorkstationTabsState().globalWorkspace.tabs).toEqual([
      tab("file:/v3.ts", "file", { hasUnsavedChanges: false }),
    ]);
  });
});

describe("v3 persistence keys", () => {
  it("writes shared/global/session scopes separately and encodes session IDs", () => {
    const state = emptyWorkstationTabsState();
    state.shared.tabs = [tab("project-settings:main", "project-settings")];
    state.globalWorkspace = workspace([tab("file:/global.ts")]);
    state.sessionWorkspaces["agent/a b"] = workspace([tab("file:/agent.ts")]);

    expect(persistWorkstationTabsState(state)).toBe(true);

    expect(
      JSON.parse(localStorage.getItem(WORKSTATION_V3_MANIFEST_KEY)!)
    ).toEqual({ version: 3, sessionIds: ["agent/a b"] });
    expect(
      JSON.parse(localStorage.getItem(WORKSTATION_V3_SHARED_KEY)!)
    ).toEqual(state.shared);
    expect(
      JSON.parse(localStorage.getItem(WORKSTATION_V3_GLOBAL_KEY)!)
    ).toEqual(state.globalWorkspace);
    expect(JSON.parse(localStorage.getItem(sessionKey("agent/a b"))!)).toEqual(
      state.sessionWorkspaces["agent/a b"]
    );
    expect(workstationWorkspaceId({ kind: "global" })).toBe("global");
    expect(
      workstationWorkspaceId({ kind: "session", sessionId: "agent/a b" })
    ).toBe("session:agent/a b");
  });

  it("round-trips independent session workspaces and shared resources", () => {
    const state = emptyWorkstationTabsState();
    state.shared.tabs = [tab("project-settings:main", "project-settings")];
    state.sessionWorkspaces.A = workspace([tab("file:/same.ts")]);
    state.sessionWorkspaces.B = workspace([
      tab("file:/same.ts", "file", {
        data: { owner: "B" },
      }),
    ]);

    expect(persistWorkstationTabsState(state)).toBe(true);
    const loaded = loadWorkstationTabsState();

    expect(loaded.shared.tabs).toEqual([
      tab("project-settings:main", "project-settings", {
        hasUnsavedChanges: false,
      }),
    ]);
    expect(loaded.sessionWorkspaces.A.tabs[0].data).toEqual({});
    expect(loaded.sessionWorkspaces.B.tabs[0].data).toEqual({ owner: "B" });
  });

  it("removes only the requested persisted session workspace", () => {
    localStorage.setItem(sessionKey("A"), "A");
    localStorage.setItem(sessionKey("B"), "B");

    deletePersistedWorkstationWorkspace("A");

    expect(localStorage.getItem(sessionKey("A"))).toBeNull();
    expect(localStorage.getItem(sessionKey("B"))).toBe("B");
  });

  it("does not commit the manifest when a scoped write fails", () => {
    const original = localStorage.setItem.bind(localStorage);
    vi.spyOn(localStorage, "setItem").mockImplementation((key, value) => {
      if (key === WORKSTATION_V3_GLOBAL_KEY) throw new Error("quota");
      original(key, value);
    });

    const state = emptyWorkstationTabsState();
    state.globalWorkspace = workspace([tab("file:/global.ts")]);

    expect(persistWorkstationTabsState(state)).toBe(false);
    expect(localStorage.getItem(WORKSTATION_V3_MANIFEST_KEY)).toBeNull();
  });
});

describe("retired editor settings tabs", () => {
  const retiredTab = {
    id: "settings:main",
    type: "settings",
    category: "settings",
    title: "Settings",
    data: {},
  };

  it("rejects saved settings tabs in every v3 partition and selects a surviving tab", () => {
    const projectSettings = tab("project-settings:main", "project-settings");
    const savedWorkspace = (fileId: string) => ({
      tabs: [retiredTab, tab(fileId)],
      activeTabRef: { partition: "shared", tabId: retiredTab.id },
      tabOrder: [
        { partition: "shared", tabId: retiredTab.id },
        { partition: "workspace", tabId: fileId },
        { partition: "shared", tabId: projectSettings.id },
      ],
    });
    localStorage.setItem(
      WORKSTATION_V3_MANIFEST_KEY,
      JSON.stringify({ version: 3, sessionIds: ["A"] })
    );
    localStorage.setItem(
      WORKSTATION_V3_SHARED_KEY,
      JSON.stringify({ tabs: [retiredTab, projectSettings] })
    );
    localStorage.setItem(
      WORKSTATION_V3_GLOBAL_KEY,
      JSON.stringify(savedWorkspace("file:/global.ts"))
    );
    localStorage.setItem(
      sessionKey("A"),
      JSON.stringify(savedWorkspace("file:/session.ts"))
    );
    localStorage.setItem(
      WORKSTATION_V3_LEGACY_SEED_KEY,
      JSON.stringify(savedWorkspace("file:/seed.ts"))
    );

    const loaded = loadWorkstationTabsState();
    expect(loaded.shared.tabs).toEqual([
      { ...projectSettings, hasUnsavedChanges: false },
    ]);
    expect(loaded.globalWorkspace.tabs.map((item) => item.id)).toEqual([
      "file:/global.ts",
    ]);
    expect(loaded.sessionWorkspaces.A.tabs.map((item) => item.id)).toEqual([
      "file:/session.ts",
    ]);
    expect(loaded.legacySeed?.tabs.map((item) => item.id)).toEqual([
      "file:/seed.ts",
    ]);
    expect(selectWorkstationPanel(loaded, { kind: "global" })).toEqual({
      tabs: [
        tab("file:/global.ts", "file", { hasUnsavedChanges: false }),
        { ...projectSettings, hasUnsavedChanges: false },
      ],
      activeTabId: "file:/global.ts",
    });
    expect(
      selectWorkstationPanel(loaded, { kind: "session", sessionId: "A" })
        .activeTabId
    ).toBe("file:/session.ts");
    expect(persistWorkstationTabsState(loaded)).toBe(true);
    expect(loadWorkstationTabsState()).toEqual(loaded);
  });

  it("rejects retired settings during v2 recovery without dropping valid tabs", () => {
    localStorage.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({
        mainPane: {
          tabs: [
            retiredTab,
            tab("file:/kept.ts"),
            tab("project-settings:main", "project-settings"),
          ],
          activeTabId: retiredTab.id,
        },
      })
    );

    const loaded = loadWorkstationTabsState();
    expect(loaded.shared.tabs.map((item) => item.type)).toEqual([
      "project-settings",
    ]);
    expect(loaded.legacySeed?.tabs.map((item) => item.id)).toEqual([
      "file:/kept.ts",
    ]);
    expect(loaded.legacySeed?.activeTabRef).toBeNull();
    expect(loaded.legacySeed?.tabOrder.map((ref) => ref.tabId)).toEqual([
      "file:/kept.ts",
      "project-settings:main",
    ]);
    expect(loadWorkstationTabsState()).toEqual(loaded);
  });
});
