import { atom } from "jotai";

import { destroyChatPanelTerminalAtom } from "@src/store/chatPanel/chatPanelTerminalAtom";
import { workstationActiveSessionIdAtom } from "@src/store/session/viewAtom";
import {
  type ChatPanelSelectedWorkItem,
  chatPanelSelectedCloudOrgAtom,
  chatPanelSelectedProjectAtom,
  chatPanelSelectedProjectOrgAtom,
  chatPanelSelectedWorkItemAtom,
} from "@src/store/ui/chatPanelAtom";
import type { WorkManagementSection } from "@src/store/workstation";

import { buildDefaultLaunchpadTab } from "./chatPanelTabFactories";
import { activateChatPanelTabAtom } from "./chatPanelTabPresentationAtoms";
import {
  type ChatPanelSelectedChannel,
  getWorkManagementFallbackTitle,
} from "./chatPanelTabsModel";
import { chatPanelTabsAtom } from "./chatPanelTabsState";
import { disposeWorkManagementStateAtom } from "./disposeWorkManagementStateAtom";

/** Clear the cliCommand on a tab after it has been injected */
export const clearChatPanelTabCliCommandAtom = atom(
  null,
  (_get, set, tabId: string) => {
    set(chatPanelTabsAtom, (prev) => ({
      ...prev,
      tabs: prev.tabs.map((tab) =>
        tab.id === tabId ? { ...tab, cliCommand: undefined } : tab
      ),
    }));
  }
);
clearChatPanelTabCliCommandAtom.debugLabel = "clearChatPanelTabCliCommand";

/** Change the dataset shown by the active Work tab without opening another tab. */
export const setActiveWorkManagementSectionAtom = atom(
  null,
  (
    get,
    set,
    {
      section,
      title = getWorkManagementFallbackTitle(section),
    }: { section: WorkManagementSection; title?: string }
  ) => {
    const state = get(chatPanelTabsAtom);
    const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId);
    if (activeTab?.type !== "work-management") return;
    set(chatPanelTabsAtom, {
      ...state,
      tabs: state.tabs.map((tab) =>
        tab.id === activeTab.id
          ? { ...tab, managementSection: section, title }
          : tab
      ),
    });
  }
);
setActiveWorkManagementSectionAtom.debugLabel =
  "setActiveWorkManagementSection";

/** Close a tab by ID. If it was active, move to the nearest neighbour. */
export const closeChatPanelTabAtom = atom(null, (get, set, tabId: string) => {
  const state = get(chatPanelTabsAtom);
  const idx = state.tabs.findIndex((tab) => tab.id === tabId);
  if (idx === -1) return;
  const tab = state.tabs[idx];
  const nextTabs = state.tabs.filter((candidate) => candidate.id !== tabId);
  if (
    tab.type === "session" &&
    tab.sessionId &&
    get(workstationActiveSessionIdAtom) === tab.sessionId &&
    !nextTabs.some(
      (candidate) =>
        candidate.type === "session" && candidate.sessionId === tab.sessionId
    )
  ) {
    // A closed tab cannot remain the WorkStation's remembered selection.
    // Activating a neighbouring session below will immediately replace this;
    // a Launchpad/non-session fallback correctly leaves it empty.
    set(workstationActiveSessionIdAtom, null);
  }
  if (
    tab.type === "work-management" &&
    !nextTabs.some((candidate) => candidate.type === "work-management")
  ) {
    set(disposeWorkManagementStateAtom);
  }
  let nextActiveId = state.activeTabId;

  if (nextTabs.length === 0) {
    const launchpad = buildDefaultLaunchpadTab();
    set(chatPanelTabsAtom, {
      tabs: [launchpad],
      activeTabId: launchpad.id,
    });
    set(activateChatPanelTabAtom, launchpad.id);
    return;
  }

  if (state.activeTabId === tabId) {
    const nextIdx = Math.max(0, idx - 1);
    nextActiveId = nextTabs[Math.min(nextIdx, nextTabs.length - 1)].id;
  }

  set(chatPanelTabsAtom, { tabs: nextTabs, activeTabId: nextActiveId });
  if (state.activeTabId === tabId) {
    set(activateChatPanelTabAtom, nextActiveId);
  }
});
closeChatPanelTabAtom.debugLabel = "closeChatPanelTab";

