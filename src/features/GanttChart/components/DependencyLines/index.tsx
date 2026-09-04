/**
 * GanttDependencyLines Component
 *
 * SVG layer rendering dependency arrows between tasks.
 */
import React, { useMemo } from "react";

import type { GanttConfig, GanttTask } from "../../types";
import "./index.scss";

interface DependencyLineData {
  from: { x: number; y: number };
  to: { x: number; y: number };
  fromTaskId: string;
  toTaskId: string;
}

interface GanttDependencyLinesProps {
  tasks: GanttTask[];
  taskPositions: Map<
    string,
    { left: number; width: number; top: number; index: number }
  >;
  config: GanttConfig;
  highlightedTask?: string | null;
  visibleTop: number;
  visibleBottom: number;
}

const GanttDependencyLines: React.FC<GanttDependencyLinesProps> = ({
  tasks,
  taskPositions,
  config,
  highlightedTask,
  visibleTop,
  visibleBottom,
}) => {
  const dependencies = useMemo(() => {
    const lines: DependencyLineData[] = [];

    tasks.forEach((task) => {
      if (!task.dependencies || task.dependencies.length === 0) return;

      const toPosition = taskPositions.get(task.id);
      if (!toPosition) return;

      task.dependencies.forEach((depId) => {
        const fromPosition = taskPositions.get(depId);
        if (!fromPosition) return;

        // From: end of predecessor task (right edge, middle)
        const fromX = fromPosition.left + fromPosition.width;
        const fromY = fromPosition.top + config.rowHeight / 2;

        // To: start of dependent task (left edge, middle)
        const toX = toPosition.left;
        const toY = toPosition.top + config.rowHeight / 2;

        // Keep dependency DOM bounded to lines that cross the rendered row
        // window. Coordinates remain global so partially visible paths line up.
        if (
          Math.max(fromY, toY) < visibleTop ||
          Math.min(fromY, toY) > visibleBottom
        ) {
          return;
        }

        lines.push({
          from: { x: fromX, y: fromY },
          to: { x: toX, y: toY },
          fromTaskId: depId,
          toTaskId: task.id,
        });
      });
    });

    return lines;
  }, [tasks, taskPositions, config.rowHeight, visibleTop, visibleBottom]);

  const createPath = (line: DependencyLineData): string => {
    const { from, to } = line;

    // Calculate control points for smooth curves
    const horizontalDistance = to.x - from.x;
    const verticalDistance = to.y - from.y;

    // If tasks are on the same row or close vertically, use simple line
    if (Math.abs(verticalDistance) < 5) {
      return `M ${from.x} ${from.y} L ${to.x} ${to.y}`;
    }

    // Use bezier curve for better visual flow
    const controlPointOffset = Math.min(Math.abs(horizontalDistance) / 2, 40);

    // Forward dependency (normal case)
    if (horizontalDistance > 0) {
      const cp1x = from.x + controlPointOffset;
      const cp1y = from.y;
      const cp2x = to.x - controlPointOffset;
      const cp2y = to.y;

      return `M ${from.x} ${from.y} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${to.x} ${to.y}`;
    }

    // Backward dependency (task depends on a later task - unusual but possible)
    // Route around the tasks
    const routeDistance = 20;
    const midY = (from.y + to.y) / 2;

    return `
      M ${from.x} ${from.y}
      L ${from.x + routeDistance} ${from.y}
      L ${from.x + routeDistance} ${midY}
      L ${to.x - routeDistance} ${midY}
      L ${to.x - routeDistance} ${to.y}
      L ${to.x} ${to.y}
    `;
  };

  const isHighlighted = (line: DependencyLineData): boolean => {
    if (!highlightedTask) return false;
    return (
      line.fromTaskId === highlightedTask || line.toTaskId === highlightedTask
    );
  };

  if (dependencies.length === 0) return null;

  return (
    <svg className="gantt-dependency-lines">
      <defs>
        {/* Arrow marker for line end */}
        <marker
          id="arrow"
          markerWidth="8"
          markerHeight="8"
          refX="6"
          refY="3"
          orient="auto"
          markerUnits="strokeWidth"
        >
          <path d="M0,0 L0,6 L6,3 z" fill="currentColor" />
        </marker>

        {/* Highlighted arrow marker */}
        <marker
          id="arrow-highlighted"
          markerWidth="10"
          markerHeight="10"
          refX="7"
          refY="4"
          orient="auto"
          markerUnits="strokeWidth"
        >
          <path d="M0,0 L0,8 L8,4 z" fill="var(--color-primary-6)" />
        </marker>
      </defs>

      {dependencies.map((line, index) => {
        const highlighted = isHighlighted(line);
        const pathData = createPath(line);

        return (
          <g key={index} className="gantt-dependency-lines__group">
            {/* Invisible wider path for easier hover */}
            <path
              d={pathData}
              className="gantt-dependency-lines__hover-target"
              strokeWidth="12"
              fill="none"
              stroke="transparent"
            />

            {/* Visible dependency line */}
            <path
              d={pathData}
              className={`gantt-dependency-lines__line ${
                highlighted ? "gantt-dependency-lines__line--highlighted" : ""
              }`}
              markerEnd={
                highlighted ? "url(#arrow-highlighted)" : "url(#arrow)"
              }
            />
          </g>
        );
      })}
    </svg>
  );
};

export default GanttDependencyLines;
