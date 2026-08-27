import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { Placeholder } from "@src/components/Placeholder";
import SessionHoverCard from "@src/components/SessionHoverCard";
import GanttChart from "@src/features/GanttChart";
import type {
  GanttMarker,
  GanttMarkerRow,
  GanttTask,
} from "@src/features/GanttChart";
import TaskImpactLine from "@src/features/KanbanBoard/components/TaskImpactLine";

import type { DiaryDaySummary } from "../../utils/diaryUtils";
import { DiaryCommitBucketDropdown } from "./DiaryCommitDropdowns";
import {
  buildDiaryCommitMarkerRows,
  buildDiaryGanttTasks,
  formatDiaryGanttHeaderLabel,
  getCommitBucketByMarkerId,
  getDiaryGanttRowId,
  isDiaryGanttHeaderEmphasized,
} from "./diaryPanelUtils";

// ============================================================================
// Types
// ============================================================================

interface DiaryPanelProps {
  summary: DiaryDaySummary;
  commitsRowTitle: string;
  onEventClick?: (taskId: string) => void;
}

// ============================================================================
// Component
// ============================================================================

const DiaryPanel: React.FC<DiaryPanelProps> = ({
  summary,
  commitsRowTitle,
  onEventClick,
}) => {
  const { t } = useTranslation("sessions");

  const ganttTasks = useMemo<GanttTask[]>(() => {
    const taskByRowId = new Map(
      summary.workIntervals.map((interval) => [
        getDiaryGanttRowId(interval),
        interval.task,
      ])
    );

    return buildDiaryGanttTasks(summary).map((task) => {
      const sourceTask = taskByRowId.get(task.id);
      if (!sourceTask) return task;
      return {
        ...task,
        sidebarMeta: (
          <TaskImpactLine task={sourceTask} showUnavailable={false} />
        ),
      };
    });
  }, [summary]);
  const markerRows = useMemo<GanttMarkerRow[]>(
    () => buildDiaryCommitMarkerRows(summary, commitsRowTitle),
    [summary, commitsRowTitle]
  );
  const currentTime = new Date();

  if (summary.events.length === 0 && summary.commits.length === 0) {
    return (
      <aside className="flex h-full w-full flex-col">
        <Placeholder
          variant="empty"
          placement="sidebar"
          title={t("kanban.diary.emptyTitle")}
          subtitle={t("kanban.diary.emptySubtitle")}
        />
      </aside>
    );
  }

  return (
    <aside className="flex h-full w-full flex-col">
      <div className="min-h-0 flex-1 overflow-hidden">
        <div className="h-full overflow-hidden">
          <GanttChart
            key={summary.dayStart.toISOString()}
            tasks={ganttTasks}
            markerRows={markerRows}
            defaultViewScope="1d"
            initialDate={summary.dayStart}
            initialScrollTargetDate={currentTime}
            initialScrollTargetAlignment="center"
            showCurrentTimeMarker
            hideToolbar
            hideScrollbars
            transparentSurface
            periodScrollMultiplier={0}
            minColumnWidth={72}
            onTaskClick={(task) => {
              const interval = summary.workIntervals.find(
                (candidate) => getDiaryGanttRowId(candidate) === task.id
              );
              if (interval) onEventClick?.(interval.task.id);
            }}
            showTooltips
            renderTooltipWrapper={(task, children) =>
              task.sessionId ? (
                <SessionHoverCard
                  sessionId={task.sessionId}
                  position="right-start"
                >
                  {children}
                </SessionHoverCard>
              ) : (
                children
              )
            }
            renderMarkerTooltipWrapper={(
              marker: GanttMarker,
              _row,
              children
            ) => {
              const bucketCommits = getCommitBucketByMarkerId(
                summary,
                marker.id
              );
              if (bucketCommits.length === 0) return children;
              return (
                <DiaryCommitBucketDropdown
                  bucketCommits={bucketCommits}
                  marker={marker}
                >
                  {children}
                </DiaryCommitBucketDropdown>
              );
            }}
            hideTimelineDateHeader
            transparentTimelineSurface
            showSidebarTaskIcons
            showSidebarAssigneeLabels={false}
            formatPrimaryHeaderLabel={formatDiaryGanttHeaderLabel}
            isPrimaryHeaderLabelEmphasized={isDiaryGanttHeaderEmphasized}
            editable={false}
          />
        </div>
      </div>
    </aside>
  );
};

export default DiaryPanel;
