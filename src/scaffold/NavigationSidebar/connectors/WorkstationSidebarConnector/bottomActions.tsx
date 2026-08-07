import React, { useCallback } from "react";

import { SessionFilterButton } from "../SessionFilterButton";
import { GROUP_BY_MODES, type GroupByMode } from "../types";
import type { WorkstationSidebarKey } from "./types";

interface UseSidebarBottomRightActionsParams {
  activeSidebarKey: WorkstationSidebarKey;
  groupByMode: GroupByMode;
  includeExternal: boolean;
  handleCollapseAll: () => void;
  handleMarkAllRead: () => void;
  handleRefreshSessions: () => void;
  setGroupByMode: (mode: GroupByMode) => void;
  setIncludeExternal: (includeExternal: boolean) => void;
}

export function useSidebarBottomRightActions({
  activeSidebarKey,
  groupByMode,
  includeExternal,
  handleCollapseAll,
  handleMarkAllRead,
  handleRefreshSessions,
  setGroupByMode,
  setIncludeExternal,
}: UseSidebarBottomRightActionsParams): React.ReactNode {
  const handleSessionGroupBySelect = useCallback(
    (mode: string) => {
      if (!GROUP_BY_MODES.includes(mode as GroupByMode)) {
        return;
      }
      setGroupByMode(mode as GroupByMode);
    },
    [setGroupByMode]
  );

  if (activeSidebarKey === "projects") {
    return null;
  }

  return (
    <SessionFilterButton
      groupByMode={groupByMode}
      includeExternal={includeExternal}
      onSelect={handleSessionGroupBySelect}
      onToggleIncludeExternal={setIncludeExternal}
      onCollapseAll={handleCollapseAll}
      onMarkAllRead={handleMarkAllRead}
      onRefreshSessions={handleRefreshSessions}
    />
  );
}
