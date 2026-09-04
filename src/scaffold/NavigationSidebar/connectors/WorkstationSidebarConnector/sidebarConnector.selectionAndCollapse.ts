/** Shared selection precedence and session collapse pagination. Work-item state stays in its surface. */
import { useCallback } from "react";

import type { ChatPanelTabType } from "@src/store/chatPanel/chatPanelTabsAtom";
import type { SessionCreatorDraft } from "@src/store/session";
import type {
  ChatPanelContentMode,
  ChatPanelCreateTarget,
  ChatPanelSelectedProject,
  ChatPanelSelectedWorkItem,
} from "@src/store/ui/chatPanelAtom";
import type {
  WorkManagementProjectsView,
  WorkManagementSection,
} from "@src/store/workstation";

import { TEAM_INBOX_MENU_ITEM_ID } from "../sidebarConnectorUtils";
import type { GroupByMode } from "../types";
import {
  CLOUD_MY_SESSIONS_SECTION_ID,
  CLOUD_TEAM_SESSIONS_SECTION_ID,
} from "./cloudScopedMenuItems";
import { resolveSelectedMenuItemIds } from "./menuSelection";
import {
  getSessionSectionVisibleCountKey,
  resetNewlyCollapsedSectionVisibleCounts,
} from "./sectionPagination";
import type { WorkstationSidebarKey } from "./types";
import { resolveWorkItemsSidebarMenuItemId } from "./workItemsSidebarMenuItems";

interface UseWorkstationSidebarSelectionAndCollapseParams {
  activeSessionCreatorDraftId: string | null | undefined;
  highlightedSessionId: string;
  activeSidebarKey: WorkstationSidebarKey;
  activeChatPanelTabType: ChatPanelTabType | null;
  chatPanelContentMode: ChatPanelContentMode;
  chatPanelCreateTarget: ChatPanelCreateTarget;
  chatPanelSelectedProject: ChatPanelSelectedProject | null;
  chatPanelSelectedWorkItem: ChatPanelSelectedWorkItem | null;
  projectsSelectedMenuItemId: string;
  sessionCreatorDrafts: readonly SessionCreatorDraft[];
  workItemsContentVisible: boolean;
  activeWorkManagementSection: WorkManagementSection;
  workManagementProjectsView: WorkManagementProjectsView;
  setGroupVisibleCounts: (
    updater: (currentVisibleCounts: Map<string, number>) => Map<string, number>
  ) => void;
  collapsedSectionIds: Set<string>;
  groupByMode: GroupByMode;
  resetCloudTeamPagination: () => void;
  resetCloudMyPagination: () => void;
  setCollapsedSectionIds: (nextCollapsedSectionIds: Set<string>) => void;
}

export function useWorkstationSidebarSelectionAndCollapse({
  activeSessionCreatorDraftId,
  highlightedSessionId,
  activeSidebarKey,
  activeChatPanelTabType,
  chatPanelContentMode,
  chatPanelCreateTarget,
  chatPanelSelectedProject,
  chatPanelSelectedWorkItem,
  projectsSelectedMenuItemId,
  sessionCreatorDrafts,
  workItemsContentVisible,
  activeWorkManagementSection,
  workManagementProjectsView,
  setGroupVisibleCounts,
  collapsedSectionIds,
  groupByMode,
  resetCloudTeamPagination,
  resetCloudMyPagination,
  setCollapsedSectionIds,
}: UseWorkstationSidebarSelectionAndCollapseParams) {
  const { selectedMenuItemId: baseSelectedMenuItemId } =
    resolveSelectedMenuItemIds({
      activeSessionCreatorDraftId,
      activeSessionId: highlightedSessionId,
      activeSidebarKey,
      activeChatPanelTabType,
      chatPanelContentMode,
      chatPanelCreateTarget,
      chatPanelSelectedProject,
      chatPanelSelectedWorkItem,
      projectsSelectedMenuItemId,
      sessionCreatorDrafts,
    });
  const selectedMenuItemId =
    activeChatPanelTabType === "team-inbox"
      ? TEAM_INBOX_MENU_ITEM_ID
      : workItemsContentVisible && projectsSelectedMenuItemId
        ? projectsSelectedMenuItemId
        : activeSidebarKey === "workstation" &&
            activeChatPanelTabType === "work-management"
          ? resolveWorkItemsSidebarMenuItemId({
              homeTab: activeWorkManagementSection,
              projectsView: workManagementProjectsView,
            })
          : baseSelectedMenuItemId;
  const handleSessionCollapsedSectionIdsChange = useCallback(
    (nextCollapsedSectionIds: Set<string>) => {
      setGroupVisibleCounts((currentVisibleCounts) =>
        resetNewlyCollapsedSectionVisibleCounts({
          currentVisibleCounts,
          previousCollapsedSectionIds: collapsedSectionIds,
          nextCollapsedSectionIds,
          resolveVisibleCountKey: (sectionId) =>
            getSessionSectionVisibleCountKey(sectionId, groupByMode),
        })
      );

      if (
        !collapsedSectionIds.has(CLOUD_TEAM_SESSIONS_SECTION_ID) &&
        nextCollapsedSectionIds.has(CLOUD_TEAM_SESSIONS_SECTION_ID)
      ) {
        resetCloudTeamPagination();
      }
      if (
        !collapsedSectionIds.has(CLOUD_MY_SESSIONS_SECTION_ID) &&
        nextCollapsedSectionIds.has(CLOUD_MY_SESSIONS_SECTION_ID)
      ) {
        resetCloudMyPagination();
      }

      setCollapsedSectionIds(nextCollapsedSectionIds);
    },
    [
      collapsedSectionIds,
      groupByMode,
      resetCloudMyPagination,
      resetCloudTeamPagination,
      setCollapsedSectionIds,
      setGroupVisibleCounts,
    ]
  );

  return {
    selectedMenuItemId,
    handleSessionCollapsedSectionIdsChange,
  };
}
