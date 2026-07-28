/**
 * TimelineRow — a single task row inside the Gantt timeline body.
 * Renders the background grid cells and the task bar (or segment bars).
 */
import type { VirtualItem } from "@tanstack/react-virtual";
import React from "react";

import { type ViewScopePeriod, getMsPerColumn } from "../../config";
import { type DragState, useTaskPosition } from "../../hooks";
import type {
  GanttConfig,
  GanttTask,
  GanttTaskSegment,
  GanttViewScope,
} from "../../types";
import GanttTaskBar from "../TaskBar";

// ============================================================================
// Helpers
// ============================================================================

export function getSegmentPosition(
  segment: GanttTaskSegment,
  viewStart: Date,
  viewScope: GanttViewScope,
  columnWidth: number
): { left: number; width: number } {
  const segmentStart =
    segment.startDate instanceof Date
      ? segment.startDate
      : new Date(segment.startDate);
  const segmentEnd =
    segment.endDate instanceof Date
      ? segment.endDate
      : new Date(segment.endDate);
  const msPerColumn = getMsPerColumn(viewScope);
  const pxPerMs = columnWidth / msPerColumn;
  const msFromStart = segmentStart.getTime() - viewStart.getTime();
  const segmentDurationMs = Math.max(
    1,
    segmentEnd.getTime() - segmentStart.getTime()
  );

  return {
    left: msFromStart * pxPerMs,
    width: segmentDurationMs * pxPerMs,
  };
}

export function isPeriodEmphasized(
  date: Date,
  viewScope: GanttViewScope,
  isPrimaryHeaderLabelEmphasized?: (
    date: Date,
    viewScope: GanttViewScope
  ) => boolean
): boolean {
  return (
    isPrimaryHeaderLabelEmphasized?.(date, viewScope) ??
    (viewScope === "1d" && date.getHours() % 4 === 0)
  );
}

// ============================================================================
// Types
// ============================================================================

export interface TimelineRowProps {
  task: GanttTask;
  periods: ViewScopePeriod[];
  viewScope: GanttViewScope;
  viewStart: Date;
  columnWidth: number;
  config: GanttConfig;
  onTaskClick?: (task: GanttTask) => void;
  editable?: boolean;
  onTaskResizeStart?: (
    taskId: string,
    edge: "start" | "end",
    task: GanttTask,
    e: React.MouseEvent
  ) => void;
  onTaskMoveStart?: (
    taskId: string,
    task: GanttTask,
    e: React.MouseEvent
  ) => void;
  showTooltips?: boolean;
  renderTooltipWrapper?: (
    task: GanttTask,
    children: React.ReactElement
  ) => React.ReactElement;
  dragState?: DragState | null;
  onEdit?: (task: GanttTask) => void;
  onDelete?: (taskId: string) => void;
  onStatusChange?: (taskId: string, status: GanttTask["status"]) => void;
  isPrimaryHeaderLabelEmphasized?: (
    date: Date,
    viewScope: GanttViewScope
  ) => boolean;
  virtualStart: number;
  virtualPeriods: VirtualItem[];
  totalWidth: number;
}

// ============================================================================
// Component
// ============================================================================

export const TimelineRow: React.FC<TimelineRowProps> = ({
  task,
  periods,
  viewScope,
  viewStart,
  columnWidth,
  config,
  onTaskClick,
  editable,
  onTaskResizeStart,
  onTaskMoveStart,
  showTooltips,
  renderTooltipWrapper,
  dragState,
  onEdit,
  onDelete,
  onStatusChange,
  isPrimaryHeaderLabelEmphasized,
  virtualStart,
  virtualPeriods,
  totalWidth,
}) => {
  const position = useTaskPosition({
    task,
    viewStart,
    viewScope,
    columnWidth,
  });
  const visiblePeriodStart = virtualPeriods[0]?.start ?? 0;
  const visiblePeriodEnd =
    virtualPeriods[virtualPeriods.length - 1]?.end ?? totalWidth;
  const intersectsVisiblePeriods = (candidate: {
    left: number;
    width: number;
  }) =>
    candidate.left + candidate.width >= visiblePeriodStart &&
    candidate.left <= visiblePeriodEnd;

  return (
    <div
      className="gantt-timeline__grid-row"
      style={{
        height: config.rowHeight,
        width: totalWidth,
        position: "absolute",
        top: 0,
        left: 0,
        transform: `translateY(${virtualStart}px)`,
      }}
    >
      {virtualPeriods.map((virtualPeriod) => {
        const period = periods[virtualPeriod.index];
        if (!period) return null;
        const emphasized = isPeriodEmphasized(
          period.date,
          viewScope,
          isPrimaryHeaderLabelEmphasized
        );

        return (
          <div
            key={virtualPeriod.key}
            className={`gantt-timeline__grid-cell ${
              period.isToday ? "gantt-timeline__grid-cell--today" : ""
            } ${period.isWeekend ? "gantt-timeline__grid-cell--weekend" : ""} ${
              emphasized ? "gantt-timeline__grid-cell--emphasized" : ""
            }`}
            style={{
              width: virtualPeriod.size,
              height: config.rowHeight,
              position: "absolute",
              left: virtualPeriod.start,
            }}
          />
        );
      })}

      {task.segments && task.segments.length > 0 ? (
        task.segments.map((segment) => {
          const segmentPosition = getSegmentPosition(
            segment,
            viewStart,
            viewScope,
            columnWidth
          );
          if (!intersectsVisiblePeriods(segmentPosition)) return null;

          return (
            <GanttTaskBar
              key={segment.id}
              task={task}
              position={segmentPosition}
              config={config}
              onClick={onTaskClick}
              editable={false}
              showTooltip={showTooltips && !dragState}
              renderTooltipWrapper={renderTooltipWrapper}
              onEdit={onEdit}
              onDelete={onDelete}
              onStatusChange={onStatusChange}
              barLabel={segment.barLabel ?? ""}
              startClipped={segment.startClipped}
              endClipped={segment.endClipped}
            />
          );
        })
      ) : intersectsVisiblePeriods(position) ? (
        <GanttTaskBar
          task={task}
          position={position}
          config={config}
          onClick={onTaskClick}
          editable={editable}
          onResizeStart={(edge, e) =>
            onTaskResizeStart?.(task.id, edge, task, e)
          }
          onMoveStart={(e) => onTaskMoveStart?.(task.id, task, e)}
          showTooltip={showTooltips && !dragState}
          renderTooltipWrapper={renderTooltipWrapper}
          onEdit={onEdit}
          onDelete={onDelete}
          onStatusChange={onStatusChange}
        />
      ) : null}
    </div>
  );
};
