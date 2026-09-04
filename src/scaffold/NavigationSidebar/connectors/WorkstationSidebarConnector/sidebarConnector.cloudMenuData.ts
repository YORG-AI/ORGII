/**
 * Cloud Team-Sessions data for `WorkstationSidebarConnector` (`index.tsx`):
 * wraps `useCloudSessionsSection` and derives the two session-id sets that
 * keep My Conversations and Team Conversations from double-listing a row
 * (`sessionListExcludedIds`) or missing a cloud-tagged/local-origin row
 * (`cloudScopedExtraSessionIds`).
 *
 * Also mounts the cloud-org "Channels" section (`channelsSection.tsx`): its
 * rows join `cloudMenuItems` above Team Sessions and My Sessions, its
 * click resolver runs before the team-sessions one, its selected row (the
 * channel whose surface is the active chat-panel tab) takes precedence over
 * the team-sessions selection, and its dialogs surface through
 * `cloudChannelsDialogs` (rendered once in `SidebarDialogs`).
 */
import { useCallback, useMemo } from "react";

import type { CloudSessionFilter } from "@src/features/Org2Cloud/cloudSessionFilter";
import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";
import type { Session } from "@src/store/session";

import type { SidebarTabDisposition } from "../sidebarTabNavigation";
import { useCloudSessionsSection } from "./cloudSessionsSection";
import type { UseCloudSessionsSectionParams } from "./cloudSessionsSection.types";
import { useChannelsSidebarSurface } from "./useChannelsSidebarSurface";

interface UseWorkstationSidebarCloudMenuDataParams {
  activeCloudOrgId: string | null;
  sessions: Session[];
  cloudSessionFilter: CloudSessionFilter;
  activeSessionId: string;
  cloudMySessionsVisibleCount: number;
  revealedCloudOrgId: string | undefined;
  revealedSidebarItemId: string | undefined;
  openSessionAtDestination: UseCloudSessionsSectionParams["openSessionAtDestination"];
  handleCloudSessionFilterChange: (filter: CloudSessionFilter) => void;
  personalHiddenCloudTaggedIds: ReadonlySet<string> | undefined;
  cloudTaggedSessionIds: ReadonlySet<string> | undefined;
}

export function mergeCloudSidebarSections(
  channelsMenuItems: readonly NavigationMenuItem[],
  cloudSessionMenuItems: readonly NavigationMenuItem[]
): NavigationMenuItem[] {
  return channelsMenuItems.length === 0
    ? [...cloudSessionMenuItems]
    : [...channelsMenuItems, ...cloudSessionMenuItems];
}

export function useWorkstationSidebarCloudMenuData({
  activeCloudOrgId,
  sessions,
  cloudSessionFilter,
  activeSessionId,
  cloudMySessionsVisibleCount,
  revealedCloudOrgId,
  revealedSidebarItemId,
  openSessionAtDestination,
  handleCloudSessionFilterChange,
  personalHiddenCloudTaggedIds,
  cloudTaggedSessionIds,
}: UseWorkstationSidebarCloudMenuDataParams) {
  const {
    cloudMenuItems,
    cloudFlatListExcludedSessionIds,
    cloudLocalSessionIds,
    selectedCloudMenuItemId,
    handleCloudSessionItemClick,
    resetCloudTeamPagination,
    buildCloudRemoteItemMenuItems,
    cloudMemberFilterDropdown,
    cloudRemoteRowMap,
    cloudRemoteViewerMap,
  } = useCloudSessionsSection({
    orgId: activeCloudOrgId,
    sessions,
    filter: cloudSessionFilter,
    activeSessionId,
    localSessionHydrationLimit: cloudMySessionsVisibleCount,
    revealedMenuItemId:
      revealedCloudOrgId === activeCloudOrgId
        ? revealedSidebarItemId
        : undefined,
    openSessionAtDestination,
    onFilterChange: handleCloudSessionFilterChange,
  });

  const channels = useChannelsSidebarSurface(activeCloudOrgId);

  // Channels lead Team Sessions; the My Sessions separator is appended
  // downstream by buildCloudScopedMenuItems.
  const mergedCloudMenuItems = useMemo(
    () => mergeCloudSidebarSections(channels.cloudMenuItems, cloudMenuItems),
    [channels.cloudMenuItems, cloudMenuItems]
  );

  // Channel rows resolve first: their ids can never collide with
  // `cloudremote-` / pagination ids, so an early claim is unambiguous.
  const { handleItemClick: handleChannelsItemClick } = channels;
  const handleCloudScopedItemClick = useCallback(
    (item: NavigationMenuItem, disposition: SidebarTabDisposition): boolean =>
      handleChannelsItemClick(item, disposition) ||
      handleCloudSessionItemClick(item, disposition),
    [handleChannelsItemClick, handleCloudSessionItemClick]
  );

  // Read-only teammate replay caches stay behind their Team Conversation row.
  // Writable current-device originals remain in the My Conversations list.
  const sessionListExcludedIds = useMemo(() => {
    if (!personalHiddenCloudTaggedIds) return cloudFlatListExcludedSessionIds;
    if (cloudFlatListExcludedSessionIds.size === 0) {
      return personalHiddenCloudTaggedIds;
    }
    return new Set([
      ...cloudFlatListExcludedSessionIds,
      ...personalHiddenCloudTaggedIds,
    ]);
  }, [cloudFlatListExcludedSessionIds, personalHiddenCloudTaggedIds]);
  const cloudScopedExtraSessionIds = useMemo(() => {
    if (!activeCloudOrgId || cloudLocalSessionIds.size === 0) {
      return cloudTaggedSessionIds;
    }
    return new Set([...(cloudTaggedSessionIds ?? []), ...cloudLocalSessionIds]);
  }, [activeCloudOrgId, cloudLocalSessionIds, cloudTaggedSessionIds]);

  return {
    cloudMenuItems: mergedCloudMenuItems,
    cloudSessionMenuItems: cloudMenuItems,
    channelMenuItems: channels.menuItems,
    // An open channel surface wins over the team-sessions selection: it is
    // the tab the pane is actually showing.
    selectedCloudMenuItemId:
      channels.selectedMenuItemId ?? selectedCloudMenuItemId,
    handleCloudSessionItemClick: handleCloudScopedItemClick,
    resetCloudTeamPagination,
    buildCloudRemoteItemMenuItems,
    cloudMemberFilterDropdown,
    cloudRemoteRowMap,
    cloudRemoteViewerMap,
    sessionListExcludedIds,
    cloudScopedExtraSessionIds,
    cloudChannelsDialogs: channels.cloudDialogs,
    localChannelsDialogs: channels.localDialogs,
  };
}
