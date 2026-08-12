import { atom } from "jotai";

import { sessionByIdAtom } from "@src/store/session/sessionAtom";
import {
  type ChatPanelCollabOrgCreateIntent,
  type ChatPanelCreateProjectContext,
  type ChatPanelCreateTarget,
  type ChatPanelSelectedOrganization,
  type ChatPanelSelectedProject,
  type ChatPanelSelectedWorkItem,
  type ChatPanelSelectedWorkspace,
  type WorkspaceOverviewTab,
  chatPanelCollabOrgCreateIntentAtom,
  chatPanelCreateProjectContextAtom,
  chatPanelCreateTargetAtom,
  chatPanelStartPageOpenAtom,
  chatPanelWorkspaceOverviewTabAtom,
} from "@src/store/ui/chatPanelAtom";
import {
  WORK_MANAGEMENT_SECTION,
  type WorkManagementSection,
} from "@src/store/workstation/workstationTabBarAtoms";
import type {
  GitHubIssueDetailTabData,
  GitHubPrDetailTabData,
} from "@src/types/githubDetail";

import {
  buildChannelTabKey,
  createChannelTab,
  createExploreTab,
  createGitHubIssueTab,
  createGitHubPrTab,
  createLaunchpadTab,
  createOrganizationTab,
  createProjectTab,
  createRuntimeTab,
  createSessionTab,
  createTeamInboxTab,
  createTerminalTab,
  createWorkItemTab,
  createWorkManagementTab,
  createWorkspaceTab,
  getChatPanelWorkItemTabKey,
} from "./chatPanelTabFactories";
import {
  activateChatPanelTabAtom,
  appendAndActivateChatPanelTabAtom,
} from "./chatPanelTabPresentationAtoms";
import {
  type ChatPanelSelectedChannel,
  type ChatPanelTab,
  getWorkManagementFallbackTitle,
  isWorkManagementListSection,
} from "./chatPanelTabsModel";
import { chatPanelTabsAtom } from "./chatPanelTabsState";

/** Add a standalone Launchpad tab and show its Work page. */
export const addChatPanelLaunchpadTabAtom = atom(
  null,
  (_get, set, title: string = "Launchpad") => {
    const tab = createLaunchpadTab({ title });
    set(appendAndActivateChatPanelTabAtom, { tab });
    return tab.id;
  }
);
addChatPanelLaunchpadTabAtom.debugLabel = "addChatPanelLaunchpadTab";

interface OpenOrFocusStartPageTabOptions {
  title?: string;
}

/**
 * Focus the singleton Launchpad start-page tab, or create it when none is
 * open. This is the one entry point new-session and
 * launchpad triggers should use so they reuse the existing tab instead of
 * stacking duplicates.
 */
export const openOrFocusChatPanelStartPageTabAtom = atom(
  null,
  (get, set, options: OpenOrFocusStartPageTabOptions = {}) => {
    const { title = "Launchpad" } = options;
    const existingTab = get(chatPanelTabsAtom).tabs.find(
      (tab) => tab.type === "start-page"
    );
    if (existingTab) {
      set(activateChatPanelTabAtom, existingTab.id);
      return existingTab.id;
    }
    return set(addChatPanelLaunchpadTabAtom, title);
  }
);
openOrFocusChatPanelStartPageTabAtom.debugLabel =
  "openOrFocusChatPanelStartPageTab";

interface OpenCreateTargetInStartPageOptions {
  target: ChatPanelCreateTarget;
  title?: string;
  createProjectContext?: ChatPanelCreateProjectContext | null;
  collabOrgCreateIntent?: ChatPanelCollabOrgCreateIntent | null;
}

/** Focus Launchpad and show a creator inside its pinned inner navigation. */
export const openCreateTargetInChatPanelStartPageAtom = atom(
  null,
  (_get, set, options: OpenCreateTargetInStartPageOptions) => {
    const tabId = set(openOrFocusChatPanelStartPageTabAtom, {
      title: options.title,
    });
    set(chatPanelCreateTargetAtom, options.target);
    set(
      chatPanelCreateProjectContextAtom,
      options.createProjectContext ?? null
    );
    set(
      chatPanelCollabOrgCreateIntentAtom,
      options.collabOrgCreateIntent ?? null
    );
    set(chatPanelStartPageOpenAtom, true);
    return tabId;
  }
);
openCreateTargetInChatPanelStartPageAtom.debugLabel =
  "openCreateTargetInChatPanelStartPage";

/** Open or focus the singleton Runtime tab. */
export const openRuntimeInChatPanelTabAtom = atom(
  null,
  (get, set, title: string = "Runtime") => {
    const existingTab = get(chatPanelTabsAtom).tabs.find(
      (tab) => tab.type === "runtime"
    );
    if (existingTab) {
      set(activateChatPanelTabAtom, existingTab.id);
      return existingTab.id;
    }

    const tab = createRuntimeTab({ title });
    set(appendAndActivateChatPanelTabAtom, { tab });
    return tab.id;
  }
);
openRuntimeInChatPanelTabAtom.debugLabel = "openRuntimeInChatPanelTab";

