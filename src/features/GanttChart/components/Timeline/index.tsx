/**
 * GanttTimeline Component
 *
 * Timeline grid with header and task bars.
 */
import type { VirtualItem } from "@tanstack/react-virtual";
import React, { RefObject, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { Placeholder } from "@src/modules/shared/layouts/blocks";

import {
  type ViewScopePeriod,
  getMsPerColumn,
  getViewScopeSecondaryLabel,
} from "../../config";
import { type DragState } from "../../hooks";
import type {
  GanttConfig,
  GanttMarker,
  GanttMarkerRow,
  GanttMilestone,
  GanttTask,
  GanttTimeScale,
  GanttViewScope,
} from "../../types";
import GanttDependencyLines from "../DependencyLines";
import GanttMilestoneMarker from "../Milestone";
import GanttTaskBar from "../TaskBar";
import { MarkerTimelineRow } from "./MarkerTimelineRow";
import { TimelineRow, isPeriodEmphasized } from "./TimelineRow";
import "./index.scss";

export interface GanttTimelineProps {
  tasks: GanttTask[];
  markerRows?: GanttMarkerRow[];
  config: GanttConfig;
  /** New view scope (3d, 7d, 1m, 3m) */
  viewScope: GanttViewScope;
  /** @deprecated Legacy time scale for compatibility */
  timeScale?: GanttTimeScale;
  viewStart: Date;
  timelineStart: Date;
  periods: ViewScopePeriod[];
  columnWidth: number;
  totalWidth: number;
  timelineBodyRef: RefObject<HTMLDivElement | null>;
  /** Ref for the header scroll container (for horizontal scroll sync) */
  headerScrollRef?: RefObject<HTMLDivElement | null>;
  onTimelineScroll: () => void;
  onTaskClick?: (task: GanttTask) => void;
  editable?: boolean;
  dragState?: DragState | null;
  ghostPreview?: { left: number; width: number } | null;
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
  renderMarkerTooltipWrapper?: (
    marker: GanttMarker,
    row: GanttMarkerRow,
    children: React.ReactElement
  ) => React.ReactElement;
  hideDateHeader?: boolean;
  hideScrollbars?: boolean;
  transparentSurface?: boolean;
  onEdit?: (task: GanttTask) => void;
  onDelete?: (taskId: string) => void;
  onStatusChange?: (taskId: string, status: GanttTask["status"]) => void;
  milestones?: GanttMilestone[];
  onMilestoneClick?: (milestone: GanttMilestone) => void;
  showDependencies?: boolean;
  highlightedTaskId?: string | null;
  formatPrimaryHeaderLabel?: (date: Date, viewScope: GanttViewScope) => string;
  isPrimaryHeaderLabelEmphasized?: (
    date: Date,
    viewScope: GanttViewScope
  ) => boolean;
  showCurrentTimeMarker?: boolean;
  virtualRows: VirtualItem[];
  totalRowSize: number;
  virtualPeriods: VirtualItem[];
}

const GanttTimeline: React.FC<GanttTimelineProps> = ({
  tasks,
  markerRows = [],
  config,
  viewScope,
  viewStart,
  timelineStart,
  periods,
  columnWidth,
  totalWidth,
  timelineBodyRef,
  headerScrollRef,
  onTimelineScroll,
  onTaskClick,
  editable = false,
  dragState,
  ghostPreview,
  onTaskResizeStart,
  onTaskMoveStart,
  showTooltips = false,
  renderTooltipWrapper,
  renderMarkerTooltipWrapper,
  hideDateHeader = false,
  hideScrollbars = false,
  transparentSurface = false,
  onEdit,
  onDelete,
  onStatusChange,
  milestones = [],
  onMilestoneClick,
  showDependencies = false,
  highlightedTaskId,
  formatPrimaryHeaderLabel,
  isPrimaryHeaderLabelEmphasized,
  showCurrentTimeMarker = false,
  virtualRows,
  totalRowSize,
  virtualPeriods,
}) => {
  const { t } = useTranslation();

  const groupedPeriods = useMemo(() => {
    interface PeriodGroup {
      label: string;
      periods: ViewScopePeriod[];
      width: number;
    }

    if (periods.length === 0) return [];

    const groups: PeriodGroup[] = [];
    let currentLabel = getViewScopeSecondaryLabel(periods[0].date, viewScope);
    let currentPeriods: ViewScopePeriod[] = [periods[0]];

    for (let index = 1; index < periods.length; index++) {
      const period = periods[index];
      const label = getViewScopeSecondaryLabel(period.date, viewScope);

      if (label !== currentLabel) {
        groups.push({
          label: currentLabel,
          periods: currentPeriods,
          width: currentPeriods.length * columnWidth,
        });
        currentLabel = label;
        currentPeriods = [period];
      } else {
        currentPeriods.push(period);
      }
    }

    groups.push({
      label: currentLabel,
      periods: currentPeriods,
      width: currentPeriods.length * columnWidth,
    });

    return groups;
  }, [periods, viewScope, columnWidth]);

  const currentTimePosition = useMemo(() => {
    if (!showCurrentTimeMarker) return null;

    const now = new Date();
    const msPerColumn = getMsPerColumn(viewScope);
    const msFromStart = now.getTime() - timelineStart.getTime();
    const position = (msFromStart / msPerColumn) * columnWidth;

    if (position < 0 || position > totalWidth) return null;
    return position;
  }, [
    showCurrentTimeMarker,
    timelineStart,
    viewScope,
    columnWidth,
    totalWidth,
  ]);

  const taskPositions = useMemo(() => {
    const positions = new Map<
      string,
      { left: number; width: number; top: number; index: number }
    >();
    if (!showDependencies) return positions;

    const msPerColumn = getMsPerColumn(viewScope);
    const pxPerMs = columnWidth / msPerColumn;

    tasks.forEach((task, index) => {
      const taskStart =
        task.startDate instanceof Date
          ? task.startDate
          : new Date(task.startDate);
      const taskEnd =
        task.endDate instanceof Date ? task.endDate : new Date(task.endDate);

      const viewStartTime = viewStart.getTime();
      const taskStartTime = taskStart.getTime();
      const taskEndTime = taskEnd.getTime();

      const msFromStart = taskStartTime - viewStartTime;
      const taskDurationMs = Math.max(msPerColumn, taskEndTime - taskStartTime);

      positions.set(task.id, {
        left: msFromStart * pxPerMs,
        width: taskDurationMs * pxPerMs,
        top: (markerRows.length + index) * config.rowHeight,
        index,
      });
    });

    return positions;
  }, [
    tasks,
    viewStart,
    viewScope,
    columnWidth,
    config.rowHeight,
    markerRows.length,
    showDependencies,
  ]);

  const visibleRowStart = virtualRows[0]?.start ?? 0;
  const visibleRowEnd =
    virtualRows[virtualRows.length - 1]?.end ?? totalRowSize;
  const visiblePeriodStart = virtualPeriods[0]?.start ?? 0;
  const visiblePeriodEnd =
    virtualPeriods[virtualPeriods.length - 1]?.end ?? totalWidth;

  return (
    <div
      className={`gantt-timeline ${hideScrollbars ? "gantt-timeline--hide-scrollbars" : ""} ${transparentSurface ? "gantt-timeline--transparent-surface" : ""}`}
    >
      <div
        ref={headerScrollRef}
        className="gantt-timeline__header"
        style={{
          height: hideDateHeader
            ? config.headerHeight / 2
            : config.headerHeight,
        }}
      >
        <div
          className="gantt-timeline__header-scroll"
          style={{ width: totalWidth }}
        >
          {!hideDateHeader && (
            <div
              className="gantt-timeline__header-secondary"
              style={{ height: config.headerHeight / 2 }}
            >
              {groupedPeriods.map((group, index) => (
                <div
                  key={`${group.label}-${index}`}
                  className="gantt-timeline__header-secondary-cell"
                  style={{ width: group.width }}
                >
                  {group.label}
                </div>
              ))}
            </div>
          )}
          <div
            className="gantt-timeline__header-primary"
            style={{ height: config.headerHeight / 2, width: totalWidth }}
          >
            {virtualPeriods.map((virtualPeriod) => {
              const period = periods[virtualPeriod.index];
              if (!period) return null;
              const label =
                formatPrimaryHeaderLabel?.(period.date, viewScope) ??
                period.label;
              const emphasized = isPeriodEmphasized(
                period.date,
                viewScope,
                isPrimaryHeaderLabelEmphasized
              );

              return (
                <div
                  key={virtualPeriod.key}
                  className={`gantt-timeline__header-cell ${
                    period.isToday ? "gantt-timeline__header-cell--today" : ""
                  } ${
                    period.isWeekend
                      ? "gantt-timeline__header-cell--weekend"
                      : ""
                  } ${emphasized ? "gantt-timeline__header-cell--emphasized" : ""}`}
                  style={{
                    width: virtualPeriod.size,
                    position: "absolute",
                    left: virtualPeriod.start,
                  }}
                >
                  <span className="gantt-timeline__header-cell-label">
                    {label}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div
        className="gantt-timeline__body"
        ref={timelineBodyRef}
        onScroll={onTimelineScroll}
      >
        {tasks.length === 0 && markerRows.length === 0 ? (
          <Placeholder
            variant="empty"
            placement="detail-panel"
            title={t("placeholders.noTasksWithDates")}
            subtitle={t("placeholders.noTasksWithDatesSubtitle")}
          />
        ) : (
          <div
            className="gantt-timeline__scroll"
            style={{ width: totalWidth, height: totalRowSize }}
          >
            {currentTimePosition !== null && (
              <div
                className="gantt-timeline__current-time-marker"
                aria-hidden="true"
                style={{ left: currentTimePosition }}
              />
            )}

            {showDependencies && (
              <GanttDependencyLines
                tasks={tasks}
                taskPositions={taskPositions}
                config={config}
                highlightedTask={highlightedTaskId}
                visibleTop={visibleRowStart}
                visibleBottom={visibleRowEnd}
              />
            )}

            {milestones.map((milestone) => {
              const milestoneDate =
                typeof milestone.date === "string"
                  ? new Date(milestone.date)
                  : milestone.date;

              const msPerColumn = getMsPerColumn(viewScope);
              const msFromStart = milestoneDate.getTime() - viewStart.getTime();
              const position = (msFromStart / msPerColumn) * columnWidth;

              if (
                position < visiblePeriodStart ||
                position > visiblePeriodEnd
              ) {
                return null;
              }

              return (
                <GanttMilestoneMarker
                  key={milestone.id}
                  milestone={milestone}
                  position={position}
                  config={config}
                  onClick={onMilestoneClick}
                />
              );
            })}

            {virtualRows.map((virtualRow) => {
              if (virtualRow.index < markerRows.length) {
                const markerRow = markerRows[virtualRow.index];
                if (!markerRow) return null;
                return (
                  <MarkerTimelineRow
                    key={virtualRow.key}
                    markerRow={markerRow}
                    periods={periods}
                    viewScope={viewScope}
                    viewStart={viewStart}
                    columnWidth={columnWidth}
                    totalWidth={totalWidth}
                    config={config}
                    renderMarkerTooltipWrapper={renderMarkerTooltipWrapper}
                    isPrimaryHeaderLabelEmphasized={
                      isPrimaryHeaderLabelEmphasized
                    }
                    virtualStart={virtualRow.start}
                    virtualPeriods={virtualPeriods}
                    visiblePeriodStart={visiblePeriodStart}
                    visiblePeriodEnd={visiblePeriodEnd}
                  />
                );
              }

              const task = tasks[virtualRow.index - markerRows.length];
              if (!task) return null;
              return (
                <TimelineRow
                  key={virtualRow.key}
                  task={task}
                  periods={periods}
                  viewScope={viewScope}
                  viewStart={viewStart}
                  columnWidth={columnWidth}
                  config={config}
                  onTaskClick={onTaskClick}
                  editable={editable}
                  onTaskResizeStart={onTaskResizeStart}
                  onTaskMoveStart={onTaskMoveStart}
                  showTooltips={showTooltips}
                  renderTooltipWrapper={renderTooltipWrapper}
                  dragState={dragState}
                  onEdit={onEdit}
                  onDelete={onDelete}
                  onStatusChange={onStatusChange}
                  isPrimaryHeaderLabelEmphasized={
                    isPrimaryHeaderLabelEmphasized
                  }
                  virtualStart={virtualRow.start}
                  virtualPeriods={virtualPeriods}
                  totalWidth={totalWidth}
                />
              );
            })}

            {dragState && ghostPreview && (
              <div
                className="gantt-timeline__grid-row"
                style={{
                  height: config.rowHeight,
                  position: "absolute",
                  top:
                    (markerRows.length +
                      Math.max(
                        0,
                        tasks.findIndex((task) => task.id === dragState.taskId)
                      )) *
                    config.rowHeight,
                  left: 0,
                  right: 0,
                  pointerEvents: "none",
                }}
              >
                <GanttTaskBar
                  task={
                    tasks.find((task) => task.id === dragState.taskId) ||
                    tasks[0]
                  }
                  position={ghostPreview}
                  config={config}
                  isGhost
                />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default GanttTimeline;
