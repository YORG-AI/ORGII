import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";

import OrganizationTabSwitch from "@src/components/OrganizationTabSwitch";
import type { TabPillItem } from "@src/components/TabPill";
import OrganizationPanelHeader from "@src/engines/ChatPanel/panels/OrganizationPanelHeader";

import {
  CLOUD_ORG_MANAGEMENT_TAB,
  type CloudOrgManagementTab,
} from "./cloudOrgPanelTypes";

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
  const managementTabs = useMemo<TabPillItem[]>(
    () => [
      {
        key: CLOUD_ORG_MANAGEMENT_TAB.GENERAL,
        label: tSettings("sections.general"),
        dataTestId: "cloud-org-tab-general",
      },
      {
        key: CLOUD_ORG_MANAGEMENT_TAB.MEMBERS,
        label: t("cloud.orgPanel.membersTitle"),
        dataTestId: "cloud-org-tab-members",
      },
    ],
    [t, tSettings]
  );

  return (
    <OrganizationPanelHeader
      organization={{ kind: "cloud", cloudOrg: { orgId } }}
      dataTestId="cloud-org-management-header"
      tabControl={
        <OrganizationTabSwitch
          tabs={managementTabs}
          activeTab={activeTab}
          onChange={(key) => onTabChange(key as CloudOrgManagementTab)}
          className="h-10"
        />
      }
    />
  );
}

export default CloudOrgPanelHeader;
