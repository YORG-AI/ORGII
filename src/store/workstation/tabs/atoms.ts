import { atom } from "jotai";

import { workstationActiveSessionIdAtom } from "@src/store/session/viewAtom";

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
  for (const tab of state.shared.tabs) {
    const identity = `shared:${tab.id}`;
    if (!seen.has(identity)) {
      seen.add(identity);
      tabs.push(tab);
    }
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
  const nextWorkspace: WorkstationWorkspaceState = {
    tabs: localTabs,
    activeTabRef,
    tabOrder,
  };
  return key.kind === "global"
    ? {
        ...previous,
        shared: { tabs: sharedTabs },
        globalWorkspace: nextWorkspace,
      }
    : {
        ...previous,
        shared: { tabs: sharedTabs },
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

export const closeWorkstationTabAtom = atom(
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
        closeTabMutation(panel, request.tabId)
      )
    );
  }
);
closeWorkstationTabAtom.debugLabel = "closeWorkstationTabAtom";

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
