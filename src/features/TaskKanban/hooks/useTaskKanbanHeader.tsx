import React, { useMemo } from "react";

import Button from "@src/components/Button";
import { HeaderSectionSeparator } from "@src/components/HeaderSectionSeparator";
import { HEADER_ICON_SIZE } from "@src/config/workstation/tokens";
import type { KanbanTask } from "@src/features/KanbanBoard";
import { usePublishWorkstationTabHeader } from "@src/hooks/tabHost/useWorkstationTabHeader";
import { HugeiconsIcon, MessageAdd02Icon } from "@src/icons";

import DiaryDateControls from "../components/DiaryDateControls";
import type { FactoryViewMode } from "../components/FactoryViewPill";
import KanbanHeaderFilters from "../components/KanbanHeaderFilters";
import KanbanSearchInput from "../components/KanbanSearchInput";
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
  addTaskLabel: string;
  addTaskActive: boolean;
  onAddTask?: () => void;
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
  addTaskLabel,
  addTaskActive,
  onAddTask,
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

  const headerContent = useMemo(() => {
    if (viewMode === "diary") {
      return {
        trailing: diaryControls,
      };
    }
    return {
      trailing: (
        <div className="flex min-w-0 items-center gap-px overflow-visible">
          <KanbanSearchInput />
          <HeaderSectionSeparator className="mx-1" />
          <KanbanHeaderFilters
            tasks={tasks}
            autoArchiveTtl={autoArchiveTtl}
            onAutoArchiveTtlChange={onAutoArchiveTtlChange}
            timeFilter={timeFilter}
            onTimeFilterChange={onTimeFilterChange}
          />
          {onAddTask ? (
            <Button
              htmlType="button"
              variant="tertiary"
              size="small"
              iconOnly
              className={
                addTaskActive ? "bg-surface-selected! text-primary-6!" : ""
              }
              onClick={onAddTask}
              aria-label={addTaskLabel}
              aria-pressed={addTaskActive}
              data-testid="kanban-create-session"
              icon={
                <HugeiconsIcon
                  icon={MessageAdd02Icon}
                  data-icon="message-add"
                  size={HEADER_ICON_SIZE.md}
                  strokeWidth={2}
                />
              }
            />
          ) : null}
        </div>
      ),
    };
  }, [
    addTaskActive,
    addTaskLabel,
    autoArchiveTtl,
    diaryControls,
    onAddTask,
    onAutoArchiveTtlChange,
    onTimeFilterChange,
    tasks,
    timeFilter,
    viewMode,
  ]);

  usePublishWorkstationTabHeader({
    host: "workManagement",
    content: headerContent,
    enabled: !hidden,
  });
}
