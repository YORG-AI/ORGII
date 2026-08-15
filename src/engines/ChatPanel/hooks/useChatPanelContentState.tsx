import {
  CHAT_PANEL_CONTENT_MODE,
  type ChatPanelContentMode,
  type ChatPanelSelectedCloudOrg,
  type ChatPanelSelectedProject,
  type ChatPanelSelectedProjectOrg,
  type ChatPanelSelectedWorkItem,
  type ChatPanelSelectedWorkspace,
} from "@src/store/ui/chatPanelAtom";

interface UseChatPanelContentStateOptions {
  active: boolean;
  contentMode: ChatPanelContentMode;
  currentSessionId: string | null;
  exploreOpen: boolean;
  selectedCloudOrg: ChatPanelSelectedCloudOrg | null;
  selectedProject: ChatPanelSelectedProject | null;
  selectedProjectOrg: ChatPanelSelectedProjectOrg | null;
  selectedWorkItem: ChatPanelSelectedWorkItem | null;
  selectedWorkspace: ChatPanelSelectedWorkspace | null;
}

export interface ChatPanelContentState {
  showCloudOrgContent: boolean;
  showExploreContent: boolean;
  showExplicitNonSessionContent: boolean;
  showHeader: boolean;
  showPanelContent: boolean;
  showProjectContent: boolean;
  showProjectOrgContent: boolean;
  showSessionContent: boolean;
  showWorkItemContent: boolean;
  showWorkspaceOverviewContent: boolean;
}

export function useChatPanelContentState({
  active,
  contentMode,
  currentSessionId,
  exploreOpen,
  selectedCloudOrg,
  selectedProject,
  selectedProjectOrg,
  selectedWorkItem,
  selectedWorkspace,
}: UseChatPanelContentStateOptions): ChatPanelContentState {
  const showSessionContent =
    active &&
    contentMode === CHAT_PANEL_CONTENT_MODE.SESSION &&
    Boolean(currentSessionId);
  const showWorkItemContent = Boolean(selectedWorkItem) && !showSessionContent;
  const showProjectContent =
    Boolean(selectedProject) && !showSessionContent && !showWorkItemContent;
  const showProjectOrgContent =
    Boolean(selectedProjectOrg) &&
    !showSessionContent &&
    !showWorkItemContent &&
    !showProjectContent;
  const showExploreContent =
    exploreOpen &&
    !showSessionContent &&
    !showWorkItemContent &&
    !showProjectContent &&
    !showProjectOrgContent;
  const showCloudOrgContent =
    Boolean(selectedCloudOrg) &&
    !showSessionContent &&
    !showWorkItemContent &&
    !showProjectContent &&
    !showProjectOrgContent &&
    !showExploreContent;
  const showWorkspaceOverviewContent =
    Boolean(selectedWorkspace) &&
    !showSessionContent &&
    !showWorkItemContent &&
    !showProjectContent &&
    !showProjectOrgContent &&
    !showExploreContent &&
    !showCloudOrgContent;
  const showExplicitNonSessionContent =
    contentMode === CHAT_PANEL_CONTENT_MODE.NON_SESSION;
  const showPanelContent =
    active ||
    showWorkItemContent ||
    showProjectContent ||
    showProjectOrgContent ||
    showExploreContent ||
    showCloudOrgContent ||
    showWorkspaceOverviewContent ||
    showExplicitNonSessionContent;
  const showHeader =
    showWorkItemContent ||
    showProjectContent ||
    showProjectOrgContent ||
    showExploreContent ||
    showCloudOrgContent ||
    showWorkspaceOverviewContent ||
    showExplicitNonSessionContent ||
    active;

  return {
    showCloudOrgContent,
    showExploreContent,
    showExplicitNonSessionContent,
    showHeader,
    showPanelContent,
    showProjectContent,
    showProjectOrgContent,
    showSessionContent,
    showWorkItemContent,
    showWorkspaceOverviewContent,
  };
}
