import { atom } from "jotai";

import { workstationActiveSessionIdAtom } from "@src/store/session/viewAtom";
import { clearTerminalTargetForWorkspaceAtom } from "@src/store/workstation/codeEditor/terminalTargetAtom";

import {
  deletePersistedWorkstationWorkspace,
  loadWorkstationTabsState,
  persistWorkstationTabsState,
} from "./storage";
import {
  closeTab as closeTabMutation,
  openTab as openTabMutation,
  reorderTabs as reorderTabsMutation,
  switchTab as switchTabMutation,
  updateTabData as updateTabDataMutation,
} from "./tabMutations";
import {
  type PanelState,
  type WorkStationLayoutState,
  type WorkStationTab,
  type WorkstationTabRef,
  type WorkstationTabsStateV3,
  type WorkstationWorkspaceKey,
  type WorkstationWorkspaceState,
  closesSharedResourceOnDismiss,
  getWorkstationTabOwnership,
} from "./types";

const EMPTY_PANEL: PanelState = { tabs: [], activeTabId: null };
const EMPTY_WORKSPACE: WorkstationWorkspaceState = {
  tabs: [],
  activeTabRef: null,
  tabOrder: [],
};

export const GLOBAL_WORKSTATION_WORKSPACE_KEY: WorkstationWorkspaceKey = {
  kind: "global",
};

export function sessionWorkstationWorkspaceKey(
  sessionId: string
): WorkstationWorkspaceKey {
  return { kind: "session", sessionId };
}

export const presentedWorkstationWorkspaceKeyAtom =
  atom<WorkstationWorkspaceKey>((get) => {
    const sessionId = get(workstationActiveSessionIdAtom);
    return sessionId
      ? sessionWorkstationWorkspaceKey(sessionId)
      : GLOBAL_WORKSTATION_WORKSPACE_KEY;
  });
presentedWorkstationWorkspaceKeyAtom.debugLabel =
  "presentedWorkstationWorkspaceKeyAtom";

/** Canonical persisted state. Feature code writes through scoped actions below. */
export const workstationTabsStateAtom = atom<WorkstationTabsStateV3>(
  loadWorkstationTabsState()
);
workstationTabsStateAtom.debugLabel = "workstationTabsStateAtom";

function workspaceFor(
  state: WorkstationTabsStateV3,
  key: WorkstationWorkspaceKey
): WorkstationWorkspaceState {
  if (key.kind === "global") return state.globalWorkspace;
  return state.sessionWorkspaces[key.sessionId] ?? EMPTY_WORKSPACE;
}

function refIdentity(ref: WorkstationTabRef): string {
  return `${ref.partition}:${ref.tabId}`;
}

function composePanel(
  state: WorkstationTabsStateV3,
  key: WorkstationWorkspaceKey
): PanelState {
  const workspace = workspaceFor(state, key);
  const sharedById = new Map(state.shared.tabs.map((tab) => [tab.id, tab]));
  const localById = new Map(workspace.tabs.map((tab) => [tab.id, tab]));
  const tabs: WorkStationTab[] = [];
  const seen = new Set<string>();

  for (const ref of workspace.tabOrder) {
    const tab =
      ref.partition === "shared"
        ? sharedById.get(ref.tabId)
        : localById.get(ref.tabId);
    if (!tab) continue;
    const identity = refIdentity(ref);
    if (seen.has(identity)) continue;
    seen.add(identity);
    tabs.push(tab);
  }
  for (const tab of workspace.tabs) {
    const identity = `workspace:${tab.id}`;
    if (!seen.has(identity)) {
      seen.add(identity);
      tabs.push(tab);
    }
  }

  const activeRef = workspace.activeTabRef;
  const activeExists = activeRef
    ? activeRef.partition === "shared"
      ? sharedById.has(activeRef.tabId)
      : localById.has(activeRef.tabId)
    : false;
  return {
    tabs,
    activeTabId: activeExists
      ? (activeRef?.tabId ?? null)
      : (tabs[0]?.id ?? null),
  };
}

