import { useCallback, useMemo } from "react";

import type { ProjectOrg } from "@src/api/http/project";
import {
  type PrimarySidebarConfig,
  buildPrimarySidebarConfig,
} from "@src/modules/WorkStation/shared";
import {
  PROJECT_ORG_SURFACE_VIEW,
  STORY_ORG_SCOPE,
  normalizeProjectOrgSurfaceView,
} from "@src/store/workstation/tabs";
import type { ProjectOrgSurfaceView } from "@src/store/workstation/tabs";
import type { WorkStationTab } from "@src/store/workstation/tabs/types";

import ProjectManagerSidebar from "../../Panels/ProjectManagerSidebar";
import type { LinearProjectSelection } from "../../Panels/ProjectManagerSidebar/content/WorkspaceTreeContent";
import type { ActiveRepoView, SelectProjectHandler } from "../types";

interface UseProjectManagerSidebarConfigOptions {
  repoPath: string;
  repoName: string;
  activeTab: WorkStationTab | null;
  embeddedWorkItemDetailTabs: Record<string, boolean>;
  primarySidebarCollapsed: boolean;
  primarySidebarWidth: number;
  setPrimarySidebarWidth: (width: number) => void;
  setPrimarySidebarCollapsed: (collapsed: boolean) => void;
  onSelectProject: SelectProjectHandler;
  onCreateProject: () => void;
  onCreateWorkItem: () => void;
  onImportGithubIssuesProject: () => void;
  onCreateOrg: () => void;
  onImportOrgs: () => void;
  onOpenProjects: () => void;
  onOpenWorkItems: () => void;
  onOpenPersonalOrg: (view?: ProjectOrgSurfaceView) => void;
  onOpenProjectOrg: (org: ProjectOrg, view?: ProjectOrgSurfaceView) => void;
  onOpenLinearProjects: (selection?: LinearProjectSelection) => void;
  onOpenLinearWorkItems: (selection?: LinearProjectSelection) => void;
  onOpenRepoSettings: (section?: string) => void;
}

interface UseProjectManagerSidebarConfigReturn {
  activePrimarySidebarConfig: PrimarySidebarConfig;
}

export function shouldDisableProjectManagerSidebar(
  activeTab: Pick<WorkStationTab, "id" | "type"> | null,
  embeddedWorkItemDetailTabs: Record<string, boolean>
): boolean {
  return Boolean(
    activeTab?.type === "project-dashboard" ||
    activeTab?.type === "project-work-items" ||
    activeTab?.type === "workItem-detail" ||
    (activeTab && embeddedWorkItemDetailTabs[activeTab.id])
  );
}

