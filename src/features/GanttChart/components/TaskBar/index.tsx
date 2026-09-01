/**
 * GanttTaskBar Component
 *
 * Individual task bar rendered on the timeline with drag/resize capabilities.
 * Uses Tailwind for basic layout, SCSS only for complex interactions (resize handles, gradients).
 */
import React from "react";

import {
  GANTT_STATUS_COLOR,
  type GanttStatus,
  STATUS_COLORS,
} from "@src/types/core/viewStatus";

import type { GanttConfig, GanttTask } from "../../types";
import {
  calculateExpectedProgress,
  getProgressGradient,
} from "../../utils/progress";
import GanttTaskTooltip from "../TaskTooltip";

interface GanttTaskBarProps {
  task: GanttTask;
  position: { left: number; width: number };
  config: GanttConfig;
  onClick?: (task: GanttTask) => void;
  editable?: boolean;
  onResizeStart?: (edge: "start" | "end", e: React.MouseEvent) => void;
  onMoveStart?: (e: React.MouseEvent) => void;
  isGhost?: boolean;
  showTooltip?: boolean;
  onEdit?: (task: GanttTask) => void;
  onDelete?: (taskId: string) => void;
  onStatusChange?: (taskId: string, status: GanttTask["status"]) => void;
  renderTooltipWrapper?: (
    task: GanttTask,
    children: React.ReactElement
  ) => React.ReactElement;
  barLabel?: string;
  startClipped?: boolean;
  endClipped?: boolean;
}

/**
 * Get gradient style for task bar based on status
 */
function getStatusGradient(status: GanttStatus, customColor?: string): string {
  if (customColor) return customColor;
  const colorKey = GANTT_STATUS_COLOR[status];
  const color = STATUS_COLORS[colorKey];
  return `linear-gradient(135deg, ${color.base}, ${color.dark})`;
}

const GanttTaskBar: React.FC<GanttTaskBarProps> = ({
  task,
  position,
  onClick,
  editable = false,
  onResizeStart,
  onMoveStart,
  isGhost = false,
  showTooltip = false,
  onEdit,
  onDelete,
  onStatusChange,
  renderTooltipWrapper,
  barLabel,
  startClipped,
  endClipped,
}) => {
  const taskStatus = (task.status || "in_progress") as GanttStatus;

  // Calculate progress health for gradient
  const expectedProgress = calculateExpectedProgress(
    task.startDate,
    task.endDate
  );
  const actualProgress = task.progress || 0;
  const progressGradient = getProgressGradient(
    actualProgress,
    expectedProgress
  );

  const handleBarMouseDown = (e: React.MouseEvent) => {
    if (editable && onMoveStart) {
      onMoveStart(e);
    }
  };

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onClick?.(task);
  };

  // Ghost bar styling
  const ghostClasses = isGhost
    ? "border-2 border-dashed border-primary-6 bg-primary-6/10"
    : "";

  // Cancelled task styling
  const cancelledClasses = taskStatus === "cancelled" ? "opacity-60" : "";
  const effectiveStartClipped = startClipped ?? task.startClipped;
  const effectiveEndClipped = endClipped ?? task.endClipped;
  const radiusClasses = `${effectiveStartClipped ? "rounded-l-none" : "rounded-l-full"} ${effectiveEndClipped ? "rounded-r-none" : "rounded-r-full"}`;
  const progressRadiusClasses = effectiveStartClipped
    ? "rounded-l-none"
    : "rounded-l-full";

  const taskBar = (
    <div
      className={`group/gantt relative flex h-7 min-w-2 cursor-pointer items-center overflow-hidden px-2 transition-all duration-150 ease-out hover:-translate-y-px hover:shadow-md hover:brightness-110 ${editable ? "cursor-grab active:cursor-grabbing" : ""} ${ghostClasses} ${cancelledClasses} ${radiusClasses}`}
      style={{
        width: "100%",
        background: isGhost
          ? undefined
          : getStatusGradient(taskStatus, task.color),
      }}
      onMouseDown={handleBarMouseDown}
      onClick={handleClick}
    >
      {editable && onResizeStart && !isGhost && (
        <div
          className="absolute bottom-0 left-0 top-0 z-[2] w-2 cursor-ew-resize rounded-l-full bg-transparent opacity-0 transition-[opacity,background] duration-150 hover:bg-white/30 active:bg-white/40 group-hover/gantt:opacity-100"
          onMouseDown={(e) => {
            e.stopPropagation();
            onResizeStart("start", e);
          }}
          title="Drag to change start date"
        >
          <div className="absolute left-[2px] top-1/2 h-3 w-0.5 -translate-y-1/2 rounded-sm bg-white/60" />
        </div>
      )}

      <span className="z-[1] overflow-hidden text-ellipsis whitespace-nowrap text-[11px] font-medium text-white">
        {barLabel ?? task.barLabel ?? task.title}
      </span>

      {task.progress !== undefined && task.progress > 0 && (
        <div
          className={`pointer-events-none absolute bottom-0 left-0 top-0 opacity-40 mix-blend-overlay transition-all duration-300 ${progressRadiusClasses}`}
          style={{
            width: `${task.progress}%`,
            background: `linear-gradient(90deg, ${progressGradient.start}, ${progressGradient.end})`,
          }}
        />
      )}

      {editable && onResizeStart && !isGhost && (
        <div
          className="absolute bottom-0 right-0 top-0 z-[2] w-2 cursor-ew-resize rounded-r-full bg-transparent opacity-0 transition-[opacity,background] duration-150 hover:bg-white/30 active:bg-white/40 group-hover/gantt:opacity-100"
          onMouseDown={(e) => {
            e.stopPropagation();
            onResizeStart("end", e);
          }}
          title="Drag to change end date"
        >
          <div className="absolute right-[2px] top-1/2 h-3 w-0.5 -translate-y-1/2 rounded-sm bg-white/60" />
        </div>
      )}
    </div>
  );

  return (
    <div
      className={`pointer-events-auto absolute bottom-0 top-0 flex items-center py-1 ${isGhost ? "pointer-events-none z-[100] opacity-50" : ""} `}
      style={{
        left: Math.max(0, position.left),
        width:
          position.left < 0 ? position.width + position.left : position.width,
      }}
    >
      {showTooltip && !isGhost
        ? (renderTooltipWrapper?.(task, taskBar) ?? (
            <GanttTaskTooltip
              task={task}
              onEdit={onEdit}
              onDelete={onDelete}
              onStatusChange={onStatusChange}
            >
              {taskBar}
            </GanttTaskTooltip>
          ))
        : taskBar}
    </div>
  );
};

export default GanttTaskBar;
