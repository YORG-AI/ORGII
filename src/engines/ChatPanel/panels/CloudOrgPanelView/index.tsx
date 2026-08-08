/**
 * Panel for a managed ORG2 Cloud org.
 *
 * Cloud data/access state lives in `useCloudOrgPanelState`, target navigation
 * in `CloudOrgPanelHeader`, and each substantial tab in its own component.
 * Org-management mutations continue to use the shared
 * `useCloudOrgManagement` closed loop.
 */
import { useAtomValue, useSetAtom } from "jotai";
import React, { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ChatLoadingBlock } from "@src/engines/ChatPanel/blocks/primitives";
import {
  buildCloudOrgSelectorValue,
  org2CloudOrgsAtom,
} from "@src/features/Org2Cloud/org2CloudOrgsAtom";
import { useOpenCloudBilling } from "@src/features/Org2Cloud/useOpenCloudBilling";
import { sidebarSelectedOrgIdAtom } from "@src/features/Organizations/sidebarOrgScopeAtom";
import {
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import {
  DETAIL_PANEL_TOKENS,
  ScrollFadeContainer,
} from "@src/modules/shared/layouts/blocks";
import { GUIDE_TARGETS } from "@src/scaffold/Tutorials/guideTargets";
import { openWorkManagementChatPanelTabAtom } from "@src/store/chatPanel/chatPanelTabsAtom";
import type { ChatPanelSelectedCloudOrg } from "@src/store/ui/chatPanelAtom";
import {
  isSetupGuideRoleScenario,
  resolveSetupGuideDevRole,
  setupGuideDevScenarioAtom,
} from "@src/store/ui/setupGuideDevScenarioAtom";
import { WORK_MANAGEMENT_SECTION } from "@src/store/workstation";

import CloudOrgPanelHeader from "./CloudOrgPanelHeader";
import CloudOrgRepoScopesSection from "./CloudOrgRepoScopesSection";
import CloudOrgSettingsSection from "./CloudOrgSettingsSection";
import CloudOrgSyncTab from "./CloudOrgSyncTab";
import { CloudInvitesCard, CloudMembersSection } from "./ManagementSections";
import {
  CLOUD_ORG_MANAGEMENT_TAB,
  type CloudOrgManagementTab,
} from "./cloudOrgPanelTypes";
import { useCloudOrgManagement } from "./useCloudOrgManagement";
import { useCloudOrgPanelState } from "./useCloudOrgPanelState";
import { useOrgBackgroundUpload } from "./useOrgBackgroundUpload";
import { useOrgRuntimeTelemetry } from "./useOrgRuntimeTelemetry";

interface CloudOrgPanelViewProps {
  selectedCloudOrg: ChatPanelSelectedCloudOrg;
}

export const CloudOrgPanelView: React.FC<CloudOrgPanelViewProps> = ({
  selectedCloudOrg,
}) => {
  const { t } = useTranslation("navigation");
  const { t: tSessions } = useTranslation("sessions");
  const openCloudBillingPage = useOpenCloudBilling();
  const setSidebarSelectedOrgId = useSetAtom(sidebarSelectedOrgIdAtom);
  const openWorkManagementTab = useSetAtom(openWorkManagementChatPanelTabAtom);
  const cloudOrgs = useAtomValue(org2CloudOrgsAtom);
  const setupGuideDevScenario = useAtomValue(setupGuideDevScenarioAtom);
  const orgId = selectedCloudOrg.orgId;
  const requestedView =
    selectedCloudOrg.initialView ?? CLOUD_ORG_MANAGEMENT_TAB.GENERAL;
  const [tabState, setTabState] = useState<{
    orgId: string;
    requestId: number | undefined;
    requestedView: CloudOrgManagementTab;
    activeTab: CloudOrgManagementTab;
  }>(() => ({
    orgId,
    requestId: selectedCloudOrg.initialViewRequestId,
    requestedView,
    activeTab: requestedView,
  }));
  const tabStateMatchesRequest =
    tabState.orgId === orgId &&
    tabState.requestId === selectedCloudOrg.initialViewRequestId &&
    tabState.requestedView === requestedView;
  const activeTab = tabStateMatchesRequest ? tabState.activeTab : requestedView;
  const handleTabChange = useCallback(
    (nextTab: CloudOrgManagementTab) => {
      setTabState({
        orgId,
        requestId: selectedCloudOrg.initialViewRequestId,
        requestedView,
        activeTab: nextTab,
      });
    },
    [orgId, requestedView, selectedCloudOrg.initialViewRequestId]
  );
  const org = cloudOrgs.find((candidate) => candidate.orgId === orgId);
  const orgName = org?.name ?? "";
  const realIsAdmin = org?.role === "admin" || org?.role === "owner";
  const realIsOwner = org?.role === "owner";
  const panelState = useCloudOrgPanelState(orgId);
  const runtimeSharing = useOrgRuntimeTelemetry(orgId);
  const backgroundUpload = useOrgBackgroundUpload(orgId);
  const memberRoleSimulationActive =
    process.env.NODE_ENV === "development" &&
    isSetupGuideRoleScenario(setupGuideDevScenario);
  const presentationRole = memberRoleSimulationActive
    ? resolveSetupGuideDevRole(org?.role, setupGuideDevScenario)
    : (org?.role ?? null);
  const presentationMemberRole =
    presentationRole === "member" ||
    presentationRole === "admin" ||
    presentationRole === "owner"
      ? presentationRole
      : null;
  const presentationIsAdmin =
    presentationRole === "admin" || presentationRole === "owner";
  const presentationIsOwner = presentationRole === "owner";
  const presentationMembers = useMemo(() => {
    if (!memberRoleSimulationActive || !panelState.currentUserId) {
      return panelState.members;
    }
    return panelState.members.map((member) =>
      member.userId === panelState.currentUserId
        ? { ...member, role: presentationMemberRole ?? member.role }
        : member
    );
  }, [
    memberRoleSimulationActive,
    panelState.currentUserId,
    panelState.members,
    presentationMemberRole,
  ]);
  const management = useCloudOrgManagement({
    orgId,
    orgName,
    isAdmin: realIsAdmin,
    isOwner: realIsOwner,
    members: panelState.members,
    setMembers: panelState.setMembers,
  });
  const presentationManagement = useMemo(
    () =>
      memberRoleSimulationActive
        ? {
            ...management,
            isAdmin: presentationIsAdmin,
            isOwner: presentationIsOwner,
          }
        : management,
    [
      management,
      memberRoleSimulationActive,
      presentationIsAdmin,
      presentationIsOwner,
    ]
  );
  const handleOpenSessions = useCallback(() => {
    setSidebarSelectedOrgId(buildCloudOrgSelectorValue(orgId));
    openWorkManagementTab({
      section: WORK_MANAGEMENT_SECTION.KANBAN,
      title: tSessions("simulator.tabs.kanban"),
    });
  }, [openWorkManagementTab, orgId, setSidebarSelectedOrgId, tSessions]);

  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
      data-testid="cloud-org-panel"
    >
      <CloudOrgPanelHeader
        orgId={orgId}
        activeTab={activeTab}
        onTabChange={handleTabChange}
      />
      <ScrollFadeContainer
        className={`scroll-fade-at-top ${DETAIL_PANEL_TOKENS.scrollContentNoTop}`}
      >
        <div className={DETAIL_PANEL_TOKENS.contentWidthWithPaddingNoTop}>
          {panelState.viewState === "loading" ? (
            <div className="py-2">
              <ChatLoadingBlock />
            </div>
          ) : panelState.viewState === "error" ? (
            <p className="text-[12px] text-text-3">
              {t("cloud.orgPanel.loadError")}
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              {activeTab === CLOUD_ORG_MANAGEMENT_TAB.GENERAL ? (
                <>
                  <CloudOrgSettingsSection
                    t={t}
                    entitlement={panelState.entitlement}
                    orgFloor={panelState.orgFloor}
                    savingFloor={panelState.savingFloor}
                    floorError={panelState.floorError}
                    onFloorChange={panelState.handleFloorChange}
                    runtimeSharing={runtimeSharing}
                    backgroundUpload={backgroundUpload}
                    openCloudBillingPage={openCloudBillingPage}
                    orgName={orgName}
                    members={panelState.members}
                    currentUserId={panelState.currentUserId}
                    management={management}
                    onOpenSessions={handleOpenSessions}
                  />
                  <CloudOrgRepoScopesSection
                    t={t}
                    isAdmin={realIsAdmin}
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
                </>
              ) : null}

              {activeTab === CLOUD_ORG_MANAGEMENT_TAB.SYNC ? (
                <CloudOrgSyncTab orgId={orgId} />
              ) : null}

              {activeTab === CLOUD_ORG_MANAGEMENT_TAB.MEMBERS ? (
                <>
                  {memberRoleSimulationActive ? (
                    <SectionContainer
                      title={t("sidebar.guide.devSimulationActive")}
                    >
                      <SectionRow
                        label={t("sidebar.guide.devSimulationReadOnly")}
                        light
                      />
                    </SectionContainer>
                  ) : null}
                  <div
                    data-guide-target={GUIDE_TARGETS.CLOUD_ORG_MEMBERS_SECTION}
                  >
                    {panelState.members.length === 0 ? (
                      <SectionContainer
                        title={t("cloud.orgPanel.membersTitle")}
                      >
                        <SectionRow
                          label={t("cloud.orgPanel.membersEmpty")}
                          light
                        />
                      </SectionContainer>
                    ) : (
                      <CloudMembersSection
                        t={t}
                        members={presentationMembers}
                        currentUserId={panelState.currentUserId}
                        management={presentationManagement}
                        orgFloor={panelState.orgFloor}
                        interactionDisabled={memberRoleSimulationActive}
                      />
                    )}
                  </div>
                  {presentationIsAdmin ? (
                    <CloudInvitesCard
                      t={t}
                      management={presentationManagement}
                      interactionDisabled={memberRoleSimulationActive}
                    />
                  ) : null}
                </>
              ) : null}
            </div>
          )}
        </div>
      </ScrollFadeContainer>
    </div>
  );
};

export default CloudOrgPanelView;
