/**
 * Sidebar "chrome" for `WorkstationSidebarConnector` (`index.tsx`): the
 * single call site for the three tightly-sequenced hooks that build the
 * sidebar's header/menu-routing surface — `useWorkstationSidebarOrgSelectorActions`,
 * `useWorkstationSidebarMenuItemRouting`, and this file's own Work Items
 * submenu open/back handlers, back-nav header + org selector JSX, and the
 * scope-resolved `NavigationSidebar` props (menu-item click, context menu,
 * row wrapper). Consolidated into one call so `index.tsx` doesn't have to
 * thread the org-selector/menu-routing handoff itself.
 */
import { ChevronLeft } from "lucide-react";
import { useCallback } from "react";

import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";

import { SidebarHeaderNavButton } from "../../blocks";
import SidebarOrgSelector from "../SidebarOrgSelector";
import { WORK_ITEMS_MENU_ITEM_ID } from "../sidebarConnectorUtils";
import { useWorkstationSidebarMenuItemRouting } from "./sidebarConnector.menuItemRouting";
import { useWorkstationSidebarOrgSelectorActions } from "./sidebarConnector.orgSelectorActions";
import type { WorkstationSidebarKey } from "./types";

type SidebarOrgSelectorProps = Parameters<typeof SidebarOrgSelector>[0];
type OrgSelectorActionsParams = Parameters<
  typeof useWorkstationSidebarOrgSelectorActions
>[0];
type MenuItemRoutingParams = Parameters<
  typeof useWorkstationSidebarMenuItemRouting
>[0];

interface UseWorkstationSidebarChromeParams {
  setWorkItemsOpen: (open: boolean) => void;
  handleSidebarLayerChange: (key: WorkstationSidebarKey) => void;
  projectsSidebarVisible: boolean;
  workItemsLabel: string;
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
  projectsLinearWorkItemMap: MenuItemRoutingParams["projectsLinearWorkItemMap"];
  projectsWorkItemMap: MenuItemRoutingParams["projectsWorkItemMap"];
  tSessions: MenuItemRoutingParams["tSessions"];
  setWorkManagementProjectsView: MenuItemRoutingParams["setWorkManagementProjectsView"];
  openWorkManagementTab: MenuItemRoutingParams["openWorkManagementTab"];
  openRuntimeTab: MenuItemRoutingParams["openRuntimeTab"];
  runtimeLabel: string;
  activateChatPanelTab: MenuItemRoutingParams["activateChatPanelTab"];
  handleMenuItemClick: MenuItemRoutingParams["handleMenuItemClick"];
  handleProjectsMenuItemClick: MenuItemRoutingParams["handleProjectsMenuItemClick"];
  handleOpenInNewTab: MenuItemRoutingParams["handleOpenInNewTab"];
}

export function useWorkstationSidebarChrome({
  setWorkItemsOpen,
  handleSidebarLayerChange,
  projectsSidebarVisible,
  workItemsLabel,
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
  projectsLinearWorkItemMap,
  projectsWorkItemMap,
  tSessions,
  setWorkManagementProjectsView,
  openWorkManagementTab,
  openRuntimeTab,
  runtimeLabel,
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
    renderProjectsMenuItemWrapper,
    handleSessionMenuItemClick,
  } = useWorkstationSidebarMenuItemRouting({
    sessionMap,
    cloudRemoteRowMap,
    cloudRemoteViewerMap,
    projectsLinearWorkItemMap,
    projectsWorkItemMap,
    tSessions,
    t,
    setWorkManagementProjectsView,
    openWorkManagementTab,
    openRuntimeTab,
    runtimeLabel,
    activateChatPanelTab,
    handleMenuItemClick,
    workItemsContentVisible,
    handleProjectsMenuItemClick,
    handleOpenInNewTab,
  });

  const handleBackToSessionSidebar = useCallback(() => {
    setWorkItemsOpen(false);
    handleSidebarLayerChange("workstation");
  }, [handleSidebarLayerChange, setWorkItemsOpen]);

  const handleSubmenuOpenChange = useCallback(
    (key: string, open: boolean) => {
      // Opening the legacy submenu is the transition into the dedicated Work
      // Items layer. Once entered, that layer owns its lifecycle: unmounting
      // the parent submenu may report `open=false`, but only the visible Back
      // action should navigate the user out again.
      if (key === WORK_ITEMS_MENU_ITEM_ID && open) setWorkItemsOpen(true);
    },
    [setWorkItemsOpen]
  );

  const sidebarLayerHeader = !projectsSidebarVisible ? null : (
    <div className="shrink-0 px-3">
      <SidebarHeaderNavButton
        icon={ChevronLeft}
        label={workItemsLabel}
        onClick={handleBackToSessionSidebar}
      />
    </div>
  );

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
      ? handleProjectsMenuItemClick
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
    handleSubmenuOpenChange,
    sidebarLayerHeader,
    sidebarOrgSelector,
    resolvedMenuItemClick,
    resolvedMenuItemContextMenu,
    resolvedRenderMenuItemWrapper,
  };
}
