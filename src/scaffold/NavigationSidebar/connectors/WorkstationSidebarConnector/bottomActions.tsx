import React, { useCallback } from "react";

import { SessionFilterButton } from "../SessionFilterButton";
import {
  GROUP_BY_MODES,
  type GroupByMode,
  type SessionGroupVisibleCount,
} from "../types";
import type { WorkstationSidebarKey } from "./types";

interface UseSidebarBottomRightActionsParams {
  activeSidebarKey: WorkstationSidebarKey;
  groupByMode: GroupByMode;
  groupVisibleCount: SessionGroupVisibleCount;
  includeExternal: boolean;
  handleCollapseAll: () => void;
  handleMarkAllRead: () => void;
  handleRefreshSessions: () => void;
  handleConfigureExternalSources: () => void;
  setGroupByMode: (mode: GroupByMode) => void;
  setGroupVisibleCount: (count: SessionGroupVisibleCount) => void;
  setIncludeExternal: (includeExternal: boolean) => void;
  resetGroupVisibleCounts: () => void;
}

export function useSidebarBottomRightActions({
  activeSidebarKey,
  groupByMode,
  groupVisibleCount,
  includeExternal,
  handleCollapseAll,
  handleMarkAllRead,
  handleRefreshSessions,
  handleConfigureExternalSources,
  setGroupByMode,
  setGroupVisibleCount,
  setIncludeExternal,
  resetGroupVisibleCounts,
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
  const handleGroupVisibleCountSelect = useCallback(
    (count: SessionGroupVisibleCount) => {
      if (count === groupVisibleCount) return;
      setGroupVisibleCount(count);
      resetGroupVisibleCounts();
    },
    [groupVisibleCount, resetGroupVisibleCounts, setGroupVisibleCount]
  );

  if (activeSidebarKey === "projects") {
    return null;
  }

  return (
    <SessionFilterButton
      groupByMode={groupByMode}
      groupVisibleCount={groupVisibleCount}
      includeExternal={includeExternal}
      onSelect={handleSessionGroupBySelect}
      onSelectGroupVisibleCount={handleGroupVisibleCountSelect}
      onToggleIncludeExternal={setIncludeExternal}
      onConfigureExternalSources={handleConfigureExternalSources}
      onCollapseAll={handleCollapseAll}
      onMarkAllRead={handleMarkAllRead}
      onRefreshSessions={handleRefreshSessions}
    />
  );
}
