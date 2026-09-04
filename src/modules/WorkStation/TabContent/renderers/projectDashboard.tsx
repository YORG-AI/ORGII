/**
 * Renderer wrapper for `project-dashboard` tabs.
 *
 * Renders the Projects surface through the unified dispatcher, pulling its
 * action callbacks from the hoisted Project host context
 * (`useProjectHostContext`) and deriving breadcrumb / org scope from tab data
 * — mirroring how `ProjectManagerContentRouter` mounts `ProjectsPage`.
 */
import React, { memo } from "react";
import { useTranslation } from "react-i18next";

import { getProjectManagerBreadcrumbSegments } from "@src/modules/ProjectManager/ProjectManagerLayout/components/projectManagerRouterUtils";
import { useProjectHostContext } from "@src/modules/ProjectManager/ProjectManagerLayout/context/projectHostContext";
import ProjectsPage from "@src/modules/ProjectManager/Projects";

import type { UnifiedTabContentProps } from "../types";
import { getProjectOrgScopeProps } from "./projectOrgScope";

const ProjectDashboardTabRenderer: React.FC<UnifiedTabContentProps> = memo(
  ({ tab }) => {
    const { t } = useTranslation("projects");
    const { onSelectProject, onCreateProject, onOpenLinearProjects } =
      useProjectHostContext();

    const breadcrumbSegments = getProjectManagerBreadcrumbSegments(tab, t);
    const { allowExternalSources, scopedOrgId } = getProjectOrgScopeProps(tab);

    return (
      <ProjectsPage
        breadcrumbSegments={breadcrumbSegments}
        orgId={scopedOrgId}
        onOpenProject={onSelectProject}
        onAddProject={onCreateProject}
        onOpenLinearProject={onOpenLinearProjects}
        allowExternalSources={allowExternalSources}
        publishToWorkstationHeader
        workStationTabId={tab.id}
        sidebarToggleDisabled
      />
    );
  }
);

ProjectDashboardTabRenderer.displayName = "ProjectDashboardTabRenderer";

export default ProjectDashboardTabRenderer;
