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
  closeWorkstationTabAtom,
  disposeWorkstationWorkspaceAtom,
  openWorkstationTabAtom,
  removeProjectOrgWorkstationTabsAtom,
  removeSessionWorkstationTabsAtom,
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
  type WorkstationTabRepoAffinity,
  type WorkstationTabsStateV3,
  type WorkstationWorkspaceState,
  closesSharedResourceOnDismiss,
  getWorkstationSharedTabRetention,
  getWorkstationTabOwnership,
  getWorkstationTabRepoAffinity,
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

const REPO_SCOPED_TAB_TYPES = new Set<WorkStationTabType>([
  "file",
  "directory",
  "git-diff",
  "source-control",
  "timeline-diff",
  "git-log",
  "git-commit-detail",
  "git-stash-detail",
  "terminal-content",
  "dom-component-preview",
  "search",
  "lint-scan",
  "github-issue-detail",
  "github-pr-detail",
]);

const EXPECTED_REPO_AFFINITY = Object.fromEntries(
  Object.keys(EXPECTED_OWNERSHIP).map((type) => [
    type,
    REPO_SCOPED_TAB_TYPES.has(type as WorkStationTabType)
      ? "repo-scoped"
      : "repo-independent",
  ])
) as Record<WorkStationTabType, WorkstationTabRepoAffinity>;

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
    expect(closesSharedResourceOnDismiss("browser-session")).toBe(true);
    expect(closesSharedResourceOnDismiss("terminal")).toBe(true);
    expect(closesSharedResourceOnDismiss("settings")).toBe(false);
  });

  it("declares retention and repo-switch policy without a negative default", () => {
    expect(getWorkstationSharedTabRetention("browser-session")).toBe(
      "resource-owned"
    );
    expect(getWorkstationSharedTabRetention("terminal")).toBe("resource-owned");
    expect(getWorkstationSharedTabRetention("settings")).toBe(
      "while-referenced"
    );
    expect(getWorkstationSharedTabRetention("file")).toBeNull();

    const affinityResults = Object.entries(EXPECTED_REPO_AFFINITY).map(
      ([type, expected]) =>
        getWorkstationTabRepoAffinity(type as WorkStationTabType) === expected
    );
    expect(affinityResults).toHaveLength(39);
    expect(affinityResults.every(Boolean)).toBe(true);
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

  it("collects ordinary shared presentation after its last workspace ref closes", () => {
    const store = createStore();
    store.set(workstationTabsStateAtom, stateWithWorkspaces());
    const settings = tab("settings:main", "settings");

    store.set(openWorkstationTabAtom, {
      workspace: sessionWorkstationWorkspaceKey("A"),
      tab: settings,
    });
    store.set(closeWorkstationTabAtom, {
      workspace: sessionWorkstationWorkspaceKey("A"),
      tabId: settings.id,
    });

    expect(store.get(workstationTabsStateAtom).shared.tabs).toEqual([]);
  });

  it("stabilizes shared presentation across repeated open and close cycles", () => {
    const store = createStore();
    store.set(workstationTabsStateAtom, stateWithWorkspaces());
    const settings = tab("settings:main", "settings");

    for (let cycle = 0; cycle < 25; cycle += 1) {
      store.set(openWorkstationTabAtom, {
        workspace: sessionWorkstationWorkspaceKey("A"),
        tab: settings,
      });
      store.set(closeWorkstationTabAtom, {
        workspace: sessionWorkstationWorkspaceKey("A"),
        tabId: settings.id,
      });
    }

    const state = store.get(workstationTabsStateAtom);
    expect(state.shared.tabs).toEqual([]);
    expect(state.sessionWorkspaces.A.tabOrder).not.toContainEqual({
      partition: "shared",
      tabId: settings.id,
    });
  });

  it("keeps shared presentation until every workspace ref is gone", () => {
    const store = createStore();
    store.set(workstationTabsStateAtom, stateWithWorkspaces());
    const settings = tab("settings:main", "settings");

    for (const sessionId of ["A", "B"]) {
      store.set(openWorkstationTabAtom, {
        workspace: sessionWorkstationWorkspaceKey(sessionId),
        tab: settings,
      });
    }
    store.set(closeWorkstationTabAtom, {
      workspace: sessionWorkstationWorkspaceKey("A"),
      tabId: settings.id,
    });
    expect(store.get(workstationTabsStateAtom).shared.tabs).toEqual([settings]);

    store.set(closeWorkstationTabAtom, {
      workspace: sessionWorkstationWorkspaceKey("B"),
      tabId: settings.id,
    });
    expect(store.get(workstationTabsStateAtom).shared.tabs).toEqual([]);
  });

  it("keeps a resource-owned browser tab when its workspace is disposed", () => {
    const store = createStore();
    store.set(workstationTabsStateAtom, stateWithWorkspaces());
    const browser = tab("browser:one", "browser-session", {
      sessionId: "one",
    });

    store.set(openWorkstationTabAtom, {
      workspace: sessionWorkstationWorkspaceKey("A"),
      tab: browser,
    });
    store.set(disposeWorkstationWorkspaceAtom, "A");

    expect(store.get(workstationTabsStateAtom).shared.tabs).toEqual([browser]);
  });

  it("collects shared presentation when its owning workspace is disposed", () => {
    const store = createStore();
    store.set(workstationTabsStateAtom, stateWithWorkspaces());
    const settings = tab("settings:main", "settings");
    store.set(openWorkstationTabAtom, {
      workspace: sessionWorkstationWorkspaceKey("A"),
      tab: settings,
    });

    store.set(disposeWorkstationWorkspaceAtom, "A");

    expect(store.get(workstationTabsStateAtom).shared.tabs).toEqual([]);
  });

  it("invalidates session and org projections across every workspace", () => {
    const store = createStore();
    const state = emptyWorkstationTabsState();
    const deletedSession = tab("chat-session:deleted", "chat-session", {
      sessionId: "deleted",
    });
    const liveSession = tab("chat-session:live", "chat-session", {
      sessionId: "live",
    });
    const deletedOrg = tab("project-org:deleted", "project-org", {
      orgId: "org-deleted",
    });
    const liveOrg = tab("project-org:live", "project-org", {
      orgId: "org-live",
    });
    state.shared.tabs = [deletedSession, liveSession, deletedOrg, liveOrg];
    state.sessionWorkspaces.A = {
      tabs: [
        tab("canvas-preview:deleted", "canvas-preview", {
          sessionId: "deleted",
        }),
      ],
      activeTabRef: { partition: "shared", tabId: deletedSession.id },
      tabOrder: [
        { partition: "shared", tabId: deletedSession.id },
        { partition: "shared", tabId: deletedOrg.id },
        { partition: "workspace", tabId: "canvas-preview:deleted" },
      ],
    };
    state.sessionWorkspaces.B = {
      tabs: [],
      activeTabRef: { partition: "shared", tabId: liveSession.id },
      tabOrder: [
        { partition: "shared", tabId: deletedSession.id },
        { partition: "shared", tabId: liveSession.id },
        { partition: "shared", tabId: deletedOrg.id },
        { partition: "shared", tabId: liveOrg.id },
      ],
    };
    store.set(workstationTabsStateAtom, state);

    store.set(removeSessionWorkstationTabsAtom, "deleted");
    store.set(removeProjectOrgWorkstationTabsAtom, "org-deleted");

    const next = store.get(workstationTabsStateAtom);
    expect(next.shared.tabs.map((item) => item.id)).toEqual([
      liveSession.id,
      liveOrg.id,
    ]);
    expect(next.sessionWorkspaces.A.tabs).toEqual([]);
    for (const current of Object.values(next.sessionWorkspaces)) {
      expect(current.tabOrder.map((ref) => ref.tabId)).not.toContain(
        deletedSession.id
      );
      expect(current.tabOrder.map((ref) => ref.tabId)).not.toContain(
        deletedOrg.id
      );
    }
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
