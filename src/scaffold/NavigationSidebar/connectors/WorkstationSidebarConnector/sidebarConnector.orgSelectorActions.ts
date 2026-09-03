/**
 * Org-selector actions for `WorkstationSidebarConnector` (`index.tsx`):
 * opening the global Spotlight search, starting the "add org" collab flow,
 * switching the sidebar's active org scope, and routing "Manage org" to
 * the right organization tab (cloud org, local project org, or falling
 * back to "add org" when nothing is manageable yet).
 */
import type { TFunction } from "i18next";
import { useSetAtom } from "jotai";
import React, { useCallback } from "react";

import { openCollabOrgSpotlight } from "@src/scaffold/GlobalSpotlight/openSpotlight";
import { openOrganizationInChatPanelTabAtom } from "@src/store/chatPanel/chatPanelTabsAtom";
import { spotlightOpenAtom } from "@src/store/ui/uiAtom";
import {
  PROJECT_ORG_SURFACE_VIEW,
  STORY_ORG_SCOPE,
} from "@src/store/workstation";

import { useSidebarOrgScope } from "./useSidebarOrgScope";

type OrgScopeResult = ReturnType<typeof useSidebarOrgScope>;
type OpenOrganizationTab = ReturnType<
  typeof useSetAtom<typeof openOrganizationInChatPanelTabAtom>
>;
interface UseWorkstationSidebarOrgSelectorActionsParams {
  resetWorkManagementStateForProjectsContent: () => void;
  t: TFunction<"navigation">;
  setSelectedOrgId: OrgScopeResult["setSelectedOrgId"];
  activeCloudOrgId: OrgScopeResult["activeCloudOrgId"];
  manageableCloudOrg: OrgScopeResult["manageableCloudOrg"];
  manageableLocalOrg: OrgScopeResult["manageableLocalOrg"];
  openOrganizationTab: OpenOrganizationTab;
}

export function useWorkstationSidebarOrgSelectorActions({
  resetWorkManagementStateForProjectsContent,
  t,
  setSelectedOrgId,
  activeCloudOrgId,
  manageableCloudOrg,
  manageableLocalOrg,
  openOrganizationTab,
}: UseWorkstationSidebarOrgSelectorActionsParams) {
  const setSpotlightOpen = useSetAtom(spotlightOpenAtom);
  const localOrgManagementRequestIdRef = React.useRef(0);

  const handleOpenSpotlight = useCallback(() => {
    setSpotlightOpen(true);
  }, [setSpotlightOpen]);
  const handleAddOrgFromSelector = useCallback(() => {
    openCollabOrgSpotlight();
  }, []);
  // UX decision (scope vs. panel): picking an org in the selector ONLY
  // switches the sidebar scope — it never navigates the chat panel. The
  // dropdown's explicit management action remains available from any scope.
  const handleOrgSelectorChange = useCallback(
    (orgId: string) => {
      // Picking an org ONLY switches the sidebar scope. A cloud scope shows
      // the org's local sessions (stamped org id or explicit cloud tag) plus
      // the fork-threaded "Team sessions" section (useCloudSessionsSection).
      setSelectedOrgId(orgId);
    },
    [setSelectedOrgId]
  );
  const handleManageOrg = useCallback(() => {
    resetWorkManagementStateForProjectsContent();
    if (activeCloudOrgId && manageableCloudOrg) {
      openOrganizationTab({
        organization: {
          kind: "cloud",
          cloudOrg: { orgId: manageableCloudOrg.orgId },
        },
        title: t("collaboration.manageOrg"),
      });
      return;
    }
    if (manageableLocalOrg) {
      localOrgManagementRequestIdRef.current += 1;
      openOrganizationTab({
        organization: {
          kind: "local",
          projectOrg: {
            orgId: manageableLocalOrg.id,
            orgName: manageableLocalOrg.name,
            orgScope: STORY_ORG_SCOPE.PROJECT_ORG,
            orgSyncProvider: manageableLocalOrg.sync_provider,
            initialView: PROJECT_ORG_SURFACE_VIEW.SETTINGS,
            initialViewRequestId: localOrgManagementRequestIdRef.current,
          },
        },
        title: t("collaboration.manageOrg"),
      });
      return;
    }
    if (manageableCloudOrg) {
      openOrganizationTab({
        organization: {
          kind: "cloud",
          cloudOrg: { orgId: manageableCloudOrg.orgId },
        },
        title: t("collaboration.manageOrg"),
      });
      return;
    }
    handleAddOrgFromSelector();
  }, [
    activeCloudOrgId,
    handleAddOrgFromSelector,
    manageableCloudOrg,
    manageableLocalOrg,
    openOrganizationTab,
    resetWorkManagementStateForProjectsContent,
    t,
  ]);

  return {
    handleOpenSpotlight,
    handleAddOrgFromSelector,
    handleOrgSelectorChange,
    handleManageOrg,
  };
}
