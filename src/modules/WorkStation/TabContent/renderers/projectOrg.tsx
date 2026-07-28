/**
 * Renderer wrapper for `project-org` tabs.
 *
 * Renders the org hub (`ProjectOrgHubContent`) through the unified dispatcher,
 * pulling org-scope navigation + tab mutators from the hoisted Project host
 * context — mirroring `ProjectManagerContentRouter`. The org view is derived
 * from tab data (see `projectOrgSettings` for the settings-forced variant).
 */
import { useSetAtom } from "jotai";
import React, { memo } from "react";
import { useTranslation } from "react-i18next";

import ProjectOrgHubContent from "@src/modules/ProjectManager/ProjectManagerLayout/components/ProjectOrgHubContent";
import {
  getProjectManagerBreadcrumbSegments,
  getTabDataString,
} from "@src/modules/ProjectManager/ProjectManagerLayout/components/projectManagerRouterUtils";
import { useProjectHostContext } from "@src/modules/ProjectManager/ProjectManagerLayout/context/projectHostContext";
import { closeProjectOrgWorkStationTabsAtom } from "@src/store/workstation/tabRegistry";
import {
  STORY_ORG_SCOPE,
  normalizeProjectOrgSurfaceView,
} from "@src/store/workstation/tabs";
import type { ProjectOrgScope } from "@src/store/workstation/tabs";

import type { UnifiedTabContentProps } from "../types";

const ProjectOrgTabRenderer: React.FC<UnifiedTabContentProps> = memo(
  ({ tab }) => {
    const { t } = useTranslation("projects");
    const closeProjectOrgTabs = useSetAtom(closeProjectOrgWorkStationTabsAtom);
    const {
      onUpdateTabData,
      onSelectProject,
      onCreateProject,
      onCreateWorkItem,
      onExpandWorkItemToTab,
      onOpenLinearProjects,
    } = useProjectHostContext();

    const orgId = getTabDataString(tab, "orgId");
    if (!orgId) return null;
    const orgScope =
      (tab.data.orgScope as ProjectOrgScope | undefined) ??
      STORY_ORG_SCOPE.PROJECT_ORG;
    const orgView = normalizeProjectOrgSurfaceView(tab.data.orgView);
    const breadcrumbSegments = getProjectManagerBreadcrumbSegments(tab, t);

    return (
      <ProjectOrgHubContent
        orgId={orgId}
        orgScope={orgScope}
        orgView={orgView}
        breadcrumbSegments={breadcrumbSegments}
        workStationTabId={tab.id}
        onOrgViewChange={(view) => onUpdateTabData(tab.id, { orgView: view })}
        onSelectProject={onSelectProject}
        onCreateProject={onCreateProject}
        onCreateWorkItem={onCreateWorkItem}
        onExpandWorkItemToTab={onExpandWorkItemToTab}
        onOpenLinearProjects={onOpenLinearProjects}
        onOrgDeleted={closeProjectOrgTabs}
      />
    );
  }
);

ProjectOrgTabRenderer.displayName = "ProjectOrgTabRenderer";

export default ProjectOrgTabRenderer;