/** Close the singleton organization tab, or clear its legacy surface mirrors. */
export const closeOrganizationChatPanelTabAtom = atom(null, (get, set) => {
  const tab = get(chatPanelTabsAtom).tabs.find(
    (candidate) => candidate.type === "organization"
  );
  if (tab) {
    set(closeChatPanelTabAtom, tab.id);
    return;
  }
  set(chatPanelSelectedCloudOrgAtom, null);
  set(chatPanelSelectedProjectOrgAtom, null);
});
closeOrganizationChatPanelTabAtom.debugLabel = "closeOrganizationChatPanelTab";

/**
 * Close the tab that owns a deleted Work Item. Remote item tombstones and
 * project cascades must remove the durable tab payload as well as the legacy
 * selected-work-item mirror; clearing only the mirror leaves an editable ghost
 * because `WorkItemSurfaceRenderer` is keyed by the tab.
 */
export const closeWorkItemChatPanelTabAtom = atom(
  null,
  (get, set, shortId: string) => {
    const tab = get(chatPanelTabsAtom).tabs.find(
      (candidate) =>
        candidate.type === "work-item" &&
        candidate.workItem?.shortId === shortId
    );
    if (tab) {
      set(closeChatPanelTabAtom, tab.id);
      return;
    }
    const selected = get(chatPanelSelectedWorkItemAtom);
    if (selected?.shortId === shortId) {
      set(chatPanelSelectedWorkItemAtom, null);
    }
  }
);
closeWorkItemChatPanelTabAtom.debugLabel = "closeWorkItemChatPanelTab";

/**
 * Close every project/org/work-item tab backed by a project org whose remote
 * membership was revoked. The tab payload is the durable owner of these
 * surfaces, so clearing only sidebar selection would leave cached Team data
 * visible and editable after the authoritative cloud roster removed it.
 */
export const closeProjectOrgChatPanelTabsAtom = atom(
  null,
  (get, set, orgIds: readonly string[]) => {
    if (orgIds.length === 0) return;
    const revoked = new Set(orgIds);
    const tabIds = get(chatPanelTabsAtom)
      .tabs.filter((tab) => {
        if (tab.type === "work-item") {
          return Boolean(
            tab.workItem?.orgId && revoked.has(tab.workItem.orgId)
          );
        }
        if (tab.type === "project") {
          return Boolean(tab.project?.orgId && revoked.has(tab.project.orgId));
        }
        if (tab.type === "organization" && tab.organization?.kind === "local") {
          return Boolean(revoked.has(tab.organization.projectOrg.orgId));
        }
        return false;
      })
      .map((tab) => tab.id);

    for (const tabId of tabIds) set(closeChatPanelTabAtom, tabId);

    const selectedWorkItem = get(chatPanelSelectedWorkItemAtom);
    if (selectedWorkItem?.orgId && revoked.has(selectedWorkItem.orgId)) {
      set(chatPanelSelectedWorkItemAtom, null);
    }
    const selectedProject = get(chatPanelSelectedProjectAtom);
    if (selectedProject?.orgId && revoked.has(selectedProject.orgId)) {
      set(chatPanelSelectedProjectAtom, null);
    }
    const selectedProjectOrg = get(chatPanelSelectedProjectOrgAtom);
    if (revoked.has(selectedProjectOrg?.orgId ?? "")) {
      set(chatPanelSelectedProjectOrgAtom, null);
    }
  }
);
closeProjectOrgChatPanelTabsAtom.debugLabel = "closeProjectOrgChatPanelTabs";

/**
 * Close cloud channel tabs whose org is no longer in the authoritative
 * roster. Per-org channel-tab reconciliation only runs while that org is the
 * ACTIVE sidebar scope; a revoked org can never become active again, so its
 * channel tabs (private ones included) would otherwise persist forever with
 * cached names. Keyed by LIVE cloud org ids so an empty roster read cannot
 * be distinguished from revocation — callers must gate on rosterLoaded.
 */
export const closeRevokedCloudChannelChatPanelTabsAtom = atom(
  null,
  (get, set, liveCloudOrgIds: readonly string[]) => {
    const live = new Set(liveCloudOrgIds);
    const tabIds = get(chatPanelTabsAtom)
      .tabs.filter(
        (tab) =>
          tab.type === "channel" &&
          tab.channel?.scope === "cloud" &&
          !live.has(tab.channel.orgId)
      )
      .map((tab) => tab.id);
    for (const tabId of tabIds) set(closeChatPanelTabAtom, tabId);
  }
);
closeRevokedCloudChannelChatPanelTabsAtom.debugLabel =
  "closeRevokedCloudChannelChatPanelTabs";

