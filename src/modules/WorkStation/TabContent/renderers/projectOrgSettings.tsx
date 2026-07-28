/**
 * Renderer wrapper for `project-org-settings` tabs.
 *
 * Same org hub surface as `project-org`, with the org view forced to
 * SETTINGS — mirroring `ProjectManagerContentRouter`.
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
  PROJECT_ORG_SURFACE_VIEW,
  STORY_ORG_SCOPE,
} from "@src/store/workstation/tabs";
import type { ProjectOrgScope } from "@src/store/workstation/tabs";

import type { UnifiedTabContentProps } from "../types";

const ProjectOrgSettingsTabRenderer: React.FC<UnifiedTabContentProps> = memo(
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
    const breadcrumbSegments = getProjectManagerBreadcrumbSegments(tab, t);

    return (
      <ProjectOrgHubContent
        orgId={orgId}
        orgScope={orgScope}
        orgView={PROJECT_ORG_SURFACE_VIEW.SETTINGS}
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

ProjectOrgSettingsTabRenderer.displayName = "ProjectOrgSettingsTabRenderer";

export default ProjectOrgSettingsTabRenderer;
