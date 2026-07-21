/**
 * useProjectTabActions
 *
 * Centralizes all tab-related action callbacks for ProjectManagerLayout:
 * - Opening projects / project / settings / workItem tabs
 * - Opening chat-panel project and work item creators
 * - Expanding a work item into its own detail tab
 * - Sidebar toggle
 * - Draft cleanup when create surfaces close
 */
import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { ProjectOrg } from "@src/api/http/project";
import type { QuickAction } from "@src/modules/WorkStation/shared";
import { openCreateTargetInChatPanelStartPageAtom } from "@src/store/chatPanel/chatPanelTabsAtom";
import {
  CHAT_PANEL_CREATE_TARGET,
  activeStationChatVisibleAtom,
} from "@src/store/ui/chatPanelAtom";
import { stationModeAtom } from "@src/store/ui/simulatorAtom";
import { workStationPrimarySidebarCollapsedPersistAtom } from "@src/store/ui/workStationAtom";
import {
  PROJECT_CREATOR_DRAFT_ID,
  WORK_ITEM_CREATOR_DRAFT_ID,
  projectDraftsAtom,
  removeProjectDraftAtom,
  removeWorkItemDraftAtom,
  workItemDraftsAtom,
} from "@src/store/workstation/projectManager";
import {
  PROJECT_ORG_SURFACE_VIEW,
  STORY_ORG_SCOPE,
  STORY_PERSONAL_ORG_FILTER_ID,
  STORY_PERSONAL_ORG_NAME,
  createChatSessionTab,
  createProjectDashboardTab,
  createProjectLinearProjectsTab,
  createProjectLinearWorkItemsTab,
  createProjectOrgTab,
  createProjectSettingsTab,
  createProjectWorkItemsIndexTab,
  createProjectWorkItemsTab,
  createWorkItemDetailTab,
  workstationLayoutAtom,
} from "@src/store/workstation/tabs";
import type { ProjectOrgSurfaceView } from "@src/store/workstation/tabs";
import type { WorkStationTab } from "@src/store/workstation/tabs/types";

import type { LinearProjectSelection } from "../../Panels/ProjectManagerSidebar/content/WorkspaceTreeContent";
import { createProjectQuickActions } from "../config";

interface UseProjectTabActionsOptions {
  tabs: WorkStationTab[];
  activeTab: WorkStationTab | null;
  openTab: (tab: WorkStationTab) => void;
  closeTab: (tabId: string) => void;
  primarySidebarCollapsed: boolean;
}

