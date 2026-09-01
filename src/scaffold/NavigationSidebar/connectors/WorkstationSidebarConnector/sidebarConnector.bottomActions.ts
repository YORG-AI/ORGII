/**
 * Bottom-bar actions, the loading flag, and the resolved selected-menu-item
 * id for `WorkstationSidebarConnector` (`index.tsx`). Also fires the
 * sidebar-memory persistence hook (`useWorkstationSidebarMemory`), which is
 * a pure side effect keyed off the same section/selection state.
 */
import { useSetAtom } from "jotai";
import { useCallback, useMemo } from "react";

import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";
import { type Session, markAllSessionsVisited } from "@src/store/session";
import {
  createRuntimeScanningNavigationIntent,
  runtimeNavigationIntentAtom,
} from "@src/store/ui/runtimeNavigationAtom";

import { getAllSectionIds } from "../workstationSidebarData";
import { useSidebarBottomRightActions } from "./bottomActions";
import { useWorkstationSidebarMemory } from "./sidebarMemory";
import type { WorkstationSidebarKey } from "./types";

export function resolveSidebarSelectedMenuItemId({
  activeSidebarKey,
  selectedCloudMenuItemId,
  selectedMenuItemId,
  workItemsContentVisible,
}: Pick<
  UseWorkstationSidebarBottomActionsParams,
  | "activeSidebarKey"
  | "selectedCloudMenuItemId"
  | "selectedMenuItemId"
  | "workItemsContentVisible"
>): string {
  return activeSidebarKey === "workstation" &&
    !workItemsContentVisible &&
    selectedCloudMenuItemId
    ? selectedCloudMenuItemId
    : selectedMenuItemId;
}

export function hasSidebarMenuRows(
  menuItems: readonly NavigationMenuItem[]
): boolean {
  return menuItems.some((item) => !item.id?.startsWith("separator-"));
}

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
  channelSidebarVisible: boolean;
  activeSidebarKey: WorkstationSidebarKey;
  projectsWorkItemsLoading: boolean;
  projectsSidebarMenuItems: NavigationMenuItem[];
  sessionsLoading: boolean;
  handleRefreshSessions: () => void;
  openRuntimeTab: (title: string) => void;
  runtimeLabel: string;
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
  channelSidebarVisible,
  activeSidebarKey,
  projectsWorkItemsLoading,
  projectsSidebarMenuItems,
  sessionsLoading,
  handleRefreshSessions,
  openRuntimeTab,
  runtimeLabel,
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
  const setRuntimeNavigationIntent = useSetAtom(runtimeNavigationIntentAtom);
  // The sidebar's include-external toggle is all-or-nothing; per-source
  // visibility is owned by Runtime → Scanning, so the menu links there instead
  // of growing a second copy of that source list.
  const handleConfigureExternalSources = useCallback(() => {
    setRuntimeNavigationIntent(createRuntimeScanningNavigationIntent());
    openRuntimeTab(runtimeLabel);
  }, [openRuntimeTab, runtimeLabel, setRuntimeNavigationIntent]);
  const isLoading = channelSidebarVisible
    ? false
    : workItemsContentVisible || activeSidebarKey === "projects"
      ? projectsWorkItemsLoading &&
        !hasSidebarMenuRows(projectsSidebarMenuItems)
      : sessionsLoading && sessions.length === 0;
  const sessionBottomRightActions = useSidebarBottomRightActions({
    activeSidebarKey: workItemsContentVisible ? "projects" : activeSidebarKey,
    groupByMode,
    includeExternal,
    handleCollapseAll,
    handleMarkAllRead,
    handleRefreshSessions,
    handleConfigureExternalSources,
    setGroupByMode,
    setIncludeExternal,
  });
  const sidebarBottomRightActions = channelSidebarVisible
    ? null
    : sessionBottomRightActions;

  const resolvedSelectedMenuItemId = resolveSidebarSelectedMenuItemId({
    activeSidebarKey,
    selectedCloudMenuItemId,
    selectedMenuItemId,
    workItemsContentVisible,
  });

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
