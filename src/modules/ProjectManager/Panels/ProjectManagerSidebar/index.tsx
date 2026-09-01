/**
 * ProjectManagerSidebar
 *
 * Left sidebar for the Project Manager tool.
 */
import React, { memo, useCallback, useMemo, useState } from "react";

import type { ProjectOrg } from "@src/api/http/project";
import { useAllRepoProjects } from "@src/hooks/project";
import { PrimarySidebarLayout } from "@src/modules/WorkStation/shared";

import type { LinearProjectSelection } from "./content/WorkspaceTreeContent";
import { useProjectsTabConfig } from "./tabs/ProjectsTab";

interface ProjectManagerSidebarProps {
  repoPath: string;
  repoName: string;
  selectedProjectId: string | null;
  onSelectProject: (
    projectId: string,
    projectName: string,
    projectSlug?: string
  ) => void;
  onCreateProject: () => void;
  onCreateWorkItem: () => void;
  onImportGithubIssuesProject: () => void;
  onCreateOrg: () => void;
  onImportOrgs: () => void;
  onOpenProjects: () => void;
  onOpenWorkItems: () => void;
  onOpenPersonalOrg: (
    view?: import("@src/store/workstation/tabs").ProjectOrgSurfaceView
  ) => void;
  onOpenProjectOrg: (
    org: ProjectOrg,
    view?: import("@src/store/workstation/tabs").ProjectOrgSurfaceView
  ) => void;
  onOpenLinearProjects: (selection?: LinearProjectSelection) => void;
  onOpenLinearWorkItems: (selection?: LinearProjectSelection) => void;
  onOpenSettings: () => void;
  activeRepoView:
    | "projects"
    | "work-items"
    | "linear-projects"
    | "linear-work-items"
    | "settings"
    | null;
  activeOrgScope: string | null;
  activeOrgHubId: string | null;
  activeLinearConnectionId: string | null;
  activeLinearProjectId: string | null;
  activeLinearTeamId: string | null;
}

export const ProjectManagerSidebar: React.FC<ProjectManagerSidebarProps> = memo(
  ({
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
    onOpenSettings,
    activeRepoView,
    activeOrgScope,
    activeOrgHubId,
    activeLinearConnectionId,
    activeLinearTeamId,
  }) => {
    const [activeTab, setActiveTab] = useState("projects");
    const { entry, refresh } = useAllRepoProjects();

    const projectsTab = useProjectsTabConfig({
      loading: entry.loading,
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
      onOpenSettings,
      activeOrgScope,
      activeOrgHubId,
      activeLinearConnectionId,
      activeLinearTeamId,
      activeRepoView,
      onRefresh: refresh,
    });

    const tabs = useMemo(() => [projectsTab], [projectsTab]);

    const handleTabChange = useCallback((tabKey: string) => {
      setActiveTab(tabKey);
    }, []);

    return (
      <PrimarySidebarLayout
        tabs={tabs}
        activeTab={activeTab}
        onTabChange={handleTabChange}
        tabIconOnly={true}
        hideTabs={true}
      />
    );
  }
);

ProjectManagerSidebar.displayName = "ProjectManagerSidebar";

export default ProjectManagerSidebar;
