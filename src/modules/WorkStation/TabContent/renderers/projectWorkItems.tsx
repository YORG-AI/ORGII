/**
 * Renderer wrapper for `project-work-items` tabs.
 *
 * Renders the all-work-items index (`ProjectWorkItemsTabContent`) through the
 * unified dispatcher, pulling action callbacks from the hoisted Project host
 * context and deriving breadcrumb / org scope from tab data — mirroring
 * `ProjectManagerContentRouter`.
 */
import React, { memo } from "react";
import { useTranslation } from "react-i18next";

import { ProjectWorkItemsTabContent } from "@src/modules/ProjectManager/ProjectManagerLayout/components/ProjectWorkItemsTabContent";
import { getProjectManagerBreadcrumbSegments } from "@src/modules/ProjectManager/ProjectManagerLayout/components/projectManagerRouterUtils";
import { useProjectHostContext } from "@src/modules/ProjectManager/ProjectManagerLayout/context/projectHostContext";

import type { UnifiedTabContentProps } from "../types";
import { getProjectOrgScopeProps } from "./projectOrgScope";

const ProjectWorkItemsTabRenderer: React.FC<UnifiedTabContentProps> = memo(
  ({ tab }) => {
    const { t } = useTranslation("projects");
    const {
      onExpandWorkItemToTab,
      onOpenLinearProjects,
      onCreateProject,
      onCreateWorkItem,
    } = useProjectHostContext();

    const breadcrumbSegments = getProjectManagerBreadcrumbSegments(tab, t);
    const { allowExternalSources, scopedOrgId } = getProjectOrgScopeProps(tab);

    return (
      <ProjectWorkItemsTabContent
        breadcrumbSegments={breadcrumbSegments}
        orgId={scopedOrgId}
        onOpenWorkItem={(selection) =>
          onExpandWorkItemToTab(
            selection.projectId,
            selection.projectName,
            selection.projectSlug,
            selection.workItem.session_id,
            selection.workItem.name
          )
        }
        onOpenLinearProject={onOpenLinearProjects}
        allowExternalSources={allowExternalSources}
        onCreateProject={onCreateProject}
        onCreateWorkItem={() => onCreateWorkItem()}
        workStationTabId={tab.id}
      />
    );
  }
);

ProjectWorkItemsTabRenderer.displayName = "ProjectWorkItemsTabRenderer";

export default ProjectWorkItemsTabRenderer;
