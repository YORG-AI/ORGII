/**
 * Sidebar "chrome" for `WorkstationSidebarConnector` (`index.tsx`): the
 * single call site for the three tightly-sequenced hooks that build the
 * sidebar's header/menu-routing surface — `useWorkstationSidebarOrgSelectorActions`,
 * `useWorkstationSidebarMenuItemRouting`, the org selector JSX, and the
 * scope-resolved `NavigationSidebar` props (menu-item click, context menu,
 * row wrapper). Consolidated into one call so `index.tsx` doesn't have to
 * thread the org-selector/menu-routing handoff itself.
 */
import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";

import SidebarOrgSelector from "../SidebarOrgSelector";
import { useWorkstationSidebarMenuItemRouting } from "./sidebarConnector.menuItemRouting";
import { useWorkstationSidebarOrgSelectorActions } from "./sidebarConnector.orgSelectorActions";
import type { WorkstationSidebarKey } from "./types";
import type { useWorkItemsSidebarSurface } from "./useWorkItemsSidebarSurface";

type SidebarOrgSelectorProps = Parameters<typeof SidebarOrgSelector>[0];
type OrgSelectorActionsParams = Parameters<
  typeof useWorkstationSidebarOrgSelectorActions
>[0];
type MenuItemRoutingParams = Parameters<
  typeof useWorkstationSidebarMenuItemRouting
>[0];

interface UseWorkstationSidebarChromeParams {
  activeOrgId: SidebarOrgSelectorProps["value"];
  orgSelectorOptions: SidebarOrgSelectorProps["options"];
  addOrgLabel: string;
  cloudSignedInIdentity: SidebarOrgSelectorProps["cloudSignedInIdentity"];
  manageOrgLabel: string;
  handleCloudSignIn: SidebarOrgSelectorProps["onCloudSignIn"];
  activeSidebarKey: WorkstationSidebarKey;
  workItemsContentVisible: boolean;
  handleMenuItemContextMenu: (
    event: React.MouseEvent,
    key: string,
    item: NavigationMenuItem
  ) => Promise<void>;
  // Forwarded to useWorkstationSidebarOrgSelectorActions:
  resetWorkManagementStateForProjectsContent: OrgSelectorActionsParams["resetWorkManagementStateForProjectsContent"];
  setProjectsSelectedMenuItemId: OrgSelectorActionsParams["setProjectsSelectedMenuItemId"];
  openCreateTargetInStartPage: OrgSelectorActionsParams["openCreateTargetInStartPage"];
  t: OrgSelectorActionsParams["t"];
  setSelectedOrgId: OrgSelectorActionsParams["setSelectedOrgId"];
  activeCloudOrgId: OrgSelectorActionsParams["activeCloudOrgId"];
  manageableCloudOrg: OrgSelectorActionsParams["manageableCloudOrg"];
  manageableLocalOrg: OrgSelectorActionsParams["manageableLocalOrg"];
  openOrganizationTab: OrgSelectorActionsParams["openOrganizationTab"];
  // Forwarded to useWorkstationSidebarMenuItemRouting:
  sessionMap: MenuItemRoutingParams["sessionMap"];
  cloudRemoteRowMap: MenuItemRoutingParams["cloudRemoteRowMap"];
  cloudRemoteViewerMap: MenuItemRoutingParams["cloudRemoteViewerMap"];
  renderProjectsMenuItemWrapper: ReturnType<
    typeof useWorkItemsSidebarSurface
  >["renderMenuItemWrapper"];
  tSessions: MenuItemRoutingParams["tSessions"];
  setWorkManagementProjectsView: MenuItemRoutingParams["setWorkManagementProjectsView"];
  openWorkManagementTab: MenuItemRoutingParams["openWorkManagementTab"];
  openRuntimeTab: MenuItemRoutingParams["openRuntimeTab"];
  runtimeLabel: string;
  openTeamInboxTab: MenuItemRoutingParams["openTeamInboxTab"];
  activateChatPanelTab: MenuItemRoutingParams["activateChatPanelTab"];
  handleMenuItemClick: MenuItemRoutingParams["handleMenuItemClick"];
  handleProjectsMenuItemClick: MenuItemRoutingParams["handleProjectsMenuItemClick"];
  handleOpenInNewTab: MenuItemRoutingParams["handleOpenInNewTab"];
}

