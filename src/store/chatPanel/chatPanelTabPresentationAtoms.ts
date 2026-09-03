import { atom } from "jotai";

import { sessionByIdAtom } from "@src/store/session/sessionAtom";
import {
  activeSessionIdAtom,
  jumpToSessionAtom,
  releasePipelineSessionAtom,
  workstationActiveSessionIdAtom,
} from "@src/store/session/viewAtom";
import {
  CHAT_PANEL_SURFACE_KIND,
  DEFAULT_CHAT_PANEL_CREATE_TARGET,
  chatPanelCreateTargetAtom,
  chatPanelNavigateAtom,
  chatPanelStartPageOpenAtom,
  toggleChatPanelMaximizedAtom,
} from "@src/store/ui/chatPanelAtom";

import {
  type ChatPanelTab,
  isChatPanelTabStationAvailable,
} from "./chatPanelTabsModel";
import {
  activeChatPanelTabAtom,
  chatPanelTabsAtom,
} from "./chatPanelTabsState";

/** User toggle guarded by the active tab's Station-access policy. */
export const toggleActiveChatPanelMaximizedAtom = atom(null, (get, set) => {
  if (!isChatPanelTabStationAvailable(get(activeChatPanelTabAtom))) {
    return false;
  }
  set(toggleChatPanelMaximizedAtom);
  return true;
});
toggleActiveChatPanelMaximizedAtom.debugLabel =
  "toggleActiveChatPanelMaximized";

/** Make the active tab's legacy surface atoms match its canonical identity. */
const syncChatPanelTabNavigationAtom = atom(
  null,
  (_get, set, tab: ChatPanelTab | null | undefined) => {
    if (!tab) return;

    if (tab.type === "start-page") {
      set(chatPanelNavigateAtom, { kind: CHAT_PANEL_SURFACE_KIND.SESSION });
      set(chatPanelStartPageOpenAtom, true);
      set(jumpToSessionAtom, null);
      return;
    }

    if (tab.type === "workspace" && tab.workspace) {
      // A workspace tab owns the workspace-overview surface. Re-navigating on
      // activation repopulates the selected-workspace atom the surface reads,
      // so switching back to this pill restores its detail page. Passing no
      // `tab` preserves whichever overview sub-tab is currently showing.
      set(chatPanelNavigateAtom, {
        kind: CHAT_PANEL_SURFACE_KIND.WORKSPACE_OVERVIEW,
        workspace: tab.workspace,
      });
      set(jumpToSessionAtom, null);
      return;
    }

    if (tab.type === "organization" && tab.organization) {
      if (tab.organization.kind === "cloud") {
        set(chatPanelNavigateAtom, {
          kind: CHAT_PANEL_SURFACE_KIND.CLOUD_ORG,
          cloudOrg: tab.organization.cloudOrg,
        });
      } else {
        set(chatPanelNavigateAtom, {
          kind: CHAT_PANEL_SURFACE_KIND.PROJECT_ORG,
          projectOrg: tab.organization.projectOrg,
        });
      }
      set(jumpToSessionAtom, null);
      return;
    }

    // Surfaces promoted to first-class tabs: replay the tab's stored payload
    // into the legacy surface atoms so the existing panels render. Each of
    // these navigate commands resets sibling surfaces and clears the start
    // page, exactly as direct navigation used to.
    if (tab.type === "work-item" && tab.workItem) {
      set(chatPanelNavigateAtom, {
        kind: CHAT_PANEL_SURFACE_KIND.WORK_ITEM,
        workItem: tab.workItem,
      });
      set(jumpToSessionAtom, null);
      return;
    }

    if (tab.type === "project" && tab.project) {
      set(chatPanelNavigateAtom, {
        kind: CHAT_PANEL_SURFACE_KIND.PROJECT,
        project: tab.project,
      });
      set(jumpToSessionAtom, null);
      return;
    }

    if (tab.type === "explore") {
      set(chatPanelNavigateAtom, {
        kind: CHAT_PANEL_SURFACE_KIND.WORKSPACE_EXPLORE,
      });
      set(jumpToSessionAtom, null);
      return;
    }

    set(chatPanelStartPageOpenAtom, false);

    // Session is the neutral legacy surface underneath tabs whose content is
    // owned by ChatPanelShell (Runtime, management, and terminal tabs).
    set(chatPanelNavigateAtom, { kind: CHAT_PANEL_SURFACE_KIND.SESSION });
    if (tab.type !== "session") set(jumpToSessionAtom, null);
  }
);