export type ReconcileDiscussionChannelTabsInput =
  | {
      scope: "local";
      channels: readonly Extract<
        ChatPanelSelectedChannel,
        { scope: "local" }
      >[];
    }
  | {
      scope: "cloud";
      orgId: string;
      channels: readonly Extract<
        ChatPanelSelectedChannel,
        { scope: "cloud" }
      >[];
    };

/**
 * Close discussion-channel tabs that disappeared from an authoritative full
 * listing and refresh the payload/title of survivors. Cloud callers must
 * include archived rows, so an archive remains readable while a membership
 * revocation or hard delete closes the stale tab.
 */
export const reconcileDiscussionChannelTabsAtom = atom(
  null,
  (get, set, input: ReconcileDiscussionChannelTabsInput) => {
    const accessible = new Map(
      input.channels.map((channel) => [channel.channelId, channel])
    );
    const state = get(chatPanelTabsAtom);
    const tabIds: string[] = [];
    let payloadChanged = false;
    const tabs = state.tabs.map((tab) => {
      if (tab.type !== "channel" || !tab.channel) return tab;
      const matchesScope =
        input.scope === "local"
          ? tab.channel.scope === "local"
          : tab.channel.scope === "cloud" && tab.channel.orgId === input.orgId;
      if (!matchesScope) return tab;

      const channel = accessible.get(tab.channel.channelId);
      if (!channel) {
        tabIds.push(tab.id);
        return tab;
      }
      const samePayload =
        channel.scope === tab.channel.scope &&
        channel.name === tab.channel.name &&
        (channel.scope === "local" ||
          (tab.channel.scope === "cloud" &&
            channel.orgId === tab.channel.orgId &&
            channel.visibility === tab.channel.visibility));
      if (samePayload) return tab;
      payloadChanged = true;
      return { ...tab, title: channel.name, channel };
    });

    if (payloadChanged) set(chatPanelTabsAtom, { ...state, tabs });
    for (const tabId of tabIds) set(closeChatPanelTabAtom, tabId);
    return tabIds;
  }
);
reconcileDiscussionChannelTabsAtom.debugLabel =
  "reconcileDiscussionChannelTabs";

/** Navigate to the next tab (wraps around) */
export const nextChatPanelTabAtom = atom(null, (get, set) => {
  const state = get(chatPanelTabsAtom);
  if (state.tabs.length === 0) return;
  const idx = state.tabs.findIndex((tab) => tab.id === state.activeTabId);
  const nextIdx = ((idx === -1 ? 0 : idx) + 1) % state.tabs.length;
  set(activateChatPanelTabAtom, state.tabs[nextIdx].id);
});
nextChatPanelTabAtom.debugLabel = "nextChatPanelTab";

/** Navigate to the previous tab (wraps around) */
export const prevChatPanelTabAtom = atom(null, (get, set) => {
  const state = get(chatPanelTabsAtom);
  if (state.tabs.length === 0) return;
  const idx = state.tabs.findIndex((tab) => tab.id === state.activeTabId);
  const currentIdx = idx === -1 ? 0 : idx;
  const prevIdx = (currentIdx - 1 + state.tabs.length) % state.tabs.length;
  set(activateChatPanelTabAtom, state.tabs[prevIdx].id);
});
prevChatPanelTabAtom.debugLabel = "prevChatPanelTab";

/** Reorder tabs within the Chat Panel strip without changing the active tab. */
export const reorderChatPanelTabsAtom = atom(
  null,
  (
    get,
    set,
    { startIndex, endIndex }: { startIndex: number; endIndex: number }
  ) => {
    const state = get(chatPanelTabsAtom);
    if (
      startIndex === endIndex ||
      startIndex < 0 ||
      endIndex < 0 ||
      startIndex >= state.tabs.length ||
      endIndex >= state.tabs.length
    ) {
      return;
    }
    const tabs = [...state.tabs];
    const [movedTab] = tabs.splice(startIndex, 1);
    tabs.splice(endIndex, 0, movedTab);
    set(chatPanelTabsAtom, { ...state, tabs });
  }
);
reorderChatPanelTabsAtom.debugLabel = "reorderChatPanelTabs";

