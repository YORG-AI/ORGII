/**
 * Work-management surface tab open atoms: the Work tab, workspace overview,
 * organization, work item and project pills.
 */
import { atom } from "jotai";

import {
  type ChatPanelSelectedOrganization,
  type ChatPanelSelectedProject,
  type ChatPanelSelectedWorkItem,
  type ChatPanelSelectedWorkspace,
  type WorkspaceOverviewTab,
  chatPanelWorkspaceOverviewTabAtom,
} from "@src/store/ui/chatPanelAtom";
import {
  WORK_MANAGEMENT_SECTION,
  type WorkManagementSection,
} from "@src/store/workstation/workstationTabBarAtoms";

import {
  createOrganizationTab,
  createProjectTab,
  createWorkItemTab,
  createWorkManagementTab,
  createWorkspaceTab,
  getChatPanelWorkItemTabKey,
} from "../chatPanelTabFactories";
import {
  activateChatPanelTabAtom,
  appendAndActivateChatPanelTabAtom,
} from "../chatPanelTabPresentationAtoms";
import {
  getWorkManagementFallbackTitle,
  isWorkManagementListSection,
} from "../chatPanelTabsModel";
import { chatPanelTabsAtom } from "../chatPanelTabsState";

interface OpenWorkManagementTabOptions {
  section?: WorkManagementSection;
  title?: string;
}

/** Open or focus Kanban, or reuse the single Work tab for a list dataset. */
export const openWorkManagementChatPanelTabAtom = atom(
  null,
  (get, set, options: OpenWorkManagementTabOptions = {}) => {
    const {
      section = WORK_MANAGEMENT_SECTION.KANBAN,
      title = getWorkManagementFallbackTitle(section),
    } = options;
    const state = get(chatPanelTabsAtom);
    const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId);
    const requestedListSection = isWorkManagementListSection(section);
    const activeWorkListTab =
      activeTab?.type === "work-management" &&
      activeTab.managementSection &&
      isWorkManagementListSection(activeTab.managementSection)
        ? activeTab
        : undefined;
    const existingTab =
      (requestedListSection ? activeWorkListTab : undefined) ??
      state.tabs.find(
        (tab) =>
          tab.type === "work-management" &&
          (requestedListSection
            ? Boolean(
                tab.managementSection &&
                isWorkManagementListSection(tab.managementSection)
              )
            : tab.managementSection === WORK_MANAGEMENT_SECTION.KANBAN)
      );
    if (existingTab) {
      if (
        existingTab.title !== title ||
        existingTab.managementSection !== section
      ) {
        set(chatPanelTabsAtom, {
          ...state,
          tabs: state.tabs.map((tab) =>
            tab.id === existingTab.id
              ? { ...tab, title, managementSection: section }
              : tab
          ),
        });
      }
      set(activateChatPanelTabAtom, existingTab.id);
      return existingTab.id;
    }

    const tab = createWorkManagementTab({ section, title });
    set(appendAndActivateChatPanelTabAtom, { tab });
    return tab.id;
  }
);
openWorkManagementChatPanelTabAtom.debugLabel =
  "openWorkManagementChatPanelTab";

interface OpenWorkspaceOverviewTabOptions {
  workspace: ChatPanelSelectedWorkspace;
  /** Overview sub-tab to land on (e.g. Details). Preserves current when omitted. */
  tab?: WorkspaceOverviewTab;
}

/**
 * Open — or focus, if already open — a dedicated chat-panel tab for a
 * workspace's overview / detail page. Each workspace gets its own pill titled
 * with the workspace name (not "Launchpad"); re-opening the same workspace
 * focuses the existing tab instead of stacking duplicates. The active tab
 * drives `chatPanelSelectedWorkspaceAtom` through `chatPanelNavigateAtom`,
 * which is what the overview surface actually renders from.
 */