export function useProjectManagerSidebarConfig({
  repoPath,
  repoName,
  activeTab,
  embeddedWorkItemDetailTabs,
  primarySidebarCollapsed,
  primarySidebarWidth,
  setPrimarySidebarWidth,
  setPrimarySidebarCollapsed,
  onSelectProject,
  onCreateProject,
  onCreateWorkItem,
  onImportGithubIssuesProject,
  onCreateOrg,
  onImportOrgs,
  onOpenProjects,
  onOpenWorkItems,
  onOpenPersonalOrg,
  onOpenProjectOrg,
  onOpenLinearProjects,
  onOpenLinearWorkItems,
  onOpenRepoSettings,
}: UseProjectManagerSidebarConfigOptions): UseProjectManagerSidebarConfigReturn {
  const selectedProjectId = (activeTab?.data.projectId as string) || null;
  const isLinearTab =
    activeTab?.type === "project-linear-projects" ||
    activeTab?.type === "project-linear-work-items";
  const activeLinearConnectionId = isLinearTab
    ? ((activeTab?.data.connectionId as string | undefined) ?? null)
    : null;
  const activeLinearProjectId = isLinearTab
    ? ((activeTab?.data.projectId as string | undefined) ?? null)
    : null;
  const activeLinearTeamId = isLinearTab
    ? ((activeTab?.data.teamId as string | undefined) ?? null)
    : null;

  const activeRepoView = getActiveRepoView(activeTab);
  const activeOrgScope = getActiveOrgScope(activeTab);
  const activeOrgHubId = getActiveOrgHubId(activeTab);

  const handleCloseSidebar = useCallback(() => {
    setPrimarySidebarCollapsed(true);
  }, [setPrimarySidebarCollapsed]);

  const primarySidebarConfig = useMemo(
    () =>
      buildPrimarySidebarConfig({
        content: (
          <ProjectManagerSidebar
            repoPath={repoPath}
            repoName={repoName}
            selectedProjectId={selectedProjectId}
            onSelectProject={onSelectProject}
            onCreateProject={onCreateProject}
            onCreateWorkItem={onCreateWorkItem}
            onImportGithubIssuesProject={onImportGithubIssuesProject}
            onCreateOrg={onCreateOrg}
            onImportOrgs={onImportOrgs}
            onOpenProjects={onOpenProjects}
            onOpenWorkItems={onOpenWorkItems}
            onOpenPersonalOrg={onOpenPersonalOrg}
            onOpenProjectOrg={onOpenProjectOrg}
            onOpenLinearProjects={onOpenLinearProjects}
            onOpenLinearWorkItems={onOpenLinearWorkItems}
            onOpenSettings={() => onOpenRepoSettings()}
            activeRepoView={activeRepoView}
            activeOrgScope={activeOrgScope}
            activeOrgHubId={activeOrgHubId}
            activeLinearConnectionId={activeLinearConnectionId}
            activeLinearProjectId={activeLinearProjectId}
            activeLinearTeamId={activeLinearTeamId}
          />
        ),
        collapsed: primarySidebarCollapsed,
        size: primarySidebarWidth,
        onSizeChange: setPrimarySidebarWidth,
        onClose: handleCloseSidebar,
        minSize: 200,
        maxSize: 400,
      }),
    [
      repoPath,
      repoName,
      selectedProjectId,
      onSelectProject,
      onCreateProject,
      onCreateWorkItem,
      onImportGithubIssuesProject,
      onCreateOrg,
      onImportOrgs,
      onOpenProjects,
      onOpenWorkItems,
      onOpenPersonalOrg,
      onOpenProjectOrg,
      onOpenLinearProjects,
      onOpenLinearWorkItems,
      onOpenRepoSettings,
      activeRepoView,
      activeOrgScope,
      activeOrgHubId,
      activeLinearConnectionId,
      activeLinearProjectId,
      activeLinearTeamId,
      primarySidebarCollapsed,
      primarySidebarWidth,
      setPrimarySidebarWidth,
      handleCloseSidebar,
    ]
  );

  const hiddenPrimarySidebarConfig = useMemo(
    () =>
      buildPrimarySidebarConfig({
        content: null,
        collapsed: true,
        size: 0,
        onSizeChange: setPrimarySidebarWidth,
        onClose: handleCloseSidebar,
        minSize: 0,
        maxSize: 0,
      }),
    [setPrimarySidebarWidth, handleCloseSidebar]
  );

  const activeTabHasNoSidebar = shouldDisableProjectManagerSidebar(
    activeTab,
    embeddedWorkItemDetailTabs
  );

  return {
    activePrimarySidebarConfig: activeTabHasNoSidebar
      ? hiddenPrimarySidebarConfig
      : primarySidebarConfig,
  };
}

function getActiveOrgScope(activeTab: WorkStationTab | null): string | null {
  const orgScope = activeTab?.data.orgScope as string | undefined;
  if (orgScope) return orgScope;
  if (
    activeTab?.type === "project-dashboard" ||
    activeTab?.type === "project-work-items"
  ) {
    return STORY_ORG_SCOPE.ALL;
  }
  return null;
}

function getActiveOrgHubId(activeTab: WorkStationTab | null): string | null {
  if (
    activeTab?.type === "project-org" ||
    activeTab?.type === "project-org-settings"
  ) {
    const orgId = activeTab.data.orgId;
    return typeof orgId === "string" && orgId ? orgId : null;
  }

  if (
    activeTab?.type === "project-dashboard" ||
    activeTab?.type === "project-work-items"
  ) {
    const orgScope = activeTab.data.orgScope;
    if (
      orgScope === STORY_ORG_SCOPE.PERSONAL_ORG ||
      orgScope === STORY_ORG_SCOPE.PROJECT_ORG
    ) {
      const orgId = activeTab.data.orgId;
      return typeof orgId === "string" && orgId ? orgId : null;
    }
  }

  return null;
}

function getActiveRepoView(activeTab: WorkStationTab | null): ActiveRepoView {
  switch (activeTab?.type) {
    case "project-dashboard":
      return "projects";
    case "project-work-items":
      return "work-items";
    case "project-linear-projects":
      return "linear-projects";
    case "project-linear-work-items":
      return "linear-work-items";
    case "project-settings":
      return "settings";
    case "project-org":
    case "project-org-settings": {
      const orgView = normalizeProjectOrgSurfaceView(activeTab.data.orgView);
      if (orgView === PROJECT_ORG_SURFACE_VIEW.PROJECTS) return "projects";
      if (orgView === PROJECT_ORG_SURFACE_VIEW.WORK_ITEMS) return "work-items";
      if (orgView === PROJECT_ORG_SURFACE_VIEW.SETTINGS) return "settings";
      return null;
    }
    default:
      return null;
  }
}
