import { useCallback } from "react";

import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";

import type { SidebarTabDisposition } from "../sidebarTabNavigation";
import { useCloudChannelsSection } from "./channelsSection";
import { useLocalChannelsSection } from "./localChannelsSection";

/** Both controllers retain their sidebar lifetime; their existing scope gates select data. */
export function useChannelsSidebarSurface(activeCloudOrgId: string | null) {
  const cloud = useCloudChannelsSection({ orgId: activeCloudOrgId });
  const local = useLocalChannelsSection({ enabled: activeCloudOrgId === null });
  const { handleLocalChannelsItemClick } = local;
  const { handleChannelsItemClick } = cloud;
  const handleItemClick = useCallback(
    (
      item: NavigationMenuItem,
      disposition: SidebarTabDisposition = "replace-all"
    ): boolean =>
      handleLocalChannelsItemClick(item, disposition) ||
      handleChannelsItemClick(item, disposition),
    [handleLocalChannelsItemClick, handleChannelsItemClick]
  );
  return {
    menuItems:
      cloud.channelsMenuItems.length > 0
        ? cloud.channelsMenuItems
        : local.localChannelsMenuItems,
    cloudMenuItems: cloud.channelsMenuItems,
    selectedMenuItemId:
      local.selectedLocalChannelMenuItemId ?? cloud.selectedChannelMenuItemId,
    handleItemClick,
    cloudDialogs: cloud.channelsDialogs,
    localDialogs: local.localChannelsDialogs,
  };
}