function splitPanel(
  previous: WorkstationTabsStateV3,
  key: WorkstationWorkspaceKey,
  panel: PanelState
): WorkstationTabsStateV3 {
  const sharedTabs: WorkStationTab[] = [];
  const localTabs: WorkStationTab[] = [];
  const tabOrder: WorkstationTabRef[] = [];
  for (const tab of panel.tabs) {
    const partition =
      getWorkstationTabOwnership(tab.type) === "shared-resource"
        ? "shared"
        : "workspace";
    tabOrder.push({ partition, tabId: tab.id });
    if (partition === "shared") sharedTabs.push(tab);
    else localTabs.push(tab);
  }
  const activeTab = panel.tabs.find((tab) => tab.id === panel.activeTabId);
  const activeTabRef: WorkstationTabRef | null = activeTab
    ? {
        partition:
          getWorkstationTabOwnership(activeTab.type) === "shared-resource"
            ? "shared"
            : "workspace",
        tabId: activeTab.id,
      }
    : null;
  const sharedById = new Map(previous.shared.tabs.map((tab) => [tab.id, tab]));
  for (const tab of sharedTabs) sharedById.set(tab.id, tab);
  const nextSharedTabs = [...sharedById.values()];
  const nextWorkspace: WorkstationWorkspaceState = {
    tabs: localTabs,
    activeTabRef,
    tabOrder,
  };
  return key.kind === "global"
    ? {
        ...previous,
        shared: { tabs: nextSharedTabs },
        globalWorkspace: nextWorkspace,
      }
    : {
        ...previous,
        shared: { tabs: nextSharedTabs },
        sessionWorkspaces: {
          ...previous.sessionWorkspaces,
          [key.sessionId]: nextWorkspace,
        },
      };
}

function setAndPersist(
  set: (
    atom: typeof workstationTabsStateAtom,
    value: WorkstationTabsStateV3
  ) => void,
  next: WorkstationTabsStateV3
): void {
  set(workstationTabsStateAtom, next);
  persistWorkstationTabsState(next);
}

/**
 * Compatibility projection for existing pane consumers. Although callers see
 * `mainPane`, reads and writes are routed through the presented workspace and
 * the shared resource partition.
 */
export const workstationLayoutAtom = atom<
  WorkStationLayoutState,
  [
    | WorkStationLayoutState
    | ((previous: WorkStationLayoutState) => WorkStationLayoutState),
  ],
  void
>(
  (get) => ({
    mainPane: composePanel(
      get(workstationTabsStateAtom),
      get(presentedWorkstationWorkspaceKeyAtom)
    ),
  }),
  (get, set, nextOrUpdater) => {
    const state = get(workstationTabsStateAtom);
    const key = get(presentedWorkstationWorkspaceKeyAtom);
    const previousLayout = { mainPane: composePanel(state, key) };
    const nextLayout =
      typeof nextOrUpdater === "function"
        ? nextOrUpdater(previousLayout)
        : nextOrUpdater;
    setAndPersist(
      set,
      splitPanel(state, key, nextLayout.mainPane ?? EMPTY_PANEL)
    );
  }
);
workstationLayoutAtom.debugLabel = "workstationLayoutAtom";

export const claimLegacyWorkstationSeedAtom = atom(null, (get, set) => {
  const key = get(presentedWorkstationWorkspaceKeyAtom);
  if (key.kind !== "session") return;
  const state = get(workstationTabsStateAtom);
  if (!state.legacySeed || state.sessionWorkspaces[key.sessionId]) return;
  const next: WorkstationTabsStateV3 = {
    ...state,
    sessionWorkspaces: {
      ...state.sessionWorkspaces,
      [key.sessionId]: state.legacySeed,
    },
    legacySeed: null,
  };
  setAndPersist(set, next);
});
claimLegacyWorkstationSeedAtom.debugLabel = "claimLegacyWorkstationSeedAtom";

export const disposeWorkstationWorkspaceAtom = atom(
  null,
  (get, set, sessionId: string) => {
    const state = get(workstationTabsStateAtom);
    // Always remove the physical key: a stale key may survive a prior crash
    // even when the manifest/in-memory registry no longer references it.
    deletePersistedWorkstationWorkspace(sessionId);
    set(clearTerminalTargetForWorkspaceAtom, sessionId);
    if (!state.sessionWorkspaces[sessionId]) return;
    const sessionWorkspaces = { ...state.sessionWorkspaces };
    delete sessionWorkspaces[sessionId];
    setAndPersist(set, { ...state, sessionWorkspaces });
  }
);
disposeWorkstationWorkspaceAtom.debugLabel = "disposeWorkstationWorkspaceAtom";

export const workstationWorkspaceStateAtom = atom((get) =>
  workspaceFor(
    get(workstationTabsStateAtom),
    get(presentedWorkstationWorkspaceKeyAtom)
  )
);
workstationWorkspaceStateAtom.debugLabel = "workstationWorkspaceStateAtom";

export interface ScopedWorkstationTabRequest {
  workspace: WorkstationWorkspaceKey;
  tab: WorkStationTab;
}

export interface CloseWorkstationTabsRequest {
  workspace: WorkstationWorkspaceKey;
  tabIds: readonly string[];
  /** Preserve bulk-close selection semantics when the active tab is removed. */
  activeTabId?: string | null;
}

function updateScopedPanel(
  state: WorkstationTabsStateV3,
  workspace: WorkstationWorkspaceKey,
  updater: (panel: PanelState) => PanelState
): WorkstationTabsStateV3 {
  return splitPanel(state, workspace, updater(composePanel(state, workspace)));
}

