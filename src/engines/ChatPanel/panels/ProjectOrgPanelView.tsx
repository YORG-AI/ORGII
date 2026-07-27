import { useSetAtom } from "jotai";
import React, { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  projectApi,
  projectDataToUI,
  workItemDataToUI,
} from "@src/api/http/project";
import { projectSyncApi } from "@src/api/http/project/sync";
import Message from "@src/components/Message";
import { createLogger } from "@src/hooks/logger";
import { ProjectOrgHubContent } from "@src/modules/ProjectManager/ProjectManagerLayout/components/ProjectOrgHubContent";
import { ProjectOrgSurfacePillSwitch } from "@src/modules/ProjectManager/ProjectManagerLayout/components/ProjectOrgSurfacePillSwitch";
import {
  closeProjectOrgChatPanelTabsAtom,
  openCreateTargetInChatPanelStartPageAtom,
  openOrganizationInChatPanelTabAtom,
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
  STORY_ORG_SCOPE,
  STORY_PERSONAL_ORG_FILTER_ID,
} from "@src/store/workstation/tabs";

import OrganizationPanelHeader from "./OrganizationPanelHeader";

const logger = createLogger("ProjectOrgPanelView");

interface ProjectOrgPanelViewProps {
  selectedProjectOrg: ChatPanelSelectedProjectOrg;
}

export const ProjectOrgPanelView: React.FC<ProjectOrgPanelViewProps> = ({
  selectedProjectOrg,
}) => {
  const { t } = useTranslation("projects");
  const openCreateTargetInStartPage = useSetAtom(
    openCreateTargetInChatPanelStartPageAtom
  );
  const openProjectTab = useSetAtom(openProjectInChatPanelTabAtom);
  const openWorkItemTab = useSetAtom(openWorkItemInChatPanelTabAtom);
  const closeProjectOrgTabs = useSetAtom(closeProjectOrgChatPanelTabsAtom);
  const openOrganizationTab = useSetAtom(openOrganizationInChatPanelTabAtom);
  const [orgView, setOrgView] = useState<ProjectOrgSurfaceView>(
    selectedProjectOrg.initialView ?? PROJECT_ORG_SURFACE_VIEW.WORK_ITEMS
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

  const handleOrgDeleted = useCallback(
    (orgId: string) => {
      closeProjectOrgTabs([orgId]);
      openOrganizationTab({
        organization: {
          kind: "local",
          projectOrg: {
            orgId: STORY_PERSONAL_ORG_FILTER_ID,
            orgName: t("orgs.personalOrg"),
            orgScope: STORY_ORG_SCOPE.PERSONAL_ORG,
            initialView: PROJECT_ORG_SURFACE_VIEW.SETTINGS,
          },
        },
      });
      Message.success(
        t("orgs.management.deletedToast", {
          org: selectedProjectOrg.orgName,
        })
      );
    },
    [closeProjectOrgTabs, openOrganizationTab, selectedProjectOrg.orgName, t]
  );

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <OrganizationPanelHeader
        organization={{ kind: "local", projectOrg: selectedProjectOrg }}
        dataTestId="local-org-management-header"
        tabControl={
          <ProjectOrgSurfacePillSwitch
            orgView={orgView}
            onOrgViewChange={setOrgView}
            className="h-10"
            size="large"
          />
        }
      />
      <div className="min-h-0 flex-1 overflow-hidden">
        <ProjectOrgHubContent
          orgId={selectedProjectOrg.orgId}
          orgScope={selectedProjectOrg.orgScope}
          orgView={orgView}
          breadcrumbSegments={[{ label: selectedProjectOrg.orgName }]}
          onOrgViewChange={setOrgView}
          onSelectProject={handleSelectProject}
          onCreateProject={handleCreateProject}
          onCreateWorkItem={handleCreateWorkItem}
          onExpandWorkItemToTab={handleExpandWorkItemToTab}
          onOrgDeleted={handleOrgDeleted}
        />
      </div>
    </div>
  );
};

export default ProjectOrgPanelView;
