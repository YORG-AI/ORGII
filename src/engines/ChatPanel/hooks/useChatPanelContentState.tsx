import React from "react";
import { useTranslation } from "react-i18next";

import { ChatPanelHeaderBreadcrumb } from "@src/engines/ChatPanel/header";
import {
  CHAT_PANEL_CONTENT_MODE,
  CHAT_PANEL_CREATE_TARGET,
  type ChatPanelContentMode,
  type ChatPanelCreateTarget,
  type ChatPanelSelectedCollabOrg,
  type ChatPanelSelectedProject,
  type ChatPanelSelectedProjectOrg,
  type ChatPanelSelectedWorkItem,
  type ChatPanelSelectedWorkspace,
} from "@src/store/ui/chatPanelAtom";

interface UseChatPanelContentStateOptions {
  active: boolean;
  contentMode: ChatPanelContentMode;
  createTarget: ChatPanelCreateTarget;
  currentSessionId: string | null;
  exploreOpen: boolean;
  manageIssuesOpen: boolean;
  isChatFocus: boolean;
  panelTitle: string;
  collabOrgHeaderTitle?: string;
  collabOrgHeaderTitleContent?: React.ReactNode;
  selectedCollabOrg: ChatPanelSelectedCollabOrg | null;
  selectedProject: ChatPanelSelectedProject | null;
  selectedProjectOrg: ChatPanelSelectedProjectOrg | null;
  selectedWorkItem: ChatPanelSelectedWorkItem | null;
  selectedWorkspace: ChatPanelSelectedWorkspace | null;
  workspaceDashboardOpen: boolean;
  showChatFocusToggle: boolean;
  sidebarCollapsed: boolean;
  sessionCreatorAvailable: boolean;
  sessionSidebarVisible: boolean;
  viewMode: string;
}

export interface ChatPanelContentState {
  headerTitle: string;
  headerTitleContent: React.ReactNode | undefined;
  isProjectTarget: boolean;
  isWorkItemTarget: boolean;
  showBenchmarkSessionGroupContent: boolean;
  showCollabOrgContent: boolean;
  showCreatorPresenceInHeader: boolean;
  showEmptyChatFocusRestoreButton: boolean;
  showExploreContent: boolean;
  showManageIssuesContent: boolean;
  showExplicitNonSessionContent: boolean;
  showHeader: boolean;
  showNewSessionButton: boolean;
  showNonSessionContent: boolean;
  showPanelContent: boolean;
  showProjectAgentSwitchInHeader: boolean;
  showProjectContent: boolean;
  showProjectOrgContent: boolean;
  showSessionContent: boolean;
  showWorkItemAgentSwitchInHeader: boolean;
  showWorkItemContent: boolean;
  showWorkspaceDashboardContent: boolean;
  showWorkspaceOverviewContent: boolean;
}

