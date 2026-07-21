import { useAtomValue, useSetAtom } from "jotai";
import { Cloud, Laptop } from "lucide-react";
import React, { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import Select from "@src/components/Select";
import TabPill, { type TabPillItem } from "@src/components/TabPill";
import { usePublishChatPanelHeader } from "@src/engines/ChatPanel/header";
import { org2CloudOrgsAtom } from "@src/features/Org2Cloud/org2CloudOrgsAtom";
import {
  openCloudOrgManagementInChatPanelTabAtom,
  openWorkspaceOverviewInChatPanelTabAtom,
} from "@src/store/chatPanel/chatPanelTabsAtom";
import { reposAtom } from "@src/store/repo";
import { WORKSPACE_OVERVIEW_TAB } from "@src/store/ui/chatPanelAtom";
import { savedWorkspacesAtom } from "@src/store/ui/workspaceFoldersAtom";

import {
  CLOUD_ORG_MANAGEMENT_TAB,
  type CloudOrgManagementTab,
  type SelectValue,
} from "./cloudOrgPanelTypes";
import {
  buildCloudOrgSelectorValue,
  buildLocalRepoSelectorValue,
  buildLocalWorkspaceSelectorValue,
  parseManagementTarget,
} from "./managementTargetSelector";

interface CloudOrgPanelHeaderProps {
  orgId: string;
  activeTab: CloudOrgManagementTab;
  onTabChange: (tab: CloudOrgManagementTab) => void;
}

/** Target switcher and management-tab navigation for the org panel. */
export function CloudOrgPanelHeader({
  orgId,
  activeTab,
  onTabChange,
}: CloudOrgPanelHeaderProps) {
  const { t } = useTranslation("navigation");
  const { t: tSettings } = useTranslation("settings");
  const cloudOrgs = useAtomValue(org2CloudOrgsAtom);
  const localRepos = useAtomValue(reposAtom);
  const localWorkspaces = useAtomValue(savedWorkspacesAtom);
  const openCloudOrgManagementTab = useSetAtom(
    openCloudOrgManagementInChatPanelTabAtom
  );
  const openWorkspaceOverviewTab = useSetAtom(
    openWorkspaceOverviewInChatPanelTabAtom
  );

  const managementTargetOptions = useMemo(
    () => [
      ...cloudOrgs.map((cloudOrg) => ({
        value: buildCloudOrgSelectorValue(cloudOrg.orgId),
        label: cloudOrg.name,
        icon: <Cloud size={13} strokeWidth={2} />,
        dataTestId: `cloud-org-switch-option-${cloudOrg.orgId}`,
      })),
      ...localWorkspaces.map((workspace) => ({
        value: buildLocalWorkspaceSelectorValue(workspace.workspaceId),
        label: workspace.name,
        icon: <Laptop size={13} strokeWidth={2} />,
        dataTestId: `local-workspace-switch-option-${workspace.workspaceId}`,
      })),
      ...localRepos.map((repo) => ({
        value: buildLocalRepoSelectorValue(repo.id),
        label: repo.name || repo.path?.split("/").pop() || t("workspace"),
        icon: <Laptop size={13} strokeWidth={2} />,
        dataTestId: `local-repo-switch-option-${repo.id}`,
      })),
    ],
    [cloudOrgs, localRepos, localWorkspaces, t]
  );
  const managementTabs = useMemo<TabPillItem[]>(
    () => [
      {
        key: CLOUD_ORG_MANAGEMENT_TAB.GENERAL,
        label: tSettings("sections.general"),
        dataTestId: "cloud-org-tab-general",
      },
      {
        key: CLOUD_ORG_MANAGEMENT_TAB.SESSIONS,
        label: t("routes.sessions"),
        dataTestId: "cloud-org-tab-sessions",
      },
      {
        key: CLOUD_ORG_MANAGEMENT_TAB.REPO_SCOPE,
        label: t("cloud.orgPanel.repoScopesTitle"),
        dataTestId: "cloud-org-tab-repo-scope",
      },
      {
        key: CLOUD_ORG_MANAGEMENT_TAB.MEMBERS,
        label: t("cloud.orgPanel.membersTitle"),
        dataTestId: "cloud-org-tab-members",
      },
    ],
    [t, tSettings]
  );

  const handleOrgChange = useCallback(
    (value: SelectValue) => {
      if (Array.isArray(value)) return;
      const target = parseManagementTarget(String(value));
      if (!target) return;

      if (target.kind === "cloud-org") {
        if (target.id === orgId) return;
        openCloudOrgManagementTab({
          cloudOrg: { orgId: target.id },
          title: t("collaboration.manageOrg"),
        });
        return;
      }

      if (target.kind === "local-repo") {
        const repo = localRepos.find((candidate) => candidate.id === target.id);
        if (!repo) return;
        openWorkspaceOverviewTab({
          workspace: {
            kind: "repo",
            id: repo.id,
            name: repo.name || repo.path?.split("/").pop() || t("workspace"),
            path: repo.path,
          },
          tab: WORKSPACE_OVERVIEW_TAB.DETAILS,
        });
        return;
      }

      const workspace = localWorkspaces.find(
        (candidate) => candidate.workspaceId === target.id
      );
      if (!workspace) return;
      const primaryFolder =
        workspace.folders.find((folder) => folder.isPrimary) ??
        workspace.folders[0];
      openWorkspaceOverviewTab({
        workspace: {
          kind: "workspace",
          id: workspace.workspaceId,
          name: workspace.name,
          path: primaryFolder?.folderPath,
          folderCount: workspace.folders.length,
          repoIds: workspace.folders.flatMap((folder) =>
            folder.repoId ? [folder.repoId] : []
          ),
        },
        tab: WORKSPACE_OVERVIEW_TAB.OVERVIEW,
      });
    },
    [
      localRepos,
      localWorkspaces,
      openCloudOrgManagementTab,
      openWorkspaceOverviewTab,
      orgId,
      t,
    ]
  );

  const headerContent = useMemo(
    () => (
      <div
        className="flex min-w-0 flex-1 items-center gap-2"
        data-testid="cloud-org-management-header"
      >
        <Select
          value={buildCloudOrgSelectorValue(orgId)}
          options={managementTargetOptions}
          onChange={handleOrgChange}
          showSearch={managementTargetOptions.length > 8}
          variant="default"
          size="small"
          radius="lg"
          className="w-48 shrink-0"
          selectorClassName="h-7 whitespace-nowrap"
          dataTestId="cloud-org-switcher"
        />
        <div className="min-w-0 overflow-x-auto scrollbar-hide">
          <TabPill
            tabs={managementTabs}
            activeTab={activeTab}
            onChange={(key) => onTabChange(key as CloudOrgManagementTab)}
            variant="simple"
            fillWidth={false}
            size="small"
          />
        </div>
      </div>
    ),
    [
      activeTab,
      handleOrgChange,
      managementTabs,
      managementTargetOptions,
      onTabChange,
      orgId,
    ]
  );
  const headerContribution = useMemo(
    () => ({ content: headerContent }),
    [headerContent]
  );
  usePublishChatPanelHeader({ content: headerContribution });

  return null;
}

export default CloudOrgPanelHeader;
