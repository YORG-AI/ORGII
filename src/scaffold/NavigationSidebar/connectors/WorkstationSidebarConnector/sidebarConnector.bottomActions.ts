/**
 * Bottom-bar actions, the loading flag, and the resolved selected-menu-item
 * id for `WorkstationSidebarConnector` (`index.tsx`). Also fires the
 * sidebar-memory persistence hook (`useWorkstationSidebarMemory`), which is
 * a pure side effect keyed off the same section/selection state.
 */
import { useCallback, useMemo } from "react";

import { createLogger } from "@src/hooks/logger";
import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";
import { type Session, markAllSessionsVisited } from "@src/store/session";

import { getAllSectionIds } from "../workstationSidebarData";
import { useSidebarBottomRightActions } from "./bottomActions";
import { useWorkstationSidebarMemory } from "./sidebarMemory";
import { rescanSidebarSessions } from "./sidebarSessionRefresh";
import type { WorkstationSidebarKey } from "./types";

const logger = createLogger("WorkstationSidebar");

type BottomRightActionsParams = Parameters<
  typeof useSidebarBottomRightActions
>[0];

interface UseWorkstationSidebarBottomActionsParams {
  sidebarMenuItems: NavigationMenuItem[];
  resolvedOnCollapsedSectionIdsChange: (
    nextCollapsedSectionIds: Set<string>
  ) => void;
  sessions: Session[];
  workItemsContentVisible: boolean;
  activeSidebarKey: WorkstationSidebarKey;
  projectsWorkItemsLoading: boolean;
  projectsSidebarMenuItems: NavigationMenuItem[];
  sessionsLoading: boolean;
  groupByMode: BottomRightActionsParams["groupByMode"];
  includeExternal: boolean;
  setGroupByMode: BottomRightActionsParams["setGroupByMode"];
  setIncludeExternal: BottomRightActionsParams["setIncludeExternal"];
  selectedCloudMenuItemId: string | null;
  selectedMenuItemId: string;
  activeSessionId: string;
  collapsedSectionIds: Set<string>;
  pinnedMenuItems: NavigationMenuItem[];
}

export function useWorkstationSidebarBottomActions({
  sidebarMenuItems,
  resolvedOnCollapsedSectionIdsChange,
  sessions,
  workItemsContentVisible,
  activeSidebarKey,
  projectsWorkItemsLoading,
  projectsSidebarMenuItems,
  sessionsLoading,
  groupByMode,
  includeExternal,
  setGroupByMode,
  setIncludeExternal,
  selectedCloudMenuItemId,
  selectedMenuItemId,
  activeSessionId,
  collapsedSectionIds,
  pinnedMenuItems,
}: UseWorkstationSidebarBottomActionsParams) {
  const allSectionIds = useMemo(
    () => getAllSectionIds(sidebarMenuItems),
    [sidebarMenuItems]
  );
  const handleCollapseAll = useCallback(() => {
    resolvedOnCollapsedSectionIdsChange(new Set(allSectionIds));
  }, [allSectionIds, resolvedOnCollapsedSectionIdsChange]);
  const handleMarkAllRead = useCallback(() => {
    markAllSessionsVisited(sessions.map((session) => session.session_id));
  }, [sessions]);
  const handleRefreshSessions = useCallback(() => {
    void rescanSidebarSessions().catch((error) => {
      logger.warn("Failed to rescan sidebar sessions:", error);
    });
  }, []);
  const isLoading =
    workItemsContentVisible || activeSidebarKey === "projects"
      ? projectsWorkItemsLoading && projectsSidebarMenuItems.length === 0
      : sessionsLoading && sessions.length === 0;
  const sidebarBottomRightActions = useSidebarBottomRightActions({
    activeSidebarKey: workItemsContentVisible ? "projects" : activeSidebarKey,
    groupByMode,
    includeExternal,
    handleCollapseAll,
    handleMarkAllRead,
    handleRefreshSessions,
    setGroupByMode,
    setIncludeExternal,
  });

  const resolvedSelectedMenuItemId =
    activeSidebarKey === "workstation" && selectedCloudMenuItemId
      ? selectedCloudMenuItemId
      : selectedMenuItemId;

  useWorkstationSidebarMemory({
    activeSessionId,
    activeSidebarKey,
    allSectionIds,
    collapsedSectionIds,
    groupByMode,
    pinnedMenuItems,
    selectedMenuItemId: resolvedSelectedMenuItemId,
    sidebarMenuItems,
    tabCount: 0,
  });

  return {
    isLoading,
    sidebarBottomRightActions,
    resolvedSelectedMenuItemId,
  };
}
