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
  viewMode: string;
}

export interface ChatPanelContentState {
  showBenchmarkSessionGroupContent: boolean;
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
  viewMode,
}: UseChatPanelContentStateOptions): ChatPanelContentState {
  const showBenchmarkSessionGroupContent =
    active && contentMode === CHAT_PANEL_CONTENT_MODE.BENCHMARK_SESSION_GROUP;
  const showSessionContent =
    active &&
    !showBenchmarkSessionGroupContent &&
    contentMode === CHAT_PANEL_CONTENT_MODE.SESSION &&
    Boolean(currentSessionId);
  const showWorkItemContent =
    Boolean(selectedWorkItem) &&
    !showBenchmarkSessionGroupContent &&
    !showSessionContent;
  const showProjectContent =
    Boolean(selectedProject) &&
    !showBenchmarkSessionGroupContent &&
    !showSessionContent &&
    !showWorkItemContent;
  const showProjectOrgContent =
    Boolean(selectedProjectOrg) &&
    !showBenchmarkSessionGroupContent &&
    !showSessionContent &&
    !showWorkItemContent &&
    !showProjectContent;
  const showExploreContent =
    exploreOpen &&
    !showBenchmarkSessionGroupContent &&
    !showSessionContent &&
    !showWorkItemContent &&
    !showProjectContent &&
    !showProjectOrgContent;
  const showCloudOrgContent =
    Boolean(selectedCloudOrg) &&
    !showBenchmarkSessionGroupContent &&
    !showSessionContent &&
    !showWorkItemContent &&
    !showProjectContent &&
    !showProjectOrgContent &&
    !showExploreContent;
  const showWorkspaceOverviewContent =
    Boolean(selectedWorkspace) &&
    !showBenchmarkSessionGroupContent &&
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
    showBenchmarkSessionGroupContent ||
    showWorkItemContent ||
    showProjectContent ||
    showProjectOrgContent ||
    showExploreContent ||
    showCloudOrgContent ||
    showWorkspaceOverviewContent ||
    showExplicitNonSessionContent;
  const showHeader =
    showBenchmarkSessionGroupContent ||
    showWorkItemContent ||
    showProjectContent ||
    showProjectOrgContent ||
    showExploreContent ||
    showCloudOrgContent ||
    showWorkspaceOverviewContent ||
    showExplicitNonSessionContent ||
    (active && (showSessionContent || viewMode === "workStation"));

  return {
    showBenchmarkSessionGroupContent,
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
