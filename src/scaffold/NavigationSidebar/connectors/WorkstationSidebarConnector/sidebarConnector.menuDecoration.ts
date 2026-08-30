/**
 * Row-action decoration, cloud/session menu-item merging, and the
 * Projects-tab click router for `WorkstationSidebarConnector` (`index.tsx`).
 * Wires up the move-to-org / cloud-sync-level / cloud-share dialogs, the
 * session context menu they attach to, per-row hover-action decoration
 * (pin/unpin, more-menu, subagent expand), the final `sidebarMenuItems`
 * list (session vs. projects scope), and `useProjectsMenuItemClick`.
 */
import { useMemo } from "react";

import { useCloudSessionShareDialog } from "@src/features/Org2Cloud/CloudSessionShareDialog/useCloudSessionShareDialog";
import { useCloudSyncLevelDialog } from "@src/features/Org2Cloud/CloudSyncLevelDialog/useCloudSyncLevelDialog";
import { useCopySessionReference } from "@src/features/Org2Cloud/useCopySessionReference";
import { useMoveToOrgDialog } from "@src/features/TeamCollaboration/components/MoveToOrgDialog/useMoveToOrgDialog";
import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";

import type {
  LinearOrgRecord,
  SidebarLinearWorkItem,
  SidebarLocalOrgRecord,
  SidebarProject,
  SidebarWorkItem,
} from "../useProjectsWorkItemMenuItems/types";
import { useWorkstationSidebarContextMenu } from "../useWorkstationSidebarContextMenu";
import { buildCloudScopedMenuItems } from "./cloudScopedMenuItems";
import { useDecorateSessionRowActions } from "./sessionRowActions";
import type { WorkstationSidebarKey } from "./types";
import { useProjectsMenuItemClick } from "./useProjectsMenuItemClick";

type ContextMenuParams = Parameters<typeof useWorkstationSidebarContextMenu>[0];
type DecorateRowActionsParams = Parameters<
  typeof useDecorateSessionRowActions
>[0];
// Explicit generic args: the real `Project`/`WorkItem`/`LocalOrg`/`LinearOrg`/
// `LinearWorkItem` types produced by `useProjectsWorkItemMenuItems`. Without
// these, `Parameters<typeof useProjectsMenuItemClick>[0]` resolves every
// generic to `unknown`, widening fields like `toChatPanelProject` and
// dropping `openLinearOrg`/`openLinearWorkItem` entirely.
type ProjectsMenuItemClickParams = Parameters<
  typeof useProjectsMenuItemClick<
    SidebarProject,
    SidebarWorkItem,
    SidebarLocalOrgRecord,
    LinearOrgRecord,
    SidebarLinearWorkItem
  >
>[0];

