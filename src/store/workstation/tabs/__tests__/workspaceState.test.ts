import { createStore } from "jotai/vanilla";
import { beforeEach, describe, expect, it } from "vitest";

import { workstationActiveSessionIdAtom } from "@src/store/session/viewAtom";
import {
  codeEditorTerminalTargetAtom,
  codeEditorTerminalTargetsAtom,
} from "@src/store/workstation/codeEditor/terminalTargetAtom";

import {
  GLOBAL_WORKSTATION_WORKSPACE_KEY,
  claimLegacyWorkstationSeedAtom,
  disposeWorkstationWorkspaceAtom,
  openWorkstationTabAtom,
  removeSharedWorkstationTabAtom,
  selectWorkstationPanel,
  sessionWorkstationWorkspaceKey,
  workstationTabsStateAtom,
} from "../atoms";
import { emptyWorkstationTabsState } from "../storage";
import {
  type WorkStationTab,
  type WorkStationTabType,
  type WorkstationTabOwnership,
  type WorkstationTabsStateV3,
  type WorkstationWorkspaceState,
  getWorkstationTabOwnership,
} from "../types";

const EXPECTED_OWNERSHIP: Record<WorkStationTabType, WorkstationTabOwnership> =
  {
    file: "workspace-local",
    directory: "workspace-local",
    explorer: "workspace-local",
    "git-diff": "workspace-local",
    "source-control": "workspace-local",
    "timeline-diff": "workspace-local",
    "git-log": "workspace-local",
    "git-commit-detail": "workspace-local",
    "git-stash-detail": "workspace-local",
    "terminal-content": "workspace-local",
    "dom-component-preview": "workspace-local",
    terminal: "shared-resource",
    output: "workspace-local",
    settings: "shared-resource",
    search: "workspace-local",
    "lint-scan": "workspace-local",
    "ai-impact": "workspace-local",
    "search-sessions": "workspace-local",
    benchmark: "shared-resource",
    "url-preview": "workspace-local",
    "browser-session": "shared-resource",
    devtools: "shared-resource",
    "project-dashboard": "shared-resource",
    "project-work-items": "shared-resource",
    "project-linear-projects": "shared-resource",
    "project-linear-work-items": "shared-resource",
    "project-settings": "shared-resource",
    "project-org": "shared-resource",
    "project-org-settings": "shared-resource",
    "project-git-sync-review": "shared-resource",
    "project-workitems": "shared-resource",
    "workItem-detail": "shared-resource",
    "chat-session": "shared-resource",
    "subagent-detail": "workspace-local",
    "agent-config": "shared-resource",
    "canvas-preview": "workspace-local",
    "github-issue-detail": "workspace-local",
    "github-pr-detail": "workspace-local",
    start: "shared-resource",
  };