export function useChatPanelContentState({
  active,
  contentMode,
  createTarget,
  currentSessionId,
  exploreOpen,
  manageIssuesOpen,
  isChatFocus,
  panelTitle,
  collabOrgHeaderTitle,
  collabOrgHeaderTitleContent,
  selectedCollabOrg,
  selectedProject,
  selectedProjectOrg,
  selectedWorkItem,
  selectedWorkspace,
  workspaceDashboardOpen,
  showChatFocusToggle,
  sidebarCollapsed,
  sessionCreatorAvailable,
  sessionSidebarVisible,
  viewMode,
}: UseChatPanelContentStateOptions): ChatPanelContentState {
  const { t } = useTranslation([
    "sessions",
    "common",
    "projects",
    "navigation",
  ]);

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
  const showWorkspaceDashboardContent =
    workspaceDashboardOpen &&
    !showBenchmarkSessionGroupContent &&
    !showSessionContent &&
    !showWorkItemContent &&
    !showProjectContent &&
    !showProjectOrgContent;
  const showExploreContent =
    exploreOpen &&
    !showBenchmarkSessionGroupContent &&
    !showSessionContent &&
    !showWorkItemContent &&
    !showProjectContent &&
    !showProjectOrgContent &&
    !showWorkspaceDashboardContent;
  const showManageIssuesContent =
    manageIssuesOpen &&
    !showBenchmarkSessionGroupContent &&
    !showSessionContent &&
    !showWorkItemContent &&
    !showProjectContent &&
    !showProjectOrgContent &&
    !showWorkspaceDashboardContent &&
    !showExploreContent;
  const showCollabOrgContent =
    Boolean(selectedCollabOrg) &&
    !showBenchmarkSessionGroupContent &&
    !showSessionContent &&
    !showWorkItemContent &&
    !showProjectContent &&
    !showProjectOrgContent &&
    !showWorkspaceDashboardContent &&
    !showExploreContent &&
    !showManageIssuesContent;
  const showWorkspaceOverviewContent =
    Boolean(selectedWorkspace) &&
    !showBenchmarkSessionGroupContent &&
    !showSessionContent &&
    !showWorkItemContent &&
    !showProjectContent &&
    !showProjectOrgContent &&
    !showWorkspaceDashboardContent &&
    !showExploreContent &&
    !showManageIssuesContent &&
    !showCollabOrgContent;
  const showExplicitNonSessionContent =
    contentMode === CHAT_PANEL_CONTENT_MODE.NON_SESSION;
  const showNonSessionContent =
    !showBenchmarkSessionGroupContent &&
    !showWorkItemContent &&
    !showProjectContent &&
    !showProjectOrgContent &&
    !showWorkspaceDashboardContent &&
    !showExploreContent &&
    !showManageIssuesContent &&
    !showCollabOrgContent &&
    !showWorkspaceOverviewContent &&
    !showSessionContent;
  const showPanelContent =
    active ||
    showBenchmarkSessionGroupContent ||
    showWorkItemContent ||
    showProjectContent ||
    showProjectOrgContent ||
    showWorkspaceDashboardContent ||
    showExploreContent ||
    showManageIssuesContent ||
    showCollabOrgContent ||
    showWorkspaceOverviewContent ||
    showExplicitNonSessionContent;
  const showHeader =
    showBenchmarkSessionGroupContent ||
    showWorkItemContent ||
    showProjectContent ||
    showProjectOrgContent ||
    showWorkspaceDashboardContent ||
    showExploreContent ||
    showManageIssuesContent ||
    showCollabOrgContent ||
    showWorkspaceOverviewContent ||
    showExplicitNonSessionContent ||
    (active && (showSessionContent || viewMode === "workStation"));

  const workItemTitle = selectedWorkItem?.workItem.name || "Work item";
  const projectTitle = selectedProject?.project.name || t("projects.project");
  const projectOrgTitle =
    selectedProjectOrg?.orgName || t("projects:orgs.title");
  const workspaceTitle =
    selectedWorkspace?.name || t("navigation:labels.workspace");
  const headerTitle = showBenchmarkSessionGroupContent
    ? t("creator.benchmark.sessionGroupTitle")
    : selectedWorkItem
      ? currentSessionId
        ? `${workItemTitle} » ${panelTitle}`
        : workItemTitle
      : selectedProject
        ? projectTitle
        : selectedProjectOrg
          ? projectOrgTitle
          : showWorkspaceDashboardContent
            ? t("navigation:launchpad.dashboard")
            : showExploreContent
              ? t("navigation:explore.title", { defaultValue: "Explore" })
              : showManageIssuesContent
                ? t("chat.manageIssues.title")
                : showCollabOrgContent
                  ? (collabOrgHeaderTitle ??
                    t("navigation:collaboration.orgDemoTitle"))
                  : createTarget === CHAT_PANEL_CREATE_TARGET.COLLAB_ORG
                    ? t("navigation:collaboration.addOrg")
                    : selectedWorkspace
                      ? workspaceTitle
                      : panelTitle;

  const headerTitleContent =
    showWorkItemContent && selectedWorkItem ? (
      <ChatPanelHeaderBreadcrumb
        items={[
          {
            key: "org",
            label: selectedWorkItem.orgName || t("projects:orgs.personalOrg"),
          },
          {
            key: "project",
            label:
              selectedWorkItem.projectName ||
              selectedWorkItem.workItem.project?.name ||
              t("projects.dashboardTitle"),
          },
          {
            key: "work-item",
            label: workItemTitle,
          },
        ]}
      />
    ) : showProjectOrgContent && selectedProjectOrg ? (
      <ChatPanelHeaderBreadcrumb
        items={[{ key: "org", label: selectedProjectOrg.orgName }]}
      />
    ) : showCollabOrgContent && collabOrgHeaderTitleContent ? (
      collabOrgHeaderTitleContent
    ) : showWorkspaceDashboardContent ||
      showExploreContent ||
      showManageIssuesContent ||
      showCollabOrgContent ||
      showWorkspaceOverviewContent ? (
      <ChatPanelHeaderBreadcrumb
        items={[{ key: "surface", label: headerTitle }]}
      />
    ) : undefined;

  const showNewSessionButton =
    showSessionContent && sidebarCollapsed && !sessionSidebarVisible;
  const isProjectTarget = createTarget === CHAT_PANEL_CREATE_TARGET.PROJECT;
  const isWorkItemTarget = createTarget === CHAT_PANEL_CREATE_TARGET.WORK_ITEM;
  const isCollabOrgTarget =
    createTarget === CHAT_PANEL_CREATE_TARGET.COLLAB_ORG;
  const showCreatorPresenceInHeader =
    !showBenchmarkSessionGroupContent &&
    !showSessionContent &&
    !selectedWorkItem &&
    !selectedProject &&
    !selectedProjectOrg &&
    !selectedWorkspace &&
    !selectedCollabOrg &&
    !showExploreContent &&
    !showManageIssuesContent &&
    !isProjectTarget &&
    !isWorkItemTarget &&
    !isCollabOrgTarget;
  const showWorkItemAgentSwitchInHeader =
    showNonSessionContent &&
    !selectedWorkItem &&
    !selectedProject &&
    !selectedProjectOrg &&
    !selectedWorkspace &&
    !selectedCollabOrg &&
    !showExploreContent &&
    !showManageIssuesContent &&
    isWorkItemTarget &&
    sessionCreatorAvailable;
  const showProjectAgentSwitchInHeader =
    showNonSessionContent &&
    !selectedWorkItem &&
    !selectedProject &&
    !selectedProjectOrg &&
    !selectedWorkspace &&
    !selectedCollabOrg &&
    !showExploreContent &&
    !showManageIssuesContent &&
    isProjectTarget &&
    sessionCreatorAvailable;
  const showEmptyChatFocusRestoreButton =
    !showBenchmarkSessionGroupContent &&
    !showSessionContent &&
    !selectedWorkItem &&
    !selectedProject &&
    !selectedProjectOrg &&
    !selectedWorkspace &&
    !selectedCollabOrg &&
    !showExploreContent &&
    !showManageIssuesContent &&
    isChatFocus &&
    showChatFocusToggle;

  return {
    headerTitle,
    headerTitleContent,
    isProjectTarget,
    isWorkItemTarget,
    showBenchmarkSessionGroupContent,
    showCollabOrgContent,
    showCreatorPresenceInHeader,
    showEmptyChatFocusRestoreButton,
    showExploreContent,
    showManageIssuesContent,
    showExplicitNonSessionContent,
    showHeader,
    showNewSessionButton,
    showNonSessionContent,
    showPanelContent,
    showProjectAgentSwitchInHeader,
    showProjectContent,
    showProjectOrgContent,
    showSessionContent,
    showWorkItemAgentSwitchInHeader,
    showWorkItemContent,
    showWorkspaceDashboardContent,
    showWorkspaceOverviewContent,
  };
}