interface UseWorkstationSidebarMenuDecorationParams {
  sessionMap: ContextMenuParams["sessionMap"];
  rename: ContextMenuParams["rename"];
  handleDeleteSession: ContextMenuParams["handleDeleteSession"];
  deleteSessionCreatorDraft: DecorateRowActionsParams["deleteSessionCreatorDraft"];
  handleExportMarkdown: ContextMenuParams["handleExportMarkdown"];
  handleOpenInNewTab: ContextMenuParams["handleOpenInNewTab"];
  handleOpenInMyStation: ContextMenuParams["handleOpenInMyStation"];
  handleTogglePin: ContextMenuParams["handleTogglePin"];
  handleToggleSubagentExpansion: DecorateRowActionsParams["handleToggleSubagentExpansion"];
  buildCloudRemoteItemMenuItems: ContextMenuParams["buildCloudRemoteItemMenuItems"];
  t: (key: string) => string;
  tCommon: DecorateRowActionsParams["tCommon"];
  activeSessionMoreMenuId: DecorateRowActionsParams["activeSessionMoreMenuId"];
  expandedSubagentParentIds: DecorateRowActionsParams["expandedSubagentParentIds"];
  pinFolderLabel: string;
  unpinFolderLabel: string;
  setActiveSessionMoreMenuId: DecorateRowActionsParams["setActiveSessionMoreMenuId"];
  subagentParentIds: DecorateRowActionsParams["subagentParentIds"];
  cloudSessionMenuItems: NavigationMenuItem[];
  channelSidebarMenuItems: NavigationMenuItem[];
  channelSidebarVisible: boolean;
  sessionSidebarMenuItems: NavigationMenuItem[];
  cloudMySessionsVisibleCount: number;
  activeSidebarKey: WorkstationSidebarKey;
  workItemsContentVisible: boolean;
  projectsSidebarMenuItems: NavigationMenuItem[];
  activateMyStationRouteForProjectTabContent: ProjectsMenuItemClickParams["activateMyStationRouteForProjectTabContent"];
  activateMyStationRouteForProjectsContent: ProjectsMenuItemClickParams["activateMyStationRouteForProjectsContent"];
  getProjectsLoadMoreGroupId: ProjectsMenuItemClickParams["getProjectsLoadMoreGroupId"];
  loadProjectsLinearOrgWorkItems: ProjectsMenuItemClickParams["loadProjectsLinearOrgWorkItems"];
  openProjectsLinearOrg: ProjectsMenuItemClickParams["openProjectsLinearOrg"];
  openProjectsLinearWorkItem: ProjectsMenuItemClickParams["openProjectsLinearWorkItem"];
  projectsLinearOrgMap: ProjectsMenuItemClickParams["projectsLinearOrgMap"];
  projectsLinearWorkItemMap: ProjectsMenuItemClickParams["projectsLinearWorkItemMap"];
  projectsLocalOrgMap: ProjectsMenuItemClickParams["projectsLocalOrgMap"];
  projectsProjectMap: ProjectsMenuItemClickParams["projectsProjectMap"];
  projectsWorkItemMap: ProjectsMenuItemClickParams["projectsWorkItemMap"];
  projectsLinkedSessionIds: ProjectsMenuItemClickParams["linkedSessionIds"];
  handleOpenLinkedWorkItemSession: ProjectsMenuItemClickParams["openLinkedSession"];
  resetWorkManagementStateForProjectsContent: ProjectsMenuItemClickParams["resetWorkManagementStateForProjectsContent"];
  setProjectsGroupVisibleCounts: ProjectsMenuItemClickParams["setProjectsGroupVisibleCounts"];
  setProjectsSelectedMenuItemId: ProjectsMenuItemClickParams["setProjectsSelectedMenuItemId"];
  toChatPanelProject: ProjectsMenuItemClickParams["toChatPanelProject"];
  toChatPanelWorkItem: ProjectsMenuItemClickParams["toChatPanelWorkItem"];
}