/** Canonical explicit-workspace opener for imperative and delayed actions. */
export const openWorkstationTabAtom = atom(
  null,
  (get, set, request: ScopedWorkstationTabRequest) => {
    const state = get(workstationTabsStateAtom);
    setAndPersist(
      set,
      updateScopedPanel(state, request.workspace, (panel) =>
        openTabMutation(panel, request.tab)
      )
    );
  }
);
openWorkstationTabAtom.debugLabel = "openWorkstationTabAtom";

function removeSharedTabsFromState(
  state: WorkstationTabsStateV3,
  tabIds: ReadonlySet<string>
): WorkstationTabsStateV3 {
  if (
    tabIds.size === 0 ||
    !state.shared.tabs.some((tab) => tabIds.has(tab.id))
  ) {
    return state;
  }

  const removeRefs = (
    workspace: WorkstationWorkspaceState
  ): WorkstationWorkspaceState => {
    const tabOrder = workspace.tabOrder.filter(
      (ref) => !(ref.partition === "shared" && tabIds.has(ref.tabId))
    );
    const activeTabRef =
      workspace.activeTabRef?.partition === "shared" &&
      tabIds.has(workspace.activeTabRef.tabId)
        ? (tabOrder[0] ?? null)
        : workspace.activeTabRef;
    return { ...workspace, activeTabRef, tabOrder };
  };

  return {
    ...state,
    shared: {
      tabs: state.shared.tabs.filter((tab) => !tabIds.has(tab.id)),
    },
    globalWorkspace: removeRefs(state.globalWorkspace),
    sessionWorkspaces: Object.fromEntries(
      Object.entries(state.sessionWorkspaces).map(([sessionId, workspace]) => [
        sessionId,
        removeRefs(workspace),
      ])
    ),
  };
}

/**
 * Canonical explicit-close path. Workspace-local and lightweight shared tabs
 * are removed only from the requested workspace. Live Browser/Terminal tabs
 * also lose their global resource record, which drives owner teardown.
 */
export const closeWorkstationTabsAtom = atom(
  null,
  (get, set, request: CloseWorkstationTabsRequest) => {
    const state = get(workstationTabsStateAtom);
    const panel = composePanel(state, request.workspace);
    const requestedIds = new Set(request.tabIds);
    const tabsToClose = panel.tabs.filter((tab) => requestedIds.has(tab.id));
    if (tabsToClose.length === 0) return;

    let nextPanel = panel;
    for (const tab of tabsToClose) {
      nextPanel = closeTabMutation(nextPanel, tab.id);
    }
    if (request.activeTabId !== undefined) {
      const requestedActiveExists = nextPanel.tabs.some(
        (tab) => tab.id === request.activeTabId
      );
      nextPanel = {
        ...nextPanel,
        activeTabId: requestedActiveExists ? request.activeTabId : null,
      };
    }

    const resourceIds = new Set(
      tabsToClose
        .filter((tab) => closesSharedResourceOnDismiss(tab.type))
        .map((tab) => tab.id)
    );

    const nextState = removeSharedTabsFromState(
      splitPanel(state, request.workspace, nextPanel),
      resourceIds
    );
    setAndPersist(set, nextState);
  }
);
closeWorkstationTabsAtom.debugLabel = "closeWorkstationTabsAtom";

export const closeWorkstationTabAtom = atom(
  null,
  (
    _get,
    set,
    request: { workspace: WorkstationWorkspaceKey; tabId: string }
  ) => {
    set(closeWorkstationTabsAtom, {
      workspace: request.workspace,
      tabIds: [request.tabId],
    });
  }
);
closeWorkstationTabAtom.debugLabel = "closeWorkstationTabAtom";

/**
 * Tear down a global resource rather than merely hiding it from one workspace.
 * Resource owners (Browser/Terminal) use this after their durable resource is
 * explicitly closed.
 */
export const removeSharedWorkstationTabAtom = atom(
  null,
  (_get, set, tabId: string) => {
    set(removeSharedWorkstationTabsAtom, [tabId]);
  }
);
removeSharedWorkstationTabAtom.debugLabel = "removeSharedWorkstationTabAtom";

/** Remove multiple shared resources and every workspace reference in one write. */
export const removeSharedWorkstationTabsAtom = atom(
  null,
  (get, set, tabIds: readonly string[]) => {
    const state = get(workstationTabsStateAtom);
    const next = removeSharedTabsFromState(state, new Set(tabIds));
    if (next === state) return;
    setAndPersist(set, next);
  }
);
removeSharedWorkstationTabsAtom.debugLabel = "removeSharedWorkstationTabsAtom";