function tab(
  id: string,
  type: WorkStationTabType = "file",
  data: Record<string, unknown> = {}
): WorkStationTab {
  return { id, type, title: id, data };
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

function stateWithWorkspaces(): WorkstationTabsStateV3 {
  const state = emptyWorkstationTabsState();
  state.globalWorkspace = workspace([tab("file:/global.ts")]);
  state.sessionWorkspaces = {
    A: workspace([tab("file:/same.ts"), tab("file:/a.ts")], "file:/a.ts"),
    B: workspace([tab("file:/same.ts"), tab("file:/b.ts")], "file:/b.ts"),
  };
  return state;
}

beforeEach(() => {
  localStorage.clear();
});

describe("WorkStation tab ownership policy", () => {
  it("classifies every current WorkStationTabType explicitly", () => {
    const results = Object.entries(EXPECTED_OWNERSHIP).map(
      ([type, ownership]) => ({
        type,
        expected: ownership,
        actual: getWorkstationTabOwnership(type as WorkStationTabType),
      })
    );

    expect(results).toHaveLength(39);
    expect(results.every(({ actual, expected }) => actual === expected)).toBe(
      true
    );
  });

  it("does not confuse browser and terminal resource session IDs with workspace ownership", () => {
    expect(getWorkstationTabOwnership("browser-session")).toBe(
      "shared-resource"
    );
    expect(getWorkstationTabOwnership("terminal")).toBe("shared-resource");
    expect(getWorkstationTabOwnership("terminal-content")).toBe(
      "workspace-local"
    );
  });
});

describe("workspace projection and isolation", () => {
  it("keeps A, B, and Global local tabs and active selections isolated", () => {
    const state = stateWithWorkspaces();

    expect(
      selectWorkstationPanel(state, GLOBAL_WORKSTATION_WORKSPACE_KEY)
    ).toEqual({
      tabs: [tab("file:/global.ts")],
      activeTabId: "file:/global.ts",
    });
    expect(
      selectWorkstationPanel(state, sessionWorkstationWorkspaceKey("A"))
    ).toEqual({
      tabs: [tab("file:/same.ts"), tab("file:/a.ts")],
      activeTabId: "file:/a.ts",
    });
    expect(
      selectWorkstationPanel(state, sessionWorkstationWorkspaceKey("B"))
    ).toEqual({
      tabs: [tab("file:/same.ts"), tab("file:/b.ts")],
      activeTabId: "file:/b.ts",
    });
  });

  it("allows the same local tab ID to exist independently in A and B", () => {
    const state = stateWithWorkspaces();
    state.sessionWorkspaces.A.tabs[0].data = { owner: "A" };
    state.sessionWorkspaces.B.tabs[0].data = { owner: "B" };

    const panelA = selectWorkstationPanel(
      state,
      sessionWorkstationWorkspaceKey("A")
    );
    const panelB = selectWorkstationPanel(
      state,
      sessionWorkstationWorkspaceKey("B")
    );

    expect(
      panelA.tabs.find((item) => item.id === "file:/same.ts")?.data
    ).toEqual({ owner: "A" });
    expect(
      panelB.tabs.find((item) => item.id === "file:/same.ts")?.data
    ).toEqual({ owner: "B" });
  });

  it("stores one shared resource copy while each workspace remembers its own selection", () => {
    const store = createStore();
    store.set(workstationTabsStateAtom, stateWithWorkspaces());
    const settings = tab("settings:main", "settings");

    store.set(openWorkstationTabAtom, {
      workspace: sessionWorkstationWorkspaceKey("A"),
      tab: settings,
    });
    store.set(openWorkstationTabAtom, {
      workspace: sessionWorkstationWorkspaceKey("B"),
      tab: tab("file:/b-active.ts"),
    });

    const state = store.get(workstationTabsStateAtom);
    expect(state.shared.tabs).toEqual([settings]);
    expect(state.sessionWorkspaces.A.tabs).not.toContainEqual(settings);
    expect(state.sessionWorkspaces.B.tabs).not.toContainEqual(settings);
    expect(state.sessionWorkspaces.A.activeTabRef).toEqual({
      partition: "shared",
      tabId: "settings:main",
    });
    expect(state.sessionWorkspaces.B.activeTabRef).toEqual({
      partition: "workspace",
      tabId: "file:/b-active.ts",
    });
    expect(
      selectWorkstationPanel(state, sessionWorkstationWorkspaceKey("A"))
        .activeTabId
    ).toBe("settings:main");
    expect(
      selectWorkstationPanel(state, sessionWorkstationWorkspaceKey("B"))
        .activeTabId
    ).toBe("file:/b-active.ts");
  });

  it("keeps shared resources hidden until each workspace explicitly opens them", () => {
    const store = createStore();
    store.set(workstationTabsStateAtom, stateWithWorkspaces());
    const settings = tab("settings:main", "settings");

    store.set(openWorkstationTabAtom, {
      workspace: sessionWorkstationWorkspaceKey("A"),
      tab: settings,
    });

    const state = store.get(workstationTabsStateAtom);
    expect(
      selectWorkstationPanel(state, sessionWorkstationWorkspaceKey("A")).tabs
    ).toContainEqual(settings);
    expect(
      selectWorkstationPanel(state, sessionWorkstationWorkspaceKey("B")).tabs
    ).not.toContainEqual(settings);
  });

  it("removes a shared resource and all workspace references explicitly", () => {
    const store = createStore();
    store.set(workstationTabsStateAtom, stateWithWorkspaces());
    const settings = tab("settings:main", "settings");

    for (const sessionId of ["A", "B"]) {
      store.set(openWorkstationTabAtom, {
        workspace: sessionWorkstationWorkspaceKey(sessionId),
        tab: settings,
      });
    }
    store.set(removeSharedWorkstationTabAtom, settings.id);

    const state = store.get(workstationTabsStateAtom);
    expect(state.shared.tabs).toEqual([]);
    expect(state.sessionWorkspaces.A.tabOrder).not.toContainEqual({
      partition: "shared",
      tabId: settings.id,
    });
    expect(state.sessionWorkspaces.B.tabOrder).not.toContainEqual({
      partition: "shared",
      tabId: settings.id,
    });
  });
  it("disposes workspace tabs and its remembered Terminal target together", () => {
    const store = createStore();
    const state = stateWithWorkspaces();
    store.set(workstationTabsStateAtom, state);
    store.set(workstationActiveSessionIdAtom, "A");
    store.set(codeEditorTerminalTargetAtom, {
      kind: "agent",
      sessionId: "agent-A",
    });
    store.set(workstationActiveSessionIdAtom, "B");
    store.set(codeEditorTerminalTargetAtom, {
      kind: "agent",
      sessionId: "agent-B",
    });

    store.set(disposeWorkstationWorkspaceAtom, "A");

    expect(
      store.get(workstationTabsStateAtom).sessionWorkspaces.A
    ).toBeUndefined();
    expect(store.get(codeEditorTerminalTargetsAtom)).toEqual({
      "session:B": { kind: "agent", sessionId: "agent-B" },
    });
  });
});

describe("legacy seed claim", () => {
  it("waits in Global and is claimed only after an explicit session is selected", () => {
    const store = createStore();
    const state = emptyWorkstationTabsState();
    state.legacySeed = workspace([tab("file:/legacy.ts")]);
    store.set(workstationTabsStateAtom, state);

    store.set(claimLegacyWorkstationSeedAtom);
    expect(store.get(workstationTabsStateAtom).legacySeed).not.toBeNull();
    expect(store.get(workstationTabsStateAtom).globalWorkspace.tabs).toEqual(
      []
    );

    store.set(workstationActiveSessionIdAtom, "session-A");
    store.set(claimLegacyWorkstationSeedAtom);

    const claimed = store.get(workstationTabsStateAtom);
    expect(claimed.legacySeed).toBeNull();
    expect(claimed.sessionWorkspaces["session-A"].tabs).toEqual([
      tab("file:/legacy.ts"),
    ]);
    expect(claimed.globalWorkspace.tabs).toEqual([]);
  });

  it("does not overwrite an existing session workspace or consume the seed", () => {
    const store = createStore();
    const state = emptyWorkstationTabsState();
    state.legacySeed = workspace([tab("file:/legacy.ts")]);
    state.sessionWorkspaces.A = workspace([tab("file:/existing.ts")]);
    store.set(workstationTabsStateAtom, state);
    store.set(workstationActiveSessionIdAtom, "A");

    store.set(claimLegacyWorkstationSeedAtom);

    expect(store.get(workstationTabsStateAtom).legacySeed?.tabs).toEqual([
      tab("file:/legacy.ts"),
    ]);
    expect(
      store.get(workstationTabsStateAtom).sessionWorkspaces.A.tabs
    ).toEqual([tab("file:/existing.ts")]);
  });
});
