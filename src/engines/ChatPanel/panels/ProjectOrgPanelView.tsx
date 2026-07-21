import { useSetAtom } from "jotai";
import React, { useCallback, useState } from "react";

import {
  projectApi,
  projectDataToUI,
  workItemDataToUI,
} from "@src/api/http/project";
import { projectSyncApi } from "@src/api/http/project/sync";
import { createLogger } from "@src/hooks/logger";
import { ProjectOrgHubContent } from "@src/modules/ProjectManager/ProjectManagerLayout/components/ProjectOrgHubContent";
import {
  openCreateTargetInChatPanelStartPageAtom,
  openProjectInChatPanelTabAtom,
  openWorkItemInChatPanelTabAtom,
} from "@src/store/chatPanel/chatPanelTabsAtom";
import {
  CHAT_PANEL_CREATE_TARGET,
  type ChatPanelSelectedProjectOrg,
} from "@src/store/ui/chatPanelAtom";
import {
  PROJECT_ORG_SURFACE_VIEW,
  type ProjectOrgSurfaceView,
} from "@src/store/workstation/tabs";

const logger = createLogger("ProjectOrgPanelView");

interface ProjectOrgPanelViewProps {
  selectedProjectOrg: ChatPanelSelectedProjectOrg;
}

export const ProjectOrgPanelView: React.FC<ProjectOrgPanelViewProps> = ({
  selectedProjectOrg,
}) => {
  const openCreateTargetInStartPage = useSetAtom(
    openCreateTargetInChatPanelStartPageAtom
  );
  const openProjectTab = useSetAtom(openProjectInChatPanelTabAtom);
  const openWorkItemTab = useSetAtom(openWorkItemInChatPanelTabAtom);
  const [orgView, setOrgView] = useState<ProjectOrgSurfaceView>(
    PROJECT_ORG_SURFACE_VIEW.WORK_ITEMS
  );

  const handleSelectProject = useCallback(
    async (projectId: string, projectName: string, projectSlug?: string) => {
      if (!projectSlug) return;

      try {
        const [projectData, syncStatus] = await Promise.all([
          projectApi.readProject(projectSlug),
          projectSyncApi.status(projectSlug).catch(() => null),
        ]);
        openProjectTab({
          project: projectDataToUI(projectData, {
            labelMap: new Map(),
            memberMap: new Map(),
          }),
          projectSlug,
          projectSyncAdapterId: syncStatus?.adapter_id ?? null,
          orgId: selectedProjectOrg.orgId,
          orgName: selectedProjectOrg.orgName,
        });
      } catch (error) {
        logger.error("failed to open project from org page", error, {
          projectId,
          projectName,
          projectSlug,
        });
      }
    },
    [openProjectTab, selectedProjectOrg.orgId, selectedProjectOrg.orgName]
  );

  const handleCreateProject = useCallback(() => {
    openCreateTargetInStartPage({
      target: CHAT_PANEL_CREATE_TARGET.PROJECT,
      createProjectContext: {
        orgId: selectedProjectOrg.orgId,
        scopeBreadcrumbLabel: selectedProjectOrg.orgName,
      },
    });
  }, [
    openCreateTargetInStartPage,
    selectedProjectOrg.orgId,
    selectedProjectOrg.orgName,
  ]);

  const handleCreateWorkItem = useCallback(() => {
    openCreateTargetInStartPage({
      target: CHAT_PANEL_CREATE_TARGET.WORK_ITEM,
      createProjectContext: {
        orgId: selectedProjectOrg.orgId,
        scopeBreadcrumbLabel: selectedProjectOrg.orgName,
      },
    });
  }, [
    openCreateTargetInStartPage,
    selectedProjectOrg.orgId,
    selectedProjectOrg.orgName,
  ]);

  const handleExpandWorkItemToTab = useCallback(
    async (
      projectId: string | undefined,
      projectName: string | undefined,
      projectSlug: string | undefined,
      workItemId: string,
      workItemName: string
    ) => {
      if (!projectId || !projectName || !projectSlug) return;

      try {
        const workItemData = await projectApi.readWorkItem(
          projectSlug,
          workItemId,
          { orgId: selectedProjectOrg.orgId }
        );
        openWorkItemTab({
          workItem: workItemDataToUI(workItemData, {
            labelMap: new Map(),
            memberMap: new Map(),
            projectNameMap: new Map([[projectId, projectName]]),
          }),
          projectId,
          projectName,
          projectSlug,
          shortId: workItemId,
          orgId: selectedProjectOrg.orgId,
          orgName: selectedProjectOrg.orgName,
        });
      } catch (error) {
        logger.error("failed to open work item from org page", error, {
          projectId,
          projectName,
          projectSlug,
          workItemId,
          workItemName,
        });
      }
    },
    [selectedProjectOrg.orgId, selectedProjectOrg.orgName, openWorkItemTab]
  );

  return (
    <ProjectOrgHubContent
      orgId={selectedProjectOrg.orgId}
      orgScope={selectedProjectOrg.orgScope}
      orgView={orgView}
      breadcrumbSegments={[{ label: selectedProjectOrg.orgName }]}
      renderSurfaceControlsInline
      onOrgViewChange={setOrgView}
      onSelectProject={handleSelectProject}
      onCreateProject={handleCreateProject}
      onCreateWorkItem={handleCreateWorkItem}
      onExpandWorkItemToTab={handleExpandWorkItemToTab}
    />
  );
};

export default ProjectOrgPanelView;