/** Update the title on the given tab */
export const setChatPanelTabTitleAtom = atom(
  null,
  (_get, set, { tabId, title }: { tabId: string; title: string }) => {
    set(chatPanelTabsAtom, (prev) => {
      if (prev.tabs.some((tab) => tab.id === tabId && tab.title === title)) {
        return prev;
      }

      const now = new Date().toISOString();
      return {
        ...prev,
        tabs: prev.tabs.map((tab) =>
          tab.id === tabId ? { ...tab, title, updatedAt: now } : tab
        ),
      };
    });
  }
);

/**
 * Keep a work-item tab's stored payload in sync with in-place edits made
 * through `chatPanelSelectedWorkItemAtom` (rename / status change / refresh).
 * Without this, switching away and back would replay the stale payload and
 * revert the edit. Matched by `shortId`; a no-op (returns the previous state)
 * when the payload reference is unchanged — e.g. the seed written on tab
 * activation — so it never churns tab state or persistence.
 */
export const patchChatPanelWorkItemTabAtom = atom(
  null,
  (_get, set, workItem: ChatPanelSelectedWorkItem) => {
    set(chatPanelTabsAtom, (prev) => {
      const target = prev.tabs.find(
        (tab) =>
          tab.type === "work-item" && tab.workItem?.shortId === workItem.shortId
      );
      if (!target || target.workItem === workItem) return prev;
      return {
        ...prev,
        tabs: prev.tabs.map((tab) =>
          tab.id === target.id
            ? { ...tab, workItem, title: workItem.workItem.name || tab.title }
            : tab
        ),
      };
    });
  }
);
patchChatPanelWorkItemTabAtom.debugLabel = "patchChatPanelWorkItemTab";

/** Toggle TUI mode on the given tab */
export const toggleChatPanelTabTuiModeAtom = atom(
  null,
  (_get, set, tabId: string) => {
    set(chatPanelTabsAtom, (prev) => ({
      ...prev,
      tabs: prev.tabs.map((tab) =>
        tab.id === tabId ? { ...tab, tuiMode: !tab.tuiMode } : tab
      ),
    }));
  }
);

/**
 * Close a tab AND, for terminal tabs, destroy the backing PTY and clear its
 * buffer cache slot. Use this instead of closeChatPanelTabAtom when the
 * caller has access to the Jotai store (i.e., inside React components).
 */
export const closeAndDestroyChatPanelTabAtom = atom(
  null,
  async (get, set, tabId: string): Promise<void> => {
    const state = get(chatPanelTabsAtom);
    const tab = state.tabs.find((candidate) => candidate.id === tabId);
    // Destroy PTY before removing the tab so the terminal session ID is still
    // reachable during cleanup.
    if (tab?.type === "terminal" && tab.terminalSessionId) {
      await set(destroyChatPanelTerminalAtom, tab.terminalSessionId);
    }
    set(closeChatPanelTabAtom, tabId);
  }
);
closeAndDestroyChatPanelTabAtom.debugLabel = "closeAndDestroyChatPanelTab";

/**
 * Close every tab except the requested one, activating the retained tab.
 * Terminal resources are destroyed before their tab records are removed.
 */
export const closeOtherChatPanelTabsAtom = atom(
  null,
  async (get, set, keepTabId: string): Promise<void> => {
    const state = get(chatPanelTabsAtom);
    if (!state.tabs.some((tab) => tab.id === keepTabId)) return;

    const tabsToClose = state.tabs.filter((tab) => tab.id !== keepTabId);
    await Promise.all(
      tabsToClose.map((tab) =>
        tab.type === "terminal" && tab.terminalSessionId
          ? set(destroyChatPanelTerminalAtom, tab.terminalSessionId)
          : Promise.resolve()
      )
    );

    for (const tab of tabsToClose) {
      set(closeChatPanelTabAtom, tab.id);
    }

    if (
      get(chatPanelTabsAtom).tabs.some(
        (candidate) => candidate.id === keepTabId
      )
    ) {
      set(activateChatPanelTabAtom, keepTabId);
    }
  }
);
closeOtherChatPanelTabsAtom.debugLabel = "closeOtherChatPanelTabs";
