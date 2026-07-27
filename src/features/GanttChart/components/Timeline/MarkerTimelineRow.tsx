/**
 * MarkerTimelineRow — a special timeline row that renders event markers
 * (dots or segments) rather than task bars.
 */
import type { VirtualItem } from "@tanstack/react-virtual";
import React from "react";

import { type ViewScopePeriod, getMsPerColumn } from "../../config";
import type {
  GanttConfig,
  GanttMarker,
  GanttMarkerRow,
  GanttViewScope,
} from "../../types";
import { isPeriodEmphasized } from "./TimelineRow";

// ============================================================================
// Helpers
// ============================================================================

export function getMarkerPosition(
  marker: GanttMarker,
  viewStart: Date,
  viewScope: GanttViewScope,
  columnWidth: number
): { left: number; width?: number } {
  const markerStart =
    marker.timestamp instanceof Date
      ? marker.timestamp
      : new Date(marker.timestamp);
  const markerEnd = marker.endTimestamp
    ? marker.endTimestamp instanceof Date
      ? marker.endTimestamp
      : new Date(marker.endTimestamp)
    : null;
  const msPerColumn = getMsPerColumn(viewScope);
  const pxPerMs = columnWidth / msPerColumn;
  const msFromStart = markerStart.getTime() - viewStart.getTime();

  if (!markerEnd) return { left: msFromStart * pxPerMs };

  return {
    left: msFromStart * pxPerMs,
    width: Math.max(1, (markerEnd.getTime() - markerStart.getTime()) * pxPerMs),
  };
}

// ============================================================================
// Types
// ============================================================================

export interface MarkerTimelineRowProps {
  markerRow: GanttMarkerRow;
  periods: ViewScopePeriod[];
  viewScope: GanttViewScope;
  viewStart: Date;
  columnWidth: number;
  totalWidth: number;
  config: GanttConfig;
  renderMarkerTooltipWrapper?: (
    marker: GanttMarker,
    row: GanttMarkerRow,
    children: React.ReactElement
  ) => React.ReactElement;
  isPrimaryHeaderLabelEmphasized?: (
    date: Date,
    viewScope: GanttViewScope
  ) => boolean;
  virtualStart: number;
  virtualPeriods: VirtualItem[];
  visiblePeriodStart: number;
  visiblePeriodEnd: number;
}

// ============================================================================
// Component
// ============================================================================

export const MarkerTimelineRow: React.FC<MarkerTimelineRowProps> = ({
  markerRow,
  periods,
  viewScope,
  viewStart,
  columnWidth,
  totalWidth,
  config,
  renderMarkerTooltipWrapper,
  isPrimaryHeaderLabelEmphasized,
  virtualStart,
  virtualPeriods,
  visiblePeriodStart,
  visiblePeriodEnd,
}) => {
  return (
    <div
      className="gantt-timeline__grid-row gantt-timeline__marker-row"
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

      {markerRow.markers.map((marker) => {
        const position = getMarkerPosition(
          marker,
          viewStart,
          viewScope,
          columnWidth
        );
        const width = position.width;
        const markerEnd = position.left + (width ?? 0);
        if (
          markerEnd < visiblePeriodStart ||
          position.left > visiblePeriodEnd
        ) {
          return null;
        }

        const markerElement = width ? (
          <button
            type="button"
            className="gantt-timeline__marker-segment"
            style={{ background: marker.color }}
            aria-label={marker.ariaLabel ?? marker.title}
          >
            {marker.label && (
              <span className="gantt-timeline__marker-segment-label">
                {marker.label}
              </span>
            )}
          </button>
        ) : (
          <button
            type="button"
            className="gantt-timeline__marker-dot"
            style={{ background: marker.color }}
            aria-label={marker.ariaLabel ?? marker.title}
          />
        );
        const wrappedMarker = renderMarkerTooltipWrapper
          ? renderMarkerTooltipWrapper(marker, markerRow, markerElement)
          : markerElement;

        return (
          <div
            key={marker.id}
            className={`gantt-timeline__marker-anchor ${
              width
                ? "gantt-timeline__marker-anchor--segment"
                : "gantt-timeline__marker-anchor--dot"
            }`}
            style={{
              left: position.left,
              width,
            }}
          >
            {wrappedMarker}
          </div>
        );
      })}
    </div>
  );
};
