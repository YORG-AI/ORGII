/** Owns session context menus, row actions, and their persistent dialogs. */
import { useMemo, useState } from "react";

import { useCloudSessionShareDialog } from "@src/features/Org2Cloud/CloudSessionShareDialog/useCloudSessionShareDialog";
import { useCloudSyncLevelDialog } from "@src/features/Org2Cloud/CloudSyncLevelDialog/useCloudSyncLevelDialog";
import { useCopySessionReference } from "@src/features/Org2Cloud/useCopySessionReference";
import { useMoveToOrgDialog } from "@src/features/TeamCollaboration/components/MoveToOrgDialog/useMoveToOrgDialog";
import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";

import { useWorkstationSidebarContextMenu } from "../useWorkstationSidebarContextMenu";
import { buildCloudScopedMenuItems } from "./cloudScopedMenuItems";
import { useDecorateSessionRowActions } from "./sessionRowActions";

type ContextMenuParams = Parameters<typeof useWorkstationSidebarContextMenu>[0];
type DecorateRowActionsParams = Parameters<
  typeof useDecorateSessionRowActions
>[0];
interface UseSessionSidebarRowActionsParams {
  sessionMap: ContextMenuParams["sessionMap"];
  rename: ContextMenuParams["rename"];
  handleDeleteSession: ContextMenuParams["handleDeleteSession"];
  deleteSessionCreatorDraft: DecorateRowActionsParams["deleteSessionCreatorDraft"];
  handleOpenDraftInNewTab: ContextMenuParams["handleOpenDraftInNewTab"];
  handleExportMarkdown: ContextMenuParams["handleExportMarkdown"];
  handleOpenInNewTab: ContextMenuParams["handleOpenInNewTab"];
  handleOpenInNewWindow: ContextMenuParams["handleOpenInNewWindow"];
  handleOpenInMyStation: ContextMenuParams["handleOpenInMyStation"];
  handleTogglePin: ContextMenuParams["handleTogglePin"];
  handleToggleSubagentExpansion: DecorateRowActionsParams["handleToggleSubagentExpansion"];
  buildCloudRemoteItemMenuItems: ContextMenuParams["buildCloudRemoteItemMenuItems"];
  t: (key: string) => string;
  tCommon: DecorateRowActionsParams["tCommon"];
  expandedSubagentParentIds: DecorateRowActionsParams["expandedSubagentParentIds"];
  pinFolderLabel: string;
  unpinFolderLabel: string;
  subagentParentIds: DecorateRowActionsParams["subagentParentIds"];
  cloudSessionMenuItems: NavigationMenuItem[];
  sessionSidebarMenuItems: NavigationMenuItem[];
  cloudMySessionsVisibleCount: number;
}

export function useSessionSidebarRowActions({
  sessionMap,
  rename,
  handleDeleteSession,
  deleteSessionCreatorDraft,
  handleOpenDraftInNewTab,
  handleExportMarkdown,
  handleOpenInNewTab,
  handleOpenInNewWindow,
  handleOpenInMyStation,
  handleTogglePin,
  handleToggleSubagentExpansion,
  buildCloudRemoteItemMenuItems,
  t,
  tCommon,
  expandedSubagentParentIds,
  pinFolderLabel,
  unpinFolderLabel,
  subagentParentIds,
  cloudSessionMenuItems,
  sessionSidebarMenuItems,
  cloudMySessionsVisibleCount,
}: UseSessionSidebarRowActionsParams) {
  const [activeSessionMoreMenuId, setActiveSessionMoreMenuId] = useState("");
  const moveToOrg = useMoveToOrgDialog();
  const cloudSyncLevel = useCloudSyncLevelDialog();
  const cloudShare = useCloudSessionShareDialog();
  const copyReference = useCopySessionReference();
  const handleMenuItemContextMenu = useWorkstationSidebarContextMenu({
    sessionMap,
    rename,
    handleDeleteSession,
    handleDeleteDraft: deleteSessionCreatorDraft,
    handleOpenDraftInNewTab,
    handleExportMarkdown,
    handleOpenInNewTab,
    handleOpenInNewWindow,
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

  return {
    moveToOrg,
    cloudSyncLevel,
    cloudShare,
    handleMenuItemContextMenu,
    menuItems: decoratedSessionSidebarMenuItems,
  };
}