/** Open or focus the singleton Team Inbox tab. */
export const openTeamInboxInChatPanelTabAtom = atom(
  null,
  (get, set, title: string = "Inbox") => {
    const state = get(chatPanelTabsAtom);
    const existingTab = state.tabs.find((tab) => tab.type === "team-inbox");
    if (existingTab) {
      if (existingTab.title !== title) {
        set(chatPanelTabsAtom, {
          ...state,
          tabs: state.tabs.map((tab) =>
            tab.id === existingTab.id ? { ...tab, title } : tab
          ),
        });
      }
      set(activateChatPanelTabAtom, existingTab.id);
      return existingTab.id;
    }

    const tab = createTeamInboxTab({ title });
    set(appendAndActivateChatPanelTabAtom, { tab });
    return tab.id;
  }
);
openTeamInboxInChatPanelTabAtom.debugLabel = "openTeamInboxInChatPanelTab";

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

interface OpenSessionInNewChatTabOptions {
  sessionId: string;
  sessionName?: string;
  repoPath?: string;
}

/**
 * Open an existing session in a new chat panel tab and make it the active
 * WorkStation session.
 */
export const openSessionInNewChatTabAtom = atom(
  null,
  (_get, set, optionsOrSessionId: OpenSessionInNewChatTabOptions | string) => {
    const options =
      typeof optionsOrSessionId === "string"
        ? { sessionId: optionsOrSessionId }
        : optionsOrSessionId;
    const { sessionId, sessionName, repoPath } = options;
    const tab = createSessionTab({ sessionId, title: sessionName });
    set(appendAndActivateChatPanelTabAtom, {
      tab,
      sessionName,
      repoPath,
    });
    return tab.id;
  }
);
openSessionInNewChatTabAtom.debugLabel = "openSessionInNewChatTab";

/** Focus an existing tab for a session, or create one when none is open. */
export const openOrFocusSessionInChatPanelTabAtom = atom(
  null,
  (get, set, options: OpenSessionInNewChatTabOptions) => {
    const existingTab = get(chatPanelTabsAtom).tabs.find(
      (tab) => tab.type === "session" && tab.sessionId === options.sessionId
    );
    if (existingTab) {
      set(activateChatPanelTabAtom, {
        tabId: existingTab.id,
        sessionName: options.sessionName,
        repoPath: options.repoPath,
      });
      return existingTab.id;
    }

    return set(openSessionInNewChatTabAtom, options);
  }
);
openOrFocusSessionInChatPanelTabAtom.debugLabel =
  "openOrFocusSessionInChatPanelTab";

/**
 * Open a session from the sidebar without stacking tabs during normal
 * navigation. An already-open target is focused; otherwise the active session
 * tab is repointed to the target. Non-session tabs are never replaced.
 */
export const openOrReplaceSessionInChatPanelTabAtom = atom(
  null,
  (get, set, options: OpenSessionInNewChatTabOptions) => {
    const state = get(chatPanelTabsAtom);
    const existingTab = state.tabs.find(
      (tab) => tab.type === "session" && tab.sessionId === options.sessionId
    );
    if (existingTab) {
      set(activateChatPanelTabAtom, {
        tabId: existingTab.id,
        sessionName: options.sessionName,
        repoPath: options.repoPath,
      });
      return existingTab.id;
    }

    const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId);
    if (activeTab?.type !== "session") {
      return set(openSessionInNewChatTabAtom, options);
    }

    const session = get(sessionByIdAtom(options.sessionId));
    const replacementTab: ChatPanelTab = {
      ...activeTab,
      title: options.sessionName ?? session?.name ?? "Chat",
      sessionId: options.sessionId,
      updatedAt: new Date().toISOString(),
    };
    set(chatPanelTabsAtom, {
      ...state,
      tabs: state.tabs.map((tab) =>
        tab.id === activeTab.id ? replacementTab : tab
      ),
    });
    set(activateChatPanelTabAtom, {
      tabId: activeTab.id,
      sessionName: options.sessionName,
      repoPath: options.repoPath,
    });
    return activeTab.id;
  }
);
openOrReplaceSessionInChatPanelTabAtom.debugLabel =
  "openOrReplaceSessionInChatPanelTab";

interface AddTerminalTabOptions {
  terminalSessionId: string;
  title?: string;
  /** CLI binary command to write to the PTY once the shell is ready (e.g. "claude") */
  cliCommand?: string;
}

