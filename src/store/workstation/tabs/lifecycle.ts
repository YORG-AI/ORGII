import type {
  WorkStationTab,
  WorkstationTabRef,
  WorkstationTabsStateV3,
  WorkstationWorkspaceState,
} from "./types";
import { getWorkstationSharedTabRetention } from "./types";

function refIdentity(ref: WorkstationTabRef): string {
  return `${ref.partition}:${ref.tabId}`;
}

function allWorkspaces(
  state: WorkstationTabsStateV3
): WorkstationWorkspaceState[] {
  return [
    state.globalWorkspace,
    ...Object.values(state.sessionWorkspaces),
    ...(state.legacySeed ? [state.legacySeed] : []),
  ];
}

/** Shared tab IDs currently presented by at least one workspace. */
export function collectReferencedSharedTabIds(
  state: WorkstationTabsStateV3
): Set<string> {
  const referenced = new Set<string>();
  for (const workspace of allWorkspaces(state)) {
    for (const ref of workspace.tabOrder) {
      if (ref.partition === "shared") referenced.add(ref.tabId);
    }
  }
  return referenced;
}

/**
 * Remove ownerless shared presentation records. Browser and Terminal records
 * are retained because their independent resource stores own their lifetime.
 */
export function pruneUnreferencedSharedTabs(
  state: WorkstationTabsStateV3
): WorkstationTabsStateV3 {
  const referenced = collectReferencedSharedTabIds(state);
  const tabs = state.shared.tabs.filter((tab) => {
    const retention = getWorkstationSharedTabRetention(tab.type);
    return retention === "resource-owned" || referenced.has(tab.id);
  });
  if (tabs.length === state.shared.tabs.length) return state;
  return { ...state, shared: { tabs } };
}

function filterWorkspace(
  workspace: WorkstationWorkspaceState,
  removedSharedIds: ReadonlySet<string>,
  matchesLocalTab: (tab: WorkStationTab) => boolean
): WorkstationWorkspaceState {
  const removedLocalIds = new Set(
    workspace.tabs.filter(matchesLocalTab).map((tab) => tab.id)
  );
  const hasRemovedSharedRef = workspace.tabOrder.some(
    (ref) => ref.partition === "shared" && removedSharedIds.has(ref.tabId)
  );
  if (!hasRemovedSharedRef && removedLocalIds.size === 0) {
    return workspace;
  }

  const tabs =
    removedLocalIds.size === 0
      ? workspace.tabs
      : workspace.tabs.filter((tab) => !removedLocalIds.has(tab.id));
  const activeIdentity = workspace.activeTabRef
    ? refIdentity(workspace.activeTabRef)
    : null;
  const activeIndex = activeIdentity
    ? workspace.tabOrder.findIndex((ref) => refIdentity(ref) === activeIdentity)
    : -1;
  const tabOrder = workspace.tabOrder.filter((ref) =>
    ref.partition === "shared"
      ? !removedSharedIds.has(ref.tabId)
      : !removedLocalIds.has(ref.tabId)
  );
  const activeRemoved = workspace.activeTabRef
    ? workspace.activeTabRef.partition === "shared"
      ? removedSharedIds.has(workspace.activeTabRef.tabId)
      : removedLocalIds.has(workspace.activeTabRef.tabId)
    : false;
  const isRemovedRef = (ref: WorkstationTabRef): boolean =>
    ref.partition === "shared"
      ? removedSharedIds.has(ref.tabId)
      : removedLocalIds.has(ref.tabId);
  const activeTabRef = activeRemoved
    ? (workspace.tabOrder
        .slice(activeIndex + 1)
        .find((ref) => !isRemovedRef(ref)) ??
      workspace.tabOrder
        .slice(0, Math.max(activeIndex, 0))
        .reverse()
        .find((ref) => !isRemovedRef(ref)) ??
      null)
    : workspace.activeTabRef;

  return { tabs, activeTabRef, tabOrder };
}

function mapSessionWorkspaces(
  workspaces: Record<string, WorkstationWorkspaceState>,
  updater: (workspace: WorkstationWorkspaceState) => WorkstationWorkspaceState
): Record<string, WorkstationWorkspaceState> {
  let changed = false;
  const entries = Object.entries(workspaces).map(([sessionId, workspace]) => {
    const next = updater(workspace);
    if (next !== workspace) changed = true;
    return [sessionId, next] as const;
  });
  return changed ? Object.fromEntries(entries) : workspaces;
}

/** Remove explicit shared resources and every reference to them. */
export function removeSharedTabsById(
  state: WorkstationTabsStateV3,
  requestedIds: ReadonlySet<string>
): WorkstationTabsStateV3 {
  const removedSharedIds = new Set(
    state.shared.tabs
      .filter((tab) => requestedIds.has(tab.id))
      .map((tab) => tab.id)
  );
  if (removedSharedIds.size === 0) return state;

  const updateWorkspace = (workspace: WorkstationWorkspaceState) =>
    filterWorkspace(workspace, removedSharedIds, () => false);
  const next: WorkstationTabsStateV3 = {
    ...state,
    shared: {
      tabs: state.shared.tabs.filter((tab) => !removedSharedIds.has(tab.id)),
    },
    globalWorkspace: updateWorkspace(state.globalWorkspace),
    sessionWorkspaces: mapSessionWorkspaces(
      state.sessionWorkspaces,
      updateWorkspace
    ),
    legacySeed: state.legacySeed
      ? updateWorkspace(state.legacySeed)
      : state.legacySeed,
  };
  return pruneUnreferencedSharedTabs(next);
}

/** Remove matching shared/local tabs across Global, every session, and seed. */
export function removeWorkstationTabsMatching(
  state: WorkstationTabsStateV3,
  matches: (tab: WorkStationTab) => boolean
): WorkstationTabsStateV3 {
  const removedSharedIds = new Set(
    state.shared.tabs.filter(matches).map((tab) => tab.id)
  );
  const updateWorkspace = (workspace: WorkstationWorkspaceState) =>
    filterWorkspace(workspace, removedSharedIds, matches);
  const globalWorkspace = updateWorkspace(state.globalWorkspace);
  const sessionWorkspaces = mapSessionWorkspaces(
    state.sessionWorkspaces,
    updateWorkspace
  );
  const legacySeed = state.legacySeed
    ? updateWorkspace(state.legacySeed)
    : state.legacySeed;
  const sharedTabs =
    removedSharedIds.size === 0
      ? state.shared.tabs
      : state.shared.tabs.filter((tab) => !removedSharedIds.has(tab.id));

  if (
    globalWorkspace === state.globalWorkspace &&
    sessionWorkspaces === state.sessionWorkspaces &&
    legacySeed === state.legacySeed &&
    sharedTabs === state.shared.tabs
  ) {
    return state;
  }

  return pruneUnreferencedSharedTabs({
    ...state,
    shared: { tabs: sharedTabs },
    globalWorkspace,
    sessionWorkspaces,
    legacySeed,
  });
}
