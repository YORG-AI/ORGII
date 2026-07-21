import { useSetAtom } from "jotai";
import React, { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { PROJECT_ORG_SYNC_PROVIDER } from "@src/api/http/project";
import {
  WIZARD_IDS,
  buildIntegrationsPath,
  buildWizardPath,
} from "@src/config/mainAppPaths";
import {
  usePrimarySidebarState,
  useWorkStationTabShortcutBridge,
  useWorkStationTabs,
} from "@src/hooks/workStation";
import { WorkStationShell } from "@src/modules/WorkStation/shared";
import { openCreateTargetInChatPanelStartPageAtom } from "@src/store/chatPanel/chatPanelTabsAtom";
import { projectListRefreshAtom } from "@src/store/project/projectAtom";
import {
  CHAT_PANEL_CREATE_TARGET,
  activeStationChatVisibleAtom,
} from "@src/store/ui/chatPanelAtom";
import { stationModeAtom } from "@src/store/ui/simulatorAtom";
import { projectStatusBarCallbacksAtom } from "@src/store/ui/workStationAtom";
import {
  STORY_ORG_SCOPE,
  getProjectWorkItemsTabChrome,
  getWorkItemDetailTabChrome,
  workstationProjectTabBarAtom,
} from "@src/store/workstation";

import type { EmbeddedWorkItemDetailState } from "../WorkItems";
import { ProjectManagerContentRouter } from "./components/ProjectManagerContentRouter";
import {
  type ProjectHostContextValue,
  ProjectHostProvider,
} from "./context/projectHostContext";
import { useProjectManagerSidebarConfig } from "./hooks/useProjectManagerSidebarConfig";
import { useProjectStatusBar } from "./hooks/useProjectStatusBar";
import { useProjectTabActions } from "./hooks/useProjectTabActions";
import type { ProjectManagerLayoutProps } from "./types";

export type { ProjectManagerLayoutProps } from "./types";

export const ProjectManagerLayout: React.FC<ProjectManagerLayoutProps> = memo(
  ({ repoPath, repoName }) => {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const openCreateTargetInStartPage = useSetAtom(
      openCreateTargetInChatPanelStartPageAtom
    );

    const {
      layoutMode,
      primarySidebarCollapsed,
      primarySidebarWidth,
      setPrimarySidebarWidth,
      setPrimarySidebarCollapsed,
      togglePrimarySidebar,
    } = usePrimarySidebarState();

    const {
      tabs,
      activeTab,
      openTab,
      closeTab,
      setTabUnsaved,
      updateTabData,
      updateTabMeta,
    } = useWorkStationTabs();

    const handleCloseTab = useCallback(
      async (tabId: string) => {
        const tabToClose = tabs.find((tab) => tab.id === tabId);
        if (tabToClose?.hasUnsavedChanges) {
          const { ask } = await import("@tauri-apps/plugin-dialog");
          const confirmed = await ask(
            `"${tabToClose.title}" has unsaved changes. Discard them and close?`,
            {
              title: t("workstation.unsavedChangesTitle"),
              kind: "warning",
              okLabel: t("actions.discard"),
              cancelLabel: t("actions.cancel"),
            }
          );
          if (!confirmed) return;
        }
        closeTab(tabId);
      },
      [tabs, closeTab, t]
    );

    const activeProjectSlug =
      activeTab?.type === "project-workitems"
        ? (activeTab.data.projectSlug as string | undefined)
        : undefined;
    const activeProjectOrgId =
      activeTab?.data.orgScope === STORY_ORG_SCOPE.PROJECT_ORG &&
      typeof activeTab.data.orgId === "string"
        ? activeTab.data.orgId
        : undefined;
    const activeProjectOrgName =
      activeTab?.data.orgScope === STORY_ORG_SCOPE.PROJECT_ORG &&
      typeof activeTab.data.orgName === "string"
        ? activeTab.data.orgName
        : undefined;
    const activeProjectOrgGitFolderSyncEnabled =
      activeTab?.data.orgScope === STORY_ORG_SCOPE.PROJECT_ORG &&
      activeTab.data.orgSyncProvider === PROJECT_ORG_SYNC_PROVIDER.GIT_FOLDER;

    useProjectStatusBar({
      activeTabType: activeTab?.type,
      projectSlug: activeProjectSlug,
      projectOrgId: activeProjectOrgId,
      projectOrgName: activeProjectOrgName,
      projectOrgGitFolderSyncEnabled: activeProjectOrgGitFolderSyncEnabled,
    });

    const setProjectStatusBarCallbacks = useSetAtom(
      projectStatusBarCallbacksAtom
    );
    useEffect(() => {
      setProjectStatusBarCallbacks((prev) => ({
        ...prev,
        primaryPanelCollapsed: primarySidebarCollapsed,
        onTogglePrimaryPanel: togglePrimarySidebar,
      }));
      return () => {
        setProjectStatusBarCallbacks((prev) => ({
          ...prev,
          primaryPanelCollapsed: undefined,
          onTogglePrimaryPanel: undefined,
        }));
      };
    }, [
      primarySidebarCollapsed,
      setProjectStatusBarCallbacks,
      togglePrimarySidebar,
    ]);

    const bumpProjectListRefresh = useSetAtom(projectListRefreshAtom);
    const setStationMode = useSetAtom(stationModeAtom);
    const setStationChatVisible = useSetAtom(activeStationChatVisibleAtom);
    const handleProjectListRefreshRequested = useCallback(() => {
      bumpProjectListRefresh((prev) => prev + 1);
    }, [bumpProjectListRefresh]);

    const [embeddedWorkItemDetailTabs, setEmbeddedWorkItemDetailTabs] =
      useState<Record<string, boolean>>({});

    const {
      handleSelectProject,
      handleCreateProject,
      handleCreateWorkItem,
      handleOpenProjects,
      handleOpenWorkItems,
      handleOpenPersonalOrg,
      handleOpenProjectOrg,
      handleOpenLinearProjects,
      handleOpenLinearWorkItems,
      handleOpenRepoSettings,
      handleExpandWorkItemToTab,
      handleOpenChatSession,
      projectQuickActions,
    } = useProjectTabActions({
      tabs,
      activeTab,
      openTab,
      closeTab,
      primarySidebarCollapsed,
    });

    const handleEmbeddedWorkItemDetailStateChange = useCallback(
      (
        tabId: string,
        state: EmbeddedWorkItemDetailState,
        projectName: string
      ) => {
        const showingEmbeddedDetail = state.view === "workItemDetail";
        setEmbeddedWorkItemDetailTabs((prev) => {
          if (prev[tabId] === showingEmbeddedDetail) return prev;
          return { ...prev, [tabId]: showingEmbeddedDetail };
        });
        if (state.view === "workItemDetail") {
          updateTabMeta(tabId, getWorkItemDetailTabChrome(state.workItemName));
          return;
        }

        updateTabMeta(
          tabId,
          state.parentChrome ?? getProjectWorkItemsTabChrome(projectName)
        );
      },
      [updateTabMeta]
    );

    const handleWorkStationCloseActiveProjectTab = useCallback(() => {
      if (activeTab) void handleCloseTab(activeTab.id);
    }, [activeTab, handleCloseTab]);

    // ⌘T is owned exclusively by the unified `+` menu (TabBarPlusMenu),
    // which Project mode does not surface. Only the close shortcut is
    // bridged here; `handleCreateProject` is still surfaced via the
    // ProjectManager trailing tab-bar action.
    useWorkStationTabShortcutBridge({
      enabled: true,
      onCloseActiveTab: handleWorkStationCloseActiveProjectTab,
    });

    const setWorkstationProjectTabBar = useSetAtom(
      workstationProjectTabBarAtom
    );
    useEffect(() => {
      setWorkstationProjectTabBar({ onAddProject: handleCreateProject });
      return () => setWorkstationProjectTabBar(null);
    }, [handleCreateProject, setWorkstationProjectTabBar]);

    const handleImportOrgs = useCallback(() => {
      navigate(
        buildWizardPath(
          buildIntegrationsPath({ category: "connections" }),
          WIZARD_IDS.CHANNEL_ADD
        )
      );
    }, [navigate]);

    const handleCreateOrg = useCallback(() => {
      openCreateTargetInStartPage({
        target: CHAT_PANEL_CREATE_TARGET.COLLAB_ORG,
        title: t("navigation:routes.launchpad"),
      });
      setStationMode("my-station");
      setStationChatVisible("my-station", true);
    }, [openCreateTargetInStartPage, setStationChatVisible, setStationMode, t]);

    const handleImportGithubIssuesProject = useCallback(() => {
      openCreateTargetInStartPage({
        target: CHAT_PANEL_CREATE_TARGET.GITHUB_ISSUES_PROJECT,
      });
      setStationMode("my-station");
      setStationChatVisible("my-station", true);
    }, [openCreateTargetInStartPage, setStationChatVisible, setStationMode]);

    const { activePrimarySidebarConfig } = useProjectManagerSidebarConfig({
      repoPath,
      repoName,
      activeTab,
      embeddedWorkItemDetailTabs,
      primarySidebarCollapsed,
      primarySidebarWidth,
      setPrimarySidebarWidth,
      setPrimarySidebarCollapsed,
      onSelectProject: handleSelectProject,
      onCreateProject: handleCreateProject,
      onCreateWorkItem: handleCreateWorkItem,
      onImportGithubIssuesProject: handleImportGithubIssuesProject,
      onCreateOrg: handleCreateOrg,
      onImportOrgs: handleImportOrgs,
      onOpenProjects: handleOpenProjects,
      onOpenWorkItems: handleOpenWorkItems,
      onOpenPersonalOrg: handleOpenPersonalOrg,
      onOpenProjectOrg: handleOpenProjectOrg,
      onOpenLinearProjects: handleOpenLinearProjects,
      onOpenLinearWorkItems: handleOpenLinearWorkItems,
      onOpenRepoSettings: handleOpenRepoSettings,
    });

    // Phase 2.1: publish the Project host's action surface above the tab
    // dispatcher. The value mirrors the content-router props (minus tabs/
    // activeTab) so staged project renderers can consume it via
    // `useProjectHostContext` once `UnifiedTabContent` is mounted for project
    // tabs. Providing it here is additive — the router below still receives
    // its props directly and renders unchanged.
    const projectHostValue = useMemo<ProjectHostContextValue>(
      () => ({
        repoPath,
        repoName,
        projectQuickActions,
        onSelectProject: handleSelectProject,
        onCreateProject: handleCreateProject,
        onCreateWorkItem: handleCreateWorkItem,
        onOpenProjects: handleOpenProjects,
        onOpenLinearProjects: handleOpenLinearProjects,
        onOpenRepoSettings: handleOpenRepoSettings,
        onExpandWorkItemToTab: handleExpandWorkItemToTab,
        onOpenChatSession: handleOpenChatSession,
        onCloseTab: closeTab,
        onUpdateTabData: updateTabData,
        onUpdateTabMeta: updateTabMeta,
        onSetTabUnsaved: setTabUnsaved,
        onEmbeddedWorkItemDetailStateChange:
          handleEmbeddedWorkItemDetailStateChange,
        onProjectListRefreshRequested: handleProjectListRefreshRequested,
      }),
      [
        repoPath,
        repoName,
        projectQuickActions,
        handleSelectProject,
        handleCreateProject,
        handleCreateWorkItem,
        handleOpenProjects,
        handleOpenLinearProjects,
        handleOpenRepoSettings,
        handleExpandWorkItemToTab,
        handleOpenChatSession,
        closeTab,
        updateTabData,
        updateTabMeta,
        setTabUnsaved,
        handleEmbeddedWorkItemDetailStateChange,
        handleProjectListRefreshRequested,
      ]
    );

    const mainContent = (
      <ProjectManagerContentRouter
        repoPath={repoPath}
        tabs={tabs}
        activeTab={activeTab}
        projectQuickActions={projectQuickActions}
        onSelectProject={handleSelectProject}
        onCreateProject={handleCreateProject}
        onCreateWorkItem={handleCreateWorkItem}
        onOpenProjects={handleOpenProjects}
        onOpenLinearProjects={handleOpenLinearProjects}
        onOpenRepoSettings={handleOpenRepoSettings}
        onExpandWorkItemToTab={handleExpandWorkItemToTab}
        onOpenChatSession={handleOpenChatSession}
        onCloseTab={closeTab}
        onUpdateTabData={updateTabData}
        onUpdateTabMeta={updateTabMeta}
        onSetTabUnsaved={setTabUnsaved}
        onEmbeddedWorkItemDetailStateChange={
          handleEmbeddedWorkItemDetailStateChange
        }
        onProjectListRefreshRequested={handleProjectListRefreshRequested}
      />
    );

    return (
      <ProjectHostProvider value={projectHostValue}>
        <WorkStationShell
          primarySidebarConfig={activePrimarySidebarConfig}
          content={mainContent}
          statusBar={null}
          layoutMode={layoutMode}
          appClassName="project-manager"
        />
      </ProjectHostProvider>
    );
  }
);

ProjectManagerLayout.displayName = "ProjectManagerLayout";

export default ProjectManagerLayout;
