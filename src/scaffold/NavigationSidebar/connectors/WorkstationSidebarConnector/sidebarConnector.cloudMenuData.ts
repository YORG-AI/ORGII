/**
 * Cloud Team-Sessions data for `WorkstationSidebarConnector` (`index.tsx`):
 * wraps `useCloudSessionsSection` and derives the two session-id sets that
 * keep My Conversations and Team Conversations from double-listing a row
 * (`sessionListExcludedIds`) or missing a cloud-tagged/local-origin row
 * (`cloudScopedExtraSessionIds`).
 */
import { useMemo } from "react";

import type { CloudSessionFilter } from "@src/features/Org2Cloud/cloudSessionFilter";
import type { Session } from "@src/store/session";

import { useCloudSessionsSection } from "./cloudSessionsSection";

interface UseWorkstationSidebarCloudMenuDataParams {
  activeCloudOrgId: string | null;
  sessions: Session[];
  cloudSessionFilter: CloudSessionFilter;
  activeSessionId: string;
  cloudMySessionsVisibleCount: number;
  revealedCloudOrgId: string | undefined;
  revealedSidebarItemId: string | undefined;
  handleCloudSessionFilterChange: (filter: CloudSessionFilter) => void;
  personalHiddenCloudTaggedIds: ReadonlySet<string> | undefined;
  cloudTaggedSessionIds: ReadonlySet<string> | undefined;
}

export function useWorkstationSidebarCloudMenuData({
  activeCloudOrgId,
  sessions,
  cloudSessionFilter,
  activeSessionId,
  cloudMySessionsVisibleCount,
  revealedCloudOrgId,
  revealedSidebarItemId,
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
    handleCloudRemoteItemRemove,
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
    onFilterChange: handleCloudSessionFilterChange,
  });

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
    cloudMenuItems,
    selectedCloudMenuItemId,
    handleCloudSessionItemClick,
    resetCloudTeamPagination,
    handleCloudRemoteItemRemove,
    cloudMemberFilterDropdown,
    cloudRemoteRowMap,
    cloudRemoteViewerMap,
    sessionListExcludedIds,
    cloudScopedExtraSessionIds,
  };
}