/**
 * Reconcile legacy surface state after hydration or layout changes.
 * Maximize behavior is derived at the layout boundary from the active tab, so
 * reconciliation never mutates the user's persisted preference.
 */
export const syncActiveChatPanelTabStateAtom = atom(null, (get, set) => {
  const state = get(chatPanelTabsAtom);
  const activeTab =
    state.tabs.find((tab) => tab.id === state.activeTabId) ?? null;
  // A start-page tab is also the host for non-session project surfaces.
  // Navigation deliberately closes the Launchpad before selecting one of
  // those surfaces. It also owns its pinned creator navigation. Do not let
  // the React reconciliation pass erase either newer intent after activating
  // Launchpad from another tab.
  const startPageOwnsExplicitNavigation =
    activeTab?.type === "start-page" &&
    (!get(chatPanelStartPageOpenAtom) ||
      get(chatPanelCreateTargetAtom) !== DEFAULT_CHAT_PANEL_CREATE_TARGET);
  if (!startPageOwnsExplicitNavigation) {
    set(syncChatPanelTabNavigationAtom, activeTab);
  }
});
syncActiveChatPanelTabStateAtom.debugLabel = "syncActiveChatPanelTabState";

interface ActivateChatPanelTabOptions {
  tabId: string;
  sessionName?: string;
  repoPath?: string;
}

function getActivateTabOptions(
  optionsOrTabId: ActivateChatPanelTabOptions | string
): ActivateChatPanelTabOptions {
  return typeof optionsOrTabId === "string"
    ? { tabId: optionsOrTabId }
    : optionsOrTabId;
}

/** Switch to a tab by ID and sync session state for linked session tabs. */
export const activateChatPanelTabAtom = atom(
  null,
  (get, set, optionsOrTabId: ActivateChatPanelTabOptions | string) => {
    const { tabId, sessionName, repoPath } =
      getActivateTabOptions(optionsOrTabId);
    const state = get(chatPanelTabsAtom);
    const tab = state.tabs.find((candidate) => candidate.id === tabId);
    if (!tab) return;
    if (state.activeTabId !== tabId) {
      set(chatPanelTabsAtom, { ...state, activeTabId: tabId });
    }

    set(syncChatPanelTabNavigationAtom, tab);

    // The active tab is the visibility authority. Once a non-session surface
    // takes over, release the singleton event pipeline while retaining the
    // WorkStation's remembered session so switching back to an open session
    // tab remains instant and deterministic.
    if (tab.type !== "session") set(releasePipelineSessionAtom);

    if (tab.type === "start-page") return;

    if (
      tab.type === "terminal" ||
      tab.type === "runtime" ||
      tab.type === "work-management" ||
      tab.type === "workspace" ||
      tab.type === "organization" ||
      tab.type === "work-item" ||
      tab.type === "github-issue" ||
      tab.type === "github-pr" ||
      tab.type === "project" ||
      tab.type === "explore"
    ) {
      // Surface state for these tabs is fully driven by
      // `syncChatPanelTabNavigationAtom` above; there is no session to jump to.
      return;
    }

    const sessionId = tab.type === "session" ? tab.sessionId : null;
    if (
      sessionId &&
      (get(workstationActiveSessionIdAtom) !== sessionId ||
        get(activeSessionIdAtom) !== sessionId)
    ) {
      const session = get(sessionByIdAtom(sessionId));
      set(jumpToSessionAtom, {
        sessionId,
        sessionName: sessionName ?? session?.name,
        repoPath: repoPath ?? session?.repoPath,
      });
    }
  }
);
activateChatPanelTabAtom.debugLabel = "activateChatPanelTab";

interface AppendAndActivateChatPanelTabOptions {
  tab: ChatPanelTab;
  sessionName?: string;
  repoPath?: string;
}

/** Append a tab and run the same navigation activation chain. */
export const appendAndActivateChatPanelTabAtom = atom(
  null,
  (
    get,
    set,
    { tab, sessionName, repoPath }: AppendAndActivateChatPanelTabOptions
  ) => {
    const state = get(chatPanelTabsAtom);
    set(chatPanelTabsAtom, {
      tabs: [...state.tabs, tab],
      activeTabId: tab.id,
    });
    set(activateChatPanelTabAtom, {
      tabId: tab.id,
      sessionName,
      repoPath,
    });
  }
);