export function useWorkstationSidebarMenuDecoration({
  sessionMap,
  rename,
  handleDeleteSession,
  deleteSessionCreatorDraft,
  handleExportMarkdown,
  handleOpenInNewTab,
  handleOpenInMyStation,
  handleTogglePin,
  handleToggleSubagentExpansion,
  buildCloudRemoteItemMenuItems,
  t,
  tCommon,
  activeSessionMoreMenuId,
  expandedSubagentParentIds,
  pinFolderLabel,
  unpinFolderLabel,
  setActiveSessionMoreMenuId,
  subagentParentIds,
  cloudSessionMenuItems,
  channelSidebarMenuItems,
  channelSidebarVisible,
  sessionSidebarMenuItems,
  cloudMySessionsVisibleCount,
  activeSidebarKey,
  workItemsContentVisible,
  projectsSidebarMenuItems,
  activateMyStationRouteForProjectTabContent,
  activateMyStationRouteForProjectsContent,
  getProjectsLoadMoreGroupId,
  loadProjectsLinearOrgWorkItems,
  openProjectsLinearOrg,
  openProjectsLinearWorkItem,
  projectsLinearOrgMap,
  projectsLinearWorkItemMap,
  projectsLocalOrgMap,
  projectsProjectMap,
  projectsWorkItemMap,
  projectsLinkedSessionIds,
  handleOpenLinkedWorkItemSession,
  resetWorkManagementStateForProjectsContent,
  setProjectsGroupVisibleCounts,
  setProjectsSelectedMenuItemId,
  toChatPanelProject,
  toChatPanelWorkItem,
}: UseWorkstationSidebarMenuDecorationParams) {
  const moveToOrg = useMoveToOrgDialog();
  const cloudSyncLevel = useCloudSyncLevelDialog();
  const cloudShare = useCloudSessionShareDialog();
  const copyReference = useCopySessionReference();
  const handleMenuItemContextMenu = useWorkstationSidebarContextMenu({
    sessionMap,
    rename,
    handleDeleteSession,
    handleDeleteDraft: deleteSessionCreatorDraft,
    handleExportMarkdown,
    handleOpenInNewTab,
    handleOpenInMyStation,
    handleTogglePin,
    isMoveEligible: moveToOrg.isMoveEligible,
    handleOpenMoveToOrg: moveToOrg.openMoveToOrg,
    moveToOrgLabel: t("cloud.moveToOrg.menuItem"),
    isCloudSyncLevelEligible: cloudSyncLevel.isSyncLevelEligible,
    handleOpenCloudSyncLevel: cloudSyncLevel.openSyncLevel,
    cloudSyncLevelLabel: t("cloud.syncLevel.menuItem"),
    isCloudShareEligible: cloudShare.isCloudShareEligible,
    handleOpenCloudShare: cloudShare.openCloudShare,
    cloudShareLabel: t("cloud.share.menuItem"),
    isCopyReferenceEligible: copyReference.isCopyReferenceEligible,
    handleCopyReference: copyReference.handleCopyReference,
    copyReferenceLabel: copyReference.copyReferenceLabel,
    buildCloudRemoteItemMenuItems,
    tCommon,
  });

  const decorateSessionRowActions = useDecorateSessionRowActions({
    activeSessionMoreMenuId,
    deleteSessionCreatorDraft,
    handleMenuItemContextMenu,
    handleTogglePin,
    handleToggleSubagentExpansion,
    expandedSubagentParentIds,
    pinLabel: pinFolderLabel,
    sessionMap,
    setActiveSessionMoreMenuId,
    subagentParentIds,
    tCommon,
    unpinLabel: unpinFolderLabel,
  });
  const decoratedSessionSidebarMenuItems = useMemo(() => {
    const scoped = buildCloudScopedMenuItems({
      cloudMenuItems: cloudSessionMenuItems,
      // Cloud rows already carry Replay/Fork actions, so only local rows
      // use the regular session action decoration.
      sessionMenuItems: decorateSessionRowActions(sessionSidebarMenuItems),
      mySessionsLabel: t("cloud.sidebar.mySessions"),
      pinnedLabel: tCommon("sessions:chat.historyPinned", "Pinned"),
      mySessionsVisibleCount: cloudMySessionsVisibleCount,
      loadMoreLabel: tCommon("common:actions.loadMore", "Load more"),
    });
    return scoped;
  }, [
    cloudSessionMenuItems,
    cloudMySessionsVisibleCount,
    decorateSessionRowActions,
    sessionSidebarMenuItems,
    t,
    tCommon,
  ]);
  const sidebarMenuItems =
    activeSidebarKey === "projects" || workItemsContentVisible
      ? projectsSidebarMenuItems
      : channelSidebarVisible
        ? channelSidebarMenuItems
        : decoratedSessionSidebarMenuItems;
  const handleProjectsMenuItemClick = useProjectsMenuItemClick({
    activateMyStationRouteForProjectTabContent,
    activateMyStationRouteForProjectsContent,
    getProjectsLoadMoreGroupId,
    loadProjectsLinearOrgWorkItems,
    openProjectsLinearOrg,
    openProjectsLinearWorkItem: openProjectsLinearWorkItem,
    projectsLinearOrgMap,
    projectsLinearWorkItemMap,
    projectsLocalOrgMap,
    projectsProjectMap,
    projectsWorkItemMap,
    linkedSessionIds: projectsLinkedSessionIds,
    openLinkedSession: handleOpenLinkedWorkItemSession,
    resetWorkManagementStateForProjectsContent,
    setProjectsGroupVisibleCounts,
    setProjectsSelectedMenuItemId,
    toChatPanelProject,
    toChatPanelWorkItem,
  });

  return {
    moveToOrg,
    cloudSyncLevel,
    cloudShare,
    handleMenuItemContextMenu,
    sidebarMenuItems,
    handleProjectsMenuItemClick,
  };
}
