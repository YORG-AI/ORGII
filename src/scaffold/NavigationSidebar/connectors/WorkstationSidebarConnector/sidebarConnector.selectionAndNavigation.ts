/**
 * Selected-menu-item resolution, collapsed-section-id handling, and
 * My-Station route activation for `WorkstationSidebarConnector`
 * (`index.tsx`). Bundles: the Work Items "reset to Launchpad" callback, the
 * session-vs-projects `selectedMenuItemId` derivation, the two
 * collapsed-section-id change handlers (each resetting the matching
 * section's visible-count map, plus cloud pagination on Team/My Sessions
 * collapse), and the route-activation + "new chat" callbacks used across
 * the rest of the connector.
 */
import type { TFunction } from "i18next";
import { useCallback } from "react";
import type { Location, NavigateFunction } from "react-router-dom";

import { ROUTES } from "@src/config/routes";
import type { GoToNewSessionOptions } from "@src/hooks/navigation/useAppNavigation";
import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";
import type { ChatPanelTabType } from "@src/store/chatPanel/chatPanelTabsAtom";
import type { SessionCreatorDraft } from "@src/store/session";
import type {
  ChatPanelContentMode,
  ChatPanelCreateTarget,
  ChatPanelNavigateCommand,
  ChatPanelSelectedProject,
  ChatPanelSelectedWorkItem,
} from "@src/store/ui/chatPanelAtom";
import { type StationMode } from "@src/store/ui/simulatorAtom";
import type {
  WorkManagementProjectsView,
  WorkManagementSection,
} from "@src/store/workstation";

import type { GroupByMode } from "../types";
import {
  CLOUD_MY_SESSIONS_SECTION_ID,
  CLOUD_TEAM_SESSIONS_SECTION_ID,
} from "./cloudScopedMenuItems";
import { resolveSelectedMenuItemIds } from "./menuSelection";
import {
  getProjectsSectionVisibleCountKey,
  getSessionSectionVisibleCountKey,
  resetNewlyCollapsedSectionVisibleCounts,
} from "./sectionPagination";
import { useSessionEntryActions } from "./sessionEntryActions";
import type { WorkstationSidebarKey } from "./types";
import { resolveWorkItemsSidebarMenuItemId } from "./workItemsSidebarMenuItems";

interface UseWorkstationSidebarSelectionAndNavigationParams {
  setStationMode: (mode: StationMode) => void;
  setStationChatVisible: (mode: StationMode, visible: boolean) => void;
  openStartPageTab: (options: { title: string }) => void;
  t: TFunction<"navigation">;
  projectsWorkItemMenuItems: NavigationMenuItem[];
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
  setProjectsGroupVisibleCounts: (
    updater: (currentVisibleCounts: Map<string, number>) => Map<string, number>
  ) => void;
  projectsCollapsedSectionIds: Set<string>;
  setProjectsCollapsedSectionIds: (
    nextCollapsedSectionIds: Set<string>
  ) => void;
  location: Location;
  navigate: NavigateFunction;
  goToNewSession: (options?: GoToNewSessionOptions) => void;
  navigateChatPanel: (command: ChatPanelNavigateCommand) => void;
  setChatPanelCreateTarget: (target: ChatPanelCreateTarget) => void;
}

export function useWorkstationSidebarSelectionAndNavigation({
  setStationMode,
  setStationChatVisible,
  openStartPageTab,
  t,
  projectsWorkItemMenuItems,
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
  setProjectsGroupVisibleCounts,
  projectsCollapsedSectionIds,
  setProjectsCollapsedSectionIds,
  location,
  navigate,
  goToNewSession,
  navigateChatPanel,
  setChatPanelCreateTarget,
}: UseWorkstationSidebarSelectionAndNavigationParams) {
  const resetWorkManagementStateForProjectsContent = useCallback(() => {
    const stationMode: StationMode = "my-station";
    setStationMode(stationMode);
    setStationChatVisible(stationMode, true);
    openStartPageTab({ title: t("routes.launchpad") });
  }, [openStartPageTab, setStationChatVisible, setStationMode, t]);

  const projectsSidebarMenuItems = projectsWorkItemMenuItems;
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
    workItemsContentVisible && projectsSelectedMenuItemId
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
  const handleProjectsCollapsedSectionIdsChange = useCallback(
    (nextCollapsedSectionIds: Set<string>) => {
      setProjectsGroupVisibleCounts((currentVisibleCounts) =>
        resetNewlyCollapsedSectionVisibleCounts({
          currentVisibleCounts,
          previousCollapsedSectionIds: projectsCollapsedSectionIds,
          nextCollapsedSectionIds,
          resolveVisibleCountKey: getProjectsSectionVisibleCountKey,
        })
      );
      setProjectsCollapsedSectionIds(nextCollapsedSectionIds);
    },
    [
      projectsCollapsedSectionIds,
      setProjectsCollapsedSectionIds,
      setProjectsGroupVisibleCounts,
    ]
  );
  const resolvedCollapsedSectionIds =
    activeSidebarKey === "projects" || workItemsContentVisible
      ? projectsCollapsedSectionIds
      : collapsedSectionIds;
  const resolvedOnCollapsedSectionIdsChange =
    activeSidebarKey === "projects" || workItemsContentVisible
      ? handleProjectsCollapsedSectionIdsChange
      : handleSessionCollapsedSectionIdsChange;

  const activateMyStationRouteForProjectsContent = useCallback(() => {
    const targetRoute = ROUTES.workStation.code.path;
    resetWorkManagementStateForProjectsContent();
    if (location.pathname !== targetRoute) navigate(targetRoute);
  }, [location.pathname, navigate, resetWorkManagementStateForProjectsContent]);

  const activateMyStationRouteForProjectTabContent = useCallback(() => {
    const stationMode: StationMode = "my-station";
    const targetRoute = ROUTES.workStation.code.path;
    setStationMode(stationMode);
    setStationChatVisible(stationMode, true);
    if (location.pathname !== targetRoute) navigate(targetRoute);
  }, [location.pathname, navigate, setStationChatVisible, setStationMode]);

  const openNewChatTab = useCallback(() => {
    openStartPageTab({ title: t("routes.launchpad") });
  }, [openStartPageTab, t]);

  const { handleGoToNewSession } = useSessionEntryActions({
    goToNewSession,
    navigateChatPanel,
    openNewChatTab,
    setChatPanelCreateTarget,
  });

  return {
    resetWorkManagementStateForProjectsContent,
    projectsSidebarMenuItems,
    selectedMenuItemId,
    resolvedCollapsedSectionIds,
    resolvedOnCollapsedSectionIdsChange,
    activateMyStationRouteForProjectsContent,
    activateMyStationRouteForProjectTabContent,
    handleGoToNewSession,
  };
}
