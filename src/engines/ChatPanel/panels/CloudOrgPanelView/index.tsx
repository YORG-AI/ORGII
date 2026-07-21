/**
 * Panel for a managed ORG2 Cloud org.
 *
 * Cloud data/access state lives in `useCloudOrgPanelState`, target navigation
 * in `CloudOrgPanelHeader`, and each substantial tab in its own component.
 * Org-management mutations continue to use the shared
 * `useCloudOrgManagement` closed loop.
 */
import { useAtomValue } from "jotai";
import React, { useState } from "react";
import { useTranslation } from "react-i18next";

import { org2CloudOrgsAtom } from "@src/features/Org2Cloud/org2CloudOrgsAtom";
import { useOpenCloudBilling } from "@src/features/Org2Cloud/useOpenCloudBilling";
import {
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import {
  DETAIL_PANEL_TOKENS,
  ScrollFadeContainer,
} from "@src/modules/shared/layouts/blocks";
import { Placeholder } from "@src/modules/shared/layouts/blocks/Placeholder";
import type { ChatPanelSelectedCloudOrg } from "@src/store/ui/chatPanelAtom";

import CloudOrgGeneralTab from "./CloudOrgGeneralTab";
import CloudOrgPanelHeader from "./CloudOrgPanelHeader";
import CloudOrgRepoScopesTab from "./CloudOrgRepoScopesTab";
import CloudSessionsSection from "./CloudSessionsSection";
import {
  CloudInvitesCard,
  CloudMembersSection,
  CloudOrgSettingsSection,
} from "./ManagementSections";
import {
  CLOUD_ORG_MANAGEMENT_TAB,
  type CloudOrgManagementTab,
} from "./cloudOrgPanelTypes";
import { useCloudOrgManagement } from "./useCloudOrgManagement";
import { useCloudOrgPanelState } from "./useCloudOrgPanelState";

interface CloudOrgPanelViewProps {
  selectedCloudOrg: ChatPanelSelectedCloudOrg;
}

export const CloudOrgPanelView: React.FC<CloudOrgPanelViewProps> = ({
  selectedCloudOrg,
}) => {
  const { t } = useTranslation("navigation");
  const openCloudBillingPage = useOpenCloudBilling();
  const cloudOrgs = useAtomValue(org2CloudOrgsAtom);
  const [activeTab, setActiveTab] = useState<CloudOrgManagementTab>(
    CLOUD_ORG_MANAGEMENT_TAB.GENERAL
  );
  const orgId = selectedCloudOrg.orgId;
  const org = cloudOrgs.find((candidate) => candidate.orgId === orgId);
  const orgName = org?.name ?? "";
  const isAdmin = org?.role === "admin" || org?.role === "owner";
  const isOwner = org?.role === "owner";
  const panelState = useCloudOrgPanelState(orgId);
  const management = useCloudOrgManagement({
    orgId,
    orgName,
    isAdmin,
    isOwner,
    members: panelState.members,
    setMembers: panelState.setMembers,
  });

  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
      data-testid="cloud-org-panel"
    >
      <CloudOrgPanelHeader
        orgId={orgId}
        activeTab={activeTab}
        onTabChange={setActiveTab}
      />
      <ScrollFadeContainer
        className={`scroll-fade-at-top ${DETAIL_PANEL_TOKENS.scrollContentNoTop}`}
      >
        <div
          className={
            activeTab === CLOUD_ORG_MANAGEMENT_TAB.SESSIONS
              ? `min-h-full w-full ${DETAIL_PANEL_TOKENS.contentScrollBottom}`
              : DETAIL_PANEL_TOKENS.contentWidthWithPaddingNoTop
          }
        >
          {activeTab === CLOUD_ORG_MANAGEMENT_TAB.SESSIONS ? (
            <CloudSessionsSection orgId={orgId} />
          ) : panelState.viewState === "loading" ? (
            <Placeholder variant="loading" />
          ) : panelState.viewState === "error" ? (
            <p className="text-[12px] text-text-3">
              {t("cloud.orgPanel.loadError")}
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              {activeTab === CLOUD_ORG_MANAGEMENT_TAB.GENERAL ? (
                <CloudOrgGeneralTab
                  t={t}
                  entitlement={panelState.entitlement}
                  isAdmin={isAdmin}
                  orgFloor={panelState.orgFloor}
                  savingFloor={panelState.savingFloor}
                  floorError={panelState.floorError}
                  onFloorChange={panelState.handleFloorChange}
                  openCloudBillingPage={openCloudBillingPage}
                />
              ) : null}

              {activeTab === CLOUD_ORG_MANAGEMENT_TAB.MEMBERS ? (
                <>
                  {panelState.members.length === 0 ? (
                    <SectionContainer title={t("cloud.orgPanel.membersTitle")}>
                      <SectionRow
                        label={t("cloud.orgPanel.membersEmpty")}
                        light
                      />
                    </SectionContainer>
                  ) : (
                    <CloudMembersSection
                      t={t}
                      members={panelState.members}
                      currentUserId={panelState.currentUserId}
                      management={management}
                      orgFloor={panelState.orgFloor}
                    />
                  )}
                  {isAdmin ? (
                    <CloudInvitesCard t={t} management={management} />
                  ) : null}
                </>
              ) : null}

              {activeTab === CLOUD_ORG_MANAGEMENT_TAB.REPO_SCOPE ? (
                <CloudOrgRepoScopesTab
                  t={t}
                  isAdmin={isAdmin}
                  savedScopes={panelState.savedScopes}
                  draftScopes={panelState.draftScopes}
                  setDraftScopes={panelState.setDraftScopes}
                  scopesDirty={panelState.scopesDirty}
                  scopeQuota={panelState.scopeQuota}
                  savingScopes={panelState.savingScopes}
                  scopesSaved={panelState.scopesSaved}
                  scopesError={panelState.scopesError}
                  onSaveScopes={panelState.handleSaveScopes}
                  openCloudBillingPage={openCloudBillingPage}
                />
              ) : null}

              {activeTab === CLOUD_ORG_MANAGEMENT_TAB.GENERAL && isAdmin ? (
                <CloudOrgSettingsSection
                  t={t}
                  orgName={orgName}
                  members={panelState.members}
                  currentUserId={panelState.currentUserId}
                  management={management}
                />
              ) : null}
            </div>
          )}
        </div>
      </ScrollFadeContainer>
    </div>
  );
};

export default CloudOrgPanelView;
