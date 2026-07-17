import React, { useMemo } from "react";

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
      />
    );
  }, [
    autoArchiveTtl,
    onAutoArchiveTtlChange,
    onTimeFilterChange,
    timeFilter,
    viewMode,
  ]);

  const headerContent = useMemo(() => {
    // Data Source tab manages its own actions (per-source + "Rescan all"),
    // so the Kanban time/archive filters don't apply here.
    if (viewMode === "datasource") {
      return { trailing: null };
    }
    if (viewMode === "diary") {
      return {
        trailing: diaryControls,
      };
    }
    return {
      leading: <KanbanFileSearchInput />,
      trailing: (
        <div className="flex min-w-0 items-center gap-1 overflow-visible">
          <KanbanHeaderFilters />
          {headerTrailing}
        </div>
      ),
    };
  }, [diaryControls, headerTrailing, viewMode]);

  usePublishWorkstationTabHeader({
    host: "workManagement",
    content: headerContent,
    enabled: !hidden,
  });
}