export function useProjectTabActions({
  tabs,
  activeTab,
  openTab,
  closeTab: _closeTab,
  primarySidebarCollapsed,
}: UseProjectTabActionsOptions) {
  const { t } = useTranslation();

  // --- Draft cleanup: remove orphaned drafts when create tabs are closed ---
  const projectDrafts = useAtomValue(projectDraftsAtom);
  const workItemDrafts = useAtomValue(workItemDraftsAtom);
  const removeProjectDraft = useSetAtom(removeProjectDraftAtom);
  const removeWorkItemDraft = useSetAtom(removeWorkItemDraftAtom);

  useEffect(() => {
    const liveProjectDraftIds = new Set(tabs.map((tab) => tab.id));
    liveProjectDraftIds.add(PROJECT_CREATOR_DRAFT_ID);

    const liveWorkItemDraftIds = new Set(tabs.map((tab) => tab.id));
    liveWorkItemDraftIds.add(WORK_ITEM_CREATOR_DRAFT_ID);

    for (const draftTabId of projectDrafts.keys()) {
      if (!liveProjectDraftIds.has(draftTabId)) {
        removeProjectDraft(draftTabId);
      }
    }

    for (const draftTabId of workItemDrafts.keys()) {
      if (!liveWorkItemDraftIds.has(draftTabId)) {
        removeWorkItemDraft(draftTabId);
      }
    }
  }, [
    tabs,
    projectDrafts,
    workItemDrafts,
    removeProjectDraft,
    removeWorkItemDraft,
  ]);

  const stationMode = useAtomValue(stationModeAtom);
  const setStationChatVisible = useSetAtom(activeStationChatVisibleAtom);
  const openCreateTargetInStartPage = useSetAtom(
    openCreateTargetInChatPanelStartPageAtom
  );
  const setLayout = useSetAtom(workstationLayoutAtom);

  /**
   * Project-manager "navigate-in-place" pattern: clicking a sidebar
   * entry replaces the currently active project tab (when the active
   * tab is itself a project tab without unsaved changes), instead of
   * piling up new tabs.
   *
   * After collapsing the workstation to a single tab pool, the
   * replacement only applies when the active tab actually belongs to
   * the project surface (`category === "project"`); for any other
   * active tab (file, browser session, etc.) the project tab is just
   * appended.
   */
  const navigateWorkspaceTab = useCallback(
    (targetTab: WorkStationTab) => {
      setLayout((previousLayout) => {
        const previousState = previousLayout.mainPane;

        const existingTarget = previousState.tabs.find(
          (tab) => tab.id === targetTab.id
        );
        if (existingTarget) {
          return {
            ...previousLayout,
            mainPane: {
              ...previousState,
              tabs: previousState.tabs.map((tab) =>
                tab.id === targetTab.id ? targetTab : tab
              ),
              activeTabId: targetTab.id,
            },
          };
        }

        const activeTab = previousState.tabs.find(
          (tab) => tab.id === previousState.activeTabId
        );
        const replaceInPlace =
          activeTab &&
          activeTab.category === "project" &&
          !activeTab.hasUnsavedChanges;

        if (replaceInPlace) {
          return {
            ...previousLayout,
            mainPane: {
              tabs: previousState.tabs.map((tab) =>
                tab.id === activeTab.id ? targetTab : tab
              ),
              activeTabId: targetTab.id,
            },
          };
        }

        return {
          ...previousLayout,
          mainPane: {
            tabs: [...previousState.tabs, targetTab],
            activeTabId: targetTab.id,
          },
        };
      });
    },
    [setLayout]
  );

  // --- Tab action handlers ---

  const activeProjectOrg = useMemo(() => {
    if (
      activeTab?.data.orgScope === STORY_ORG_SCOPE.PERSONAL_ORG ||
      activeTab?.data.orgScope === STORY_ORG_SCOPE.PROJECT_ORG
    ) {
      return {
        orgScope: activeTab.data.orgScope,
        orgId: activeTab.data.orgId as string | undefined,
        orgName: activeTab.data.orgName as string | undefined,
        orgSyncProvider: activeTab.data.orgSyncProvider as
          | string
          | null
          | undefined,
      };
    }
    return undefined;
  }, [activeTab]);

  const handleSelectProject = useCallback(
    (projectId: string, projectName: string, projectSlug?: string) => {
      openTab(
        createProjectWorkItemsTab(
          projectId,
          projectName,
          projectSlug,
          undefined,
          activeProjectOrg
        )
      );
    },
    [activeProjectOrg, openTab]
  );

  const handleCreateProject = useCallback(() => {
    openCreateTargetInStartPage({
      target: CHAT_PANEL_CREATE_TARGET.PROJECT,
      createProjectContext: {
        orgId: activeProjectOrg?.orgId ?? STORY_PERSONAL_ORG_FILTER_ID,
        scopeBreadcrumbLabel:
          activeProjectOrg?.orgName ?? t("projects:orgs.personalOrg"),
      },
    });
    if (stationMode === "my-station" || stationMode === "agent-station") {
      setStationChatVisible(stationMode, true);
    }
  }, [
    activeProjectOrg,
    openCreateTargetInStartPage,
    setStationChatVisible,
    stationMode,
    t,
  ]);

  const handleCreateWorkItem = useCallback(
    (_projectId?: string, _projectName?: string, _projectSlug?: string) => {
      openCreateTargetInStartPage({
        target: CHAT_PANEL_CREATE_TARGET.WORK_ITEM,
      });
      if (stationMode === "my-station" || stationMode === "agent-station") {
        setStationChatVisible(stationMode, true);
      }
    },
    [openCreateTargetInStartPage, setStationChatVisible, stationMode]
  );

  const handleOpenProjects = useCallback(() => {
    navigateWorkspaceTab(
      createProjectDashboardTab({ orgScope: STORY_ORG_SCOPE.ALL })
    );
  }, [navigateWorkspaceTab]);

  const handleOpenWorkItems = useCallback(() => {
    navigateWorkspaceTab(
      createProjectWorkItemsIndexTab({ orgScope: STORY_ORG_SCOPE.ALL })
    );
  }, [navigateWorkspaceTab]);

  const handleOpenPersonalOrg = useCallback(
    (view: ProjectOrgSurfaceView = PROJECT_ORG_SURFACE_VIEW.WORK_ITEMS) => {
      navigateWorkspaceTab(
        createProjectOrgTab(
          {
            id: STORY_PERSONAL_ORG_FILTER_ID,
            name: STORY_PERSONAL_ORG_NAME,
          },
          view,
          STORY_ORG_SCOPE.PERSONAL_ORG
        )
      );
    },
    [navigateWorkspaceTab]
  );

  const handleOpenProjectOrg = useCallback(
    (
      org: ProjectOrg,
      view: ProjectOrgSurfaceView = PROJECT_ORG_SURFACE_VIEW.WORK_ITEMS
    ) => {
      navigateWorkspaceTab(
        createProjectOrgTab(
          {
            id: org.id,
            name: org.name,
            sync_provider: org.sync_provider,
          },
          view,
          STORY_ORG_SCOPE.PROJECT_ORG
        )
      );
    },
    [navigateWorkspaceTab]
  );

  const handleOpenPersonalOrgProjects = useCallback(() => {
    handleOpenPersonalOrg(PROJECT_ORG_SURFACE_VIEW.PROJECTS);
  }, [handleOpenPersonalOrg]);

  const handleOpenPersonalOrgWorkItems = useCallback(() => {
    handleOpenPersonalOrg(PROJECT_ORG_SURFACE_VIEW.WORK_ITEMS);
  }, [handleOpenPersonalOrg]);

  const handleOpenProjectOrgProjects = useCallback(
    (org: ProjectOrg) => {
      handleOpenProjectOrg(org, PROJECT_ORG_SURFACE_VIEW.PROJECTS);
    },
    [handleOpenProjectOrg]
  );

  const handleOpenProjectOrgWorkItems = useCallback(
    (org: ProjectOrg) => {
      handleOpenProjectOrg(org, PROJECT_ORG_SURFACE_VIEW.WORK_ITEMS);
    },
    [handleOpenProjectOrg]
  );

  const handleOpenProjectOrgSettings = useCallback(
    (org: ProjectOrg) => {
      handleOpenProjectOrg(org, PROJECT_ORG_SURFACE_VIEW.SETTINGS);
    },
    [handleOpenProjectOrg]
  );

  const handleOpenLinearProjects = useCallback(
    (selection?: LinearProjectSelection) => {
      navigateWorkspaceTab(
        createProjectLinearProjectsTab({
          connectionId: selection?.connectionId,
          projectId: selection?.projectId,
          projectName: selection?.projectName,
          teamId: selection?.teamId,
          teamName: selection?.teamName,
        })
      );
    },
    [navigateWorkspaceTab]
  );

  const handleOpenLinearWorkItems = useCallback(
    (selection?: LinearProjectSelection) => {
      navigateWorkspaceTab(
        createProjectLinearWorkItemsTab({
          connectionId: selection?.connectionId,
          projectId: selection?.projectId,
          projectName: selection?.projectName,
          teamId: selection?.teamId,
          teamName: selection?.teamName,
        })
      );
    },
    [navigateWorkspaceTab]
  );

  const handleOpenRepoSettings = useCallback(
    (section?: string) => {
      navigateWorkspaceTab(createProjectSettingsTab(section));
    },
    [navigateWorkspaceTab]
  );

  const handleExpandWorkItemToTab = useCallback(
    (
      projectId: string | undefined,
      projectName: string | undefined,
      projectSlug: string | undefined,
      workItemId: string,
      workItemName: string,
      pendingUpdates?: Record<string, unknown>
    ) => {
      openTab(
        createWorkItemDetailTab(
          projectId,
          projectName,
          workItemId,
          workItemName,
          projectSlug,
          pendingUpdates,
          activeTab?.id
        )
      );
    },
    [activeTab?.id, openTab]
  );

  const handleOpenChatSession = useCallback(
    (
      sessionId: string,
      title?: string,
      workItemId?: string,
      workItemShortId?: string
    ) => {
      const tabTitle = title || `Chat: ${sessionId.slice(0, 12)}`;
      openTab(
        createChatSessionTab(sessionId, tabTitle, workItemId, workItemShortId)
      );
    },
    [openTab]
  );

  // --- Sidebar toggle ---

  const setLeftCollapsed = useSetAtom(
    workStationPrimarySidebarCollapsedPersistAtom
  );
  const handleToggleSidebar = useCallback(() => {
    setLeftCollapsed("toggle");
  }, [setLeftCollapsed]);

  // --- Quick actions for placeholder ---

  const handleCreateWorkItemNoProject = useCallback(() => {
    handleCreateWorkItem();
  }, [handleCreateWorkItem]);

  const projectQuickActions: QuickAction[] = useMemo(
    () =>
      createProjectQuickActions({
        t,
        sidebarCollapsed: primarySidebarCollapsed,
        onToggleSidebar: handleToggleSidebar,
        onOpenProjects: handleOpenProjects,
        onOpenWorkItems: handleOpenWorkItems,
        onCreateProject: handleCreateProject,
        onCreateWorkItem: handleCreateWorkItemNoProject,
      }),
    [
      t,
      primarySidebarCollapsed,
      handleToggleSidebar,
      handleOpenProjects,
      handleOpenWorkItems,
      handleCreateProject,
      handleCreateWorkItemNoProject,
    ]
  );

  return {
    handleSelectProject,
    handleCreateProject,
    handleCreateWorkItem,
    handleOpenProjects,
    handleOpenWorkItems,
    handleOpenPersonalOrg,
    handleOpenProjectOrg,
    handleOpenPersonalOrgProjects,
    handleOpenPersonalOrgWorkItems,
    handleOpenProjectOrgProjects,
    handleOpenProjectOrgWorkItems,
    handleOpenProjectOrgSettings,
    handleOpenLinearProjects,
    handleOpenLinearWorkItems,
    handleOpenRepoSettings,
    handleExpandWorkItemToTab,
    handleOpenChatSession,
    handleToggleSidebar,
    projectQuickActions,
  };
}