export const focusWorkstationTabAtom = atom(
  null,
  (
    get,
    set,
    request: { workspace: WorkstationWorkspaceKey; tabId: string }
  ) => {
    const state = get(workstationTabsStateAtom);
    setAndPersist(
      set,
      updateScopedPanel(state, request.workspace, (panel) =>
        switchTabMutation(panel, request.tabId)
      )
    );
  }
);
focusWorkstationTabAtom.debugLabel = "focusWorkstationTabAtom";

export const updateWorkstationTabDataAtom = atom(
  null,
  (
    get,
    set,
    request: {
      workspace: WorkstationWorkspaceKey;
      tabId: string;
      data: Partial<Record<string, unknown>>;
    }
  ) => {
    const state = get(workstationTabsStateAtom);
    setAndPersist(
      set,
      updateScopedPanel(state, request.workspace, (panel) =>
        updateTabDataMutation(panel, request.tabId, request.data)
      )
    );
  }
);
updateWorkstationTabDataAtom.debugLabel = "updateWorkstationTabDataAtom";

export const reorderWorkstationTabsAtom = atom(
  null,
  (
    get,
    set,
    request: {
      workspace: WorkstationWorkspaceKey;
      startIndex: number;
      endIndex: number;
    }
  ) => {
    const state = get(workstationTabsStateAtom);
    setAndPersist(
      set,
      updateScopedPanel(state, request.workspace, (panel) =>
        reorderTabsMutation(panel, request.startIndex, request.endIndex)
      )
    );
  }
);
reorderWorkstationTabsAtom.debugLabel = "reorderWorkstationTabsAtom";

export const mainPaneStateAtom = atom(
  (get) => get(workstationLayoutAtom)?.mainPane ?? EMPTY_PANEL
);
mainPaneStateAtom.debugLabel = "mainPaneStateAtom";

export const mainPaneTabsAtom = atom((get) => get(mainPaneStateAtom).tabs);
mainPaneTabsAtom.debugLabel = "mainPaneTabsAtom";

export const mainPaneActiveTabIdAtom = atom(
  (get) => get(mainPaneStateAtom).activeTabId
);
mainPaneActiveTabIdAtom.debugLabel = "mainPaneActiveTabIdAtom";

export const activeWorkStationTabAtom = atom((get) => {
  const tabs = get(mainPaneTabsAtom);
  const activeTabId = get(mainPaneActiveTabIdAtom);
  return tabs.find((tab) => tab.id === activeTabId) ?? null;
});
activeWorkStationTabAtom.debugLabel = "activeWorkStationTabAtom";

export const tabScrollRevealAtom = atom<{ tabId: string; version: number }>({
  tabId: "",
  version: 0,
});
tabScrollRevealAtom.debugLabel = "tabScrollRevealAtom";

export const requestTabScrollRevealAtom = atom(
  null,
  (get, set, tabId: string) => {
    const prev = get(tabScrollRevealAtom);
    set(tabScrollRevealAtom, { tabId, version: prev.version + 1 });
  }
);
requestTabScrollRevealAtom.debugLabel = "requestTabScrollRevealAtom";

export const activeWorkStationFilePathAtom = atom((get) => {
  const activeTab = get(activeWorkStationTabAtom);
  if (!activeTab) return null;
  if (activeTab.type === "file" && activeTab.data.filePath) {
    return activeTab.data.filePath as string;
  }
  if (activeTab.type === "git-diff" && activeTab.data.filePath) {
    return activeTab.data.filePath as string;
  }
  return null;
});
activeWorkStationFilePathAtom.debugLabel = "activeWorkStationFilePathAtom";

export const openEditorFilePathsAtom = (() => {
  let prevTabs: PanelState["tabs"] = [];
  let prevPaths: string[] = [];

  return atom<string[]>((get) => {
    const tabs = get(mainPaneTabsAtom);
    if (tabs === prevTabs) return prevPaths;

    const filePaths = new Set<string>();
    for (const tab of tabs) {
      if (tab.type === "file" || tab.type === "git-diff") {
        const filePath = tab.data.filePath as string | undefined;
        if (filePath) filePaths.add(filePath);
      }
    }

    const nextPaths = Array.from(filePaths).sort();
    if (
      nextPaths.length === prevPaths.length &&
      nextPaths.every((path, index) => path === prevPaths[index])
    ) {
      prevTabs = tabs;
      return prevPaths;
    }

    prevTabs = tabs;
    prevPaths = nextPaths;
    return prevPaths;
  });
})();
openEditorFilePathsAtom.debugLabel = "openEditorFilePathsAtom";

/** Read a workspace without changing the presented WorkStation selection. */
export function selectWorkstationPanel(
  state: WorkstationTabsStateV3,
  key: WorkstationWorkspaceKey
): PanelState {
  return composePanel(state, key);
}