/** Add a new terminal tab, using the provided terminal session ID */
export const addChatPanelTerminalTabAtom = atom(
  null,
  (_get, set, optionsOrId: AddTerminalTabOptions | string) => {
    const {
      terminalSessionId,
      title = "Terminal",
      cliCommand,
    } = typeof optionsOrId === "string"
      ? { terminalSessionId: optionsOrId }
      : optionsOrId;
    const tab = createTerminalTab({ terminalSessionId, title, cliCommand });
    set(appendAndActivateChatPanelTabAtom, { tab });
    return tab.id;
  }
);
addChatPanelTerminalTabAtom.debugLabel = "addChatPanelTerminalTab";

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

/** Open or focus a GitHub issue detail tab inside the chat pane. */
export const openGitHubIssueInChatPanelTabAtom = atom(
  null,
  (get, set, issue: GitHubIssueDetailTabData) => {
    const existingTab = get(chatPanelTabsAtom).tabs.find(
      (tab) =>
        tab.type === "github-issue" &&
        tab.githubIssue?.repoPath === issue.repoPath &&
        tab.githubIssue.issueNumber === issue.issueNumber
    );
    if (existingTab) {
      set(chatPanelTabsAtom, (prev) => ({
        ...prev,
        tabs: prev.tabs.map((tab) =>
          tab.id === existingTab.id
            ? {
                ...tab,
                title: `#${issue.issueNumber} ${issue.issueTitle}`,
                githubIssue: issue,
              }
            : tab
        ),
      }));
      set(activateChatPanelTabAtom, existingTab.id);
      return existingTab.id;
    }
    const tab = createGitHubIssueTab(issue);
    set(appendAndActivateChatPanelTabAtom, { tab });
    return tab.id;
  }
);
openGitHubIssueInChatPanelTabAtom.debugLabel = "openGitHubIssueInChatPanelTab";

/** Open or focus a GitHub pull-request detail tab inside the chat pane. */
export const openGitHubPrInChatPanelTabAtom = atom(
  null,
  (get, set, pr: GitHubPrDetailTabData) => {
    const existingTab = get(chatPanelTabsAtom).tabs.find(
      (tab) =>
        tab.type === "github-pr" &&
        tab.githubPr?.repoPath === pr.repoPath &&
        tab.githubPr.prNumber === pr.prNumber
    );
    if (existingTab) {
      set(chatPanelTabsAtom, (prev) => ({
        ...prev,
        tabs: prev.tabs.map((tab) =>
          tab.id === existingTab.id
            ? {
                ...tab,
                title: `#${pr.prNumber} ${pr.prTitle}`,
                githubPr: pr,
              }
            : tab
        ),
      }));
      set(activateChatPanelTabAtom, existingTab.id);
      return existingTab.id;
    }
    const tab = createGitHubPrTab(pr);
    set(appendAndActivateChatPanelTabAtom, { tab });
    return tab.id;
  }
);
openGitHubPrInChatPanelTabAtom.debugLabel = "openGitHubPrInChatPanelTab";

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

/**
 * Open — or focus, if already open — a dedicated tab for a channel's message
 * surface. Deduped per composite key (`cloud:orgId:channelId` /
 * `local:channelId`, see `buildChannelTabKey`), the `openWorkItemInChatPanelTab`
 * shape: re-opening refreshes the stored payload (a rename, or a cloud
 * channel flipping visibility, would otherwise leave the pill stale) before
 * focusing instead of stacking a second pill.
 */
export const openChannelInChatPanelTabAtom = atom(
  null,
  (get, set, channel: ChatPanelSelectedChannel) => {
    const key = buildChannelTabKey(channel);
    const existingTab = get(chatPanelTabsAtom).tabs.find(
      (tab) =>
        tab.type === "channel" &&
        tab.channel !== undefined &&
        buildChannelTabKey(tab.channel) === key
    );
    if (existingTab) {
      set(chatPanelTabsAtom, (prev) => ({
        ...prev,
        tabs: prev.tabs.map((tab) =>
          tab.id === existingTab.id
            ? { ...tab, title: channel.name, channel }
            : tab
        ),
      }));
      set(activateChatPanelTabAtom, existingTab.id);
      return existingTab.id;
    }
    const tab = createChannelTab({ channel });
    set(appendAndActivateChatPanelTabAtom, { tab });
    return tab.id;
  }
);
openChannelInChatPanelTabAtom.debugLabel = "openChannelInChatPanelTab";

/** Open or focus the singleton Explore tab. */
export const openExploreInChatPanelTabAtom = atom(null, (get, set) => {
  const existingTab = get(chatPanelTabsAtom).tabs.find(
    (tab) => tab.type === "explore"
  );
  if (existingTab) {
    set(activateChatPanelTabAtom, existingTab.id);
    return existingTab.id;
  }
  const tab = createExploreTab();
  set(appendAndActivateChatPanelTabAtom, { tab });
  return tab.id;
});
openExploreInChatPanelTabAtom.debugLabel = "openExploreInChatPanelTab";