export function useWorkstationSidebarChrome({
  activeOrgId,
  orgSelectorOptions,
  addOrgLabel,
  cloudSignedInIdentity,
  manageOrgLabel,
  activeSidebarKey,
  workItemsContentVisible,
  handleMenuItemContextMenu,
  resetWorkManagementStateForProjectsContent,
  setProjectsSelectedMenuItemId,
  openCreateTargetInStartPage,
  t,
  setSelectedOrgId,
  activeCloudOrgId,
  manageableCloudOrg,
  manageableLocalOrg,
  openOrganizationTab,
  handleCloudSignIn,
  sessionMap,
  cloudRemoteRowMap,
  cloudRemoteViewerMap,
  renderProjectsMenuItemWrapper,
  tSessions,
  setWorkManagementProjectsView,
  openWorkManagementTab,
  openRuntimeTab,
  runtimeLabel,
  openTeamInboxTab,
  activateChatPanelTab,
  handleMenuItemClick,
  handleProjectsMenuItemClick,
  handleOpenInNewTab,
}: UseWorkstationSidebarChromeParams) {
  const {
    handleOpenSpotlight,
    handleAddOrgFromSelector,
    handleOrgSelectorChange,
    handleManageOrg,
  } = useWorkstationSidebarOrgSelectorActions({
    resetWorkManagementStateForProjectsContent,
    setProjectsSelectedMenuItemId,
    openCreateTargetInStartPage,
    t,
    setSelectedOrgId,
    activeCloudOrgId,
    manageableCloudOrg,
    manageableLocalOrg,
    openOrganizationTab,
  });

  const {
    renderWorkstationMenuItemWrapper,
    handleSessionMenuItemClick,
    handleProjectsScopeMenuItemClick,
  } = useWorkstationSidebarMenuItemRouting({
    sessionMap,
    cloudRemoteRowMap,
    cloudRemoteViewerMap,
    tSessions,
    t,
    setWorkManagementProjectsView,
    openWorkManagementTab,
    openRuntimeTab,
    runtimeLabel,
    openTeamInboxTab,
    activateChatPanelTab,
    handleMenuItemClick,
    workItemsContentVisible,
    handleProjectsMenuItemClick,
    handleOpenInNewTab,
  });

  const sidebarOrgSelector = (
    <SidebarOrgSelector
      value={activeOrgId}
      options={orgSelectorOptions}
      addOrgLabel={addOrgLabel}
      cloudSignedInIdentity={cloudSignedInIdentity}
      manageLabel={manageOrgLabel}
      onChange={handleOrgSelectorChange}
      onAddOrg={handleAddOrgFromSelector}
      onCloudSignIn={handleCloudSignIn}
      onManageOrg={handleManageOrg}
    />
  );

  const resolvedMenuItemClick =
    activeSidebarKey === "projects"
      ? handleProjectsScopeMenuItemClick
      : handleSessionMenuItemClick;

  const resolvedMenuItemContextMenu =
    activeSidebarKey === "workstation" && !workItemsContentVisible
      ? handleMenuItemContextMenu
      : undefined;
  const resolvedRenderMenuItemWrapper =
    activeSidebarKey === "projects" || workItemsContentVisible
      ? renderProjectsMenuItemWrapper
      : renderWorkstationMenuItemWrapper;

  return {
    handleOpenSpotlight,
    sidebarOrgSelector,
    resolvedMenuItemClick,
    resolvedMenuItemContextMenu,
    resolvedRenderMenuItemWrapper,
  };
}