export const openWorkspaceOverviewInChatPanelTabAtom = atom(
  null,
  (get, set, options: OpenWorkspaceOverviewTabOptions) => {
    const { workspace, tab: overviewTab } = options;
    // Seed the requested sub-tab before activation: the navigate that runs on
    // activation passes no explicit tab, so it preserves this value.
    if (overviewTab) {
      set(chatPanelWorkspaceOverviewTabAtom, overviewTab);
    }

    const existingTab = get(chatPanelTabsAtom).tabs.find(
      (candidate) =>
        candidate.type === "workspace" &&
        candidate.workspace?.kind === workspace.kind &&
        candidate.workspace?.id === workspace.id
    );
    if (existingTab) {
      // Refresh the stored payload (name/path can drift) before focusing.
      set(chatPanelTabsAtom, (prev) => ({
        ...prev,
        tabs: prev.tabs.map((candidate) =>
          candidate.id === existingTab.id
            ? { ...candidate, title: workspace.name, workspace }
            : candidate
        ),
      }));
      set(activateChatPanelTabAtom, existingTab.id);
      return existingTab.id;
    }

    const tab = createWorkspaceTab({ workspace });
    set(appendAndActivateChatPanelTabAtom, { tab });
    return tab.id;
  }
);
openWorkspaceOverviewInChatPanelTabAtom.debugLabel =
  "openWorkspaceOverviewInChatPanelTab";

interface OpenOrganizationManagementTabOptions {
  organization: ChatPanelSelectedOrganization;
  title?: string;
}

/**
 * Open or focus the singleton organization tab. Switching between cloud and
 * local organizations updates the discriminated payload in place so every
 * organization entry point shares one durable tab and presentation.
 */
export const openOrganizationInChatPanelTabAtom = atom(
  null,
  (get, set, options: OpenOrganizationManagementTabOptions) => {
    const { organization, title = "Manage ORG" } = options;
    const state = get(chatPanelTabsAtom);
    const existingTab = state.tabs.find((tab) => tab.type === "organization");
    if (existingTab) {
      set(chatPanelTabsAtom, {
        ...state,
        tabs: state.tabs.map((tab) =>
          tab.id === existingTab.id ? { ...tab, title, organization } : tab
        ),
      });
      set(activateChatPanelTabAtom, existingTab.id);
      return existingTab.id;
    }

    const tab = createOrganizationTab({ organization, title });
    set(appendAndActivateChatPanelTabAtom, { tab });
    return tab.id;
  }
);
openOrganizationInChatPanelTabAtom.debugLabel =
  "openOrganizationInChatPanelTab";

/**
 * Open — or focus, if already open — a dedicated tab for a work item. Each
 * work item gets its own pill (deduped by organization, project, and short
 * ID); activating it replays
 * the payload into the legacy surface atoms via `chatPanelNavigateAtom` so the
 * work-item panel renders. Re-opening refreshes the stored payload (name /
 * status can drift) before focusing.
 */
export const openWorkItemInChatPanelTabAtom = atom(
  null,
  (get, set, workItem: ChatPanelSelectedWorkItem) => {
    const workItemKey = getChatPanelWorkItemTabKey(workItem);
    const existingTab = get(chatPanelTabsAtom).tabs.find(
      (tab) =>
        tab.type === "work-item" &&
        tab.workItem !== undefined &&
        getChatPanelWorkItemTabKey(tab.workItem) === workItemKey
    );
    if (existingTab) {
      set(chatPanelTabsAtom, (prev) => ({
        ...prev,
        tabs: prev.tabs.map((tab) =>
          tab.id === existingTab.id
            ? { ...tab, title: workItem.workItem.name || tab.title, workItem }
            : tab
        ),
      }));
      set(activateChatPanelTabAtom, existingTab.id);
      return existingTab.id;
    }
    const tab = createWorkItemTab({ workItem });
    set(appendAndActivateChatPanelTabAtom, { tab });
    return tab.id;
  }
);
openWorkItemInChatPanelTabAtom.debugLabel = "openWorkItemInChatPanelTab";

/** Open or focus a dedicated tab for a project (deduped by slug). */
export const openProjectInChatPanelTabAtom = atom(
  null,
  (get, set, project: ChatPanelSelectedProject) => {
    const existingTab = get(chatPanelTabsAtom).tabs.find(
      (tab) =>
        tab.type === "project" &&
        tab.project?.projectSlug === project.projectSlug
    );
    if (existingTab) {
      set(chatPanelTabsAtom, (prev) => ({
        ...prev,
        tabs: prev.tabs.map((tab) =>
          tab.id === existingTab.id
            ? { ...tab, title: project.project.name || tab.title, project }
            : tab
        ),
      }));
      set(activateChatPanelTabAtom, existingTab.id);
      return existingTab.id;
    }
    const tab = createProjectTab({ project });
    set(appendAndActivateChatPanelTabAtom, { tab });
    return tab.id;
  }
);
openProjectInChatPanelTabAtom.debugLabel = "openProjectInChatPanelTab";
