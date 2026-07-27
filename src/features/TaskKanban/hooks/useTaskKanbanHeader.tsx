import React, { useMemo } from "react";

import type { KanbanTask } from "@src/features/KanbanBoard";
import { usePublishWorkstationTabHeader } from "@src/hooks/workStation";

import DiaryDateControls from "../components/DiaryDateControls";
import type { FactoryViewMode } from "../components/FactoryViewPill";
import KanbanFileSearchInput from "../components/KanbanFileSearchInput";
import KanbanHeaderFilters from "../components/KanbanHeaderFilters";
import KanbanHeaderTrailingControls from "../components/KanbanHeaderTrailingControls";
import type { KanbanAutoArchiveTtl, KanbanTimeFilter } from "../config";

export interface UseTaskKanbanHeaderOptions {
  viewMode: FactoryViewMode;
  calendarDate: Date;
  onCalendarDateChange: React.Dispatch<React.SetStateAction<Date>>;
  autoArchiveTtl: KanbanAutoArchiveTtl;
  onAutoArchiveTtlChange: (ttl: KanbanAutoArchiveTtl) => void;
  timeFilter: KanbanTimeFilter;
  onTimeFilterChange: (filter: KanbanTimeFilter) => void;
  tasks: readonly KanbanTask[];
  refreshing: boolean;
  onRefresh: () => void;
  hidden: boolean;
}

export function useTaskKanbanHeader({
  viewMode,
  calendarDate,
  onCalendarDateChange,
  autoArchiveTtl,
  onAutoArchiveTtlChange,
  timeFilter,
  onTimeFilterChange,
  tasks,
  refreshing,
  onRefresh,
  hidden,
}: UseTaskKanbanHeaderOptions): void {
  const diaryControls = useMemo(() => {
    if (viewMode !== "diary") return null;
    return (
      <DiaryDateControls
        date={calendarDate}
        onDateChange={onCalendarDateChange}
      />
    );
  }, [calendarDate, onCalendarDateChange, viewMode]);

  const headerTrailing = useMemo(() => {
    if (viewMode === "diary") return null;
    return (
      <KanbanHeaderTrailingControls
        autoArchiveTtl={autoArchiveTtl}
        onAutoArchiveTtlChange={onAutoArchiveTtlChange}
        timeFilter={timeFilter}
        onTimeFilterChange={onTimeFilterChange}
        refreshing={refreshing}
        onRefresh={onRefresh}
      />
    );
  }, [
    autoArchiveTtl,
    onAutoArchiveTtlChange,
    onTimeFilterChange,
    onRefresh,
    refreshing,
    timeFilter,
    viewMode,
  ]);

  const headerContent = useMemo(() => {
    if (viewMode === "diary") {
      return {
        trailing: diaryControls,
      };
    }
    return {
      leading: <KanbanFileSearchInput />,
      trailing: (
        <div className="flex min-w-0 items-center gap-1 overflow-visible">
          <KanbanHeaderFilters tasks={tasks} />
          {headerTrailing}
        </div>
      ),
    };
  }, [diaryControls, headerTrailing, tasks, viewMode]);

  usePublishWorkstationTabHeader({
    host: "workManagement",
    content: headerContent,
    enabled: !hidden,
  });
}
