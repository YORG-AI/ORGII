/**
 * GanttSidebar Component
 *
 * Left sidebar showing task list with titles and assignees.
 * Uses Tailwind for all styling.
 */
import type { VirtualItem } from "@tanstack/react-virtual";
import { GitCommitHorizontal } from "lucide-react";
import React, { RefObject } from "react";

import { CLI_AGENT } from "@src/api/types/keys";
import ModelIcon from "@src/components/ModelIcon";
import { resolveAgentIcon } from "@src/config/agentIcons";
import {
  getDispatchCategory,
  resolveSessionIconId,
} from "@src/util/session/sessionDispatch";

import type { GanttConfig, GanttMarkerRow, GanttTask } from "../../types";

export interface GanttSidebarProps {
  tasks: GanttTask[];
  markerRows?: GanttMarkerRow[];
  config: GanttConfig;
  selectedTaskId?: string | null;
  onTaskClick?: (task: GanttTask) => void;
  sidebarContentRef: RefObject<HTMLDivElement | null>;
  compactHeader?: boolean;
  hideScrollbars?: boolean;
  transparentSurface?: boolean;
  showTaskIcons?: boolean;
  showAssigneeLabel?: boolean;
  virtualRows: VirtualItem[];
  totalSize: number;
  onScroll: () => void;
}

function renderTaskIcon(task: GanttTask): React.ReactNode {
  if (task.cliAgentType) {
    return <ModelIcon agentType={task.cliAgentType} size={13} />;
  }

  const sessionId = task.sessionId ?? task.id;
  if (getDispatchCategory(sessionId) === "cursor_ide") {
    return <ModelIcon agentType={CLI_AGENT.CURSOR} size={13} />;
  }

  const iconId = task.agentIconId ?? resolveSessionIconId(sessionId);
  const TaskIcon = resolveAgentIcon(iconId);
  return <TaskIcon size={13} strokeWidth={1.75} />;
}

const GanttSidebar: React.FC<GanttSidebarProps> = ({
  tasks,
  markerRows = [],
  config,
  selectedTaskId,
  onTaskClick,
  sidebarContentRef,
  compactHeader = false,
  hideScrollbars = false,
  transparentSurface = false,
  showTaskIcons = false,
  showAssigneeLabel = true,
  virtualRows,
  totalSize,
  onScroll,
}) => {
  const totalRowCount = markerRows.length + tasks.length;

  return (
    <div
      className={`flex shrink-0 flex-col overflow-hidden ${transparentSurface ? "" : "border-r border-border-2 bg-bg-2"}`}
      style={{ width: config.sidebarWidth }}
    >
      <div
        className={`flex shrink-0 items-center px-4 text-xs font-medium text-text-2 ${transparentSurface ? "" : "border-b border-border-2 bg-bg-1"}`}
        style={{
          height: compactHeader ? config.headerHeight / 2 : config.headerHeight,
        }}
      >
        {!compactHeader && "Task"}
      </div>

      {/* Task list */}
      <div
        className={`flex-1 overflow-y-auto overflow-x-hidden ${hideScrollbars ? "scrollbar-hide" : ""}`}
        ref={sidebarContentRef}
        onScroll={onScroll}
      >
        <div className="relative w-full" style={{ height: totalSize }}>
          {virtualRows.map((virtualRow) => {
            const rowIndex = virtualRow.index;
            const markerRow =
              rowIndex < markerRows.length ? markerRows[rowIndex] : undefined;

            const rowStyle: React.CSSProperties = {
              height: virtualRow.size,
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              transform: `translateY(${virtualRow.start}px)`,
            };
            const rowBorder =
              rowIndex === totalRowCount - 1 ? "" : "border-b border-border-1";

            if (markerRow) {
              return (
                <div
                  key={virtualRow.key}
                  className={`flex items-center px-2 ${rowBorder}`}
                  style={rowStyle}
                  data-gantt-row-index={rowIndex}
                >
                  <div className="flex h-8 min-w-0 flex-1 items-center rounded-lg px-2">
                    <span className="mr-2 flex h-4 w-4 shrink-0 items-center justify-center text-text-3">
                      <GitCommitHorizontal size={13} strokeWidth={1.75} />
                    </span>
                    <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[13px] text-text-1">
                      {markerRow.title}
                    </span>
                    <span className="ml-2 whitespace-nowrap rounded bg-fill-1 px-1.5 py-0.5 text-[10px] text-text-3">
                      {markerRow.badgeLabel ?? markerRow.markers.length}
                    </span>
                  </div>
                </div>
              );
            }

            const task = tasks[rowIndex - markerRows.length];
            if (!task) return null;
            const taskIcon = showTaskIcons ? renderTaskIcon(task) : null;
            return (
              <div
                key={virtualRow.key}
                className={`flex cursor-pointer items-center px-2 ${rowBorder}`}
                style={rowStyle}
                onClick={() => onTaskClick?.(task)}
                data-gantt-row-index={rowIndex}
              >
                <div
                  className={`flex h-8 min-w-0 flex-1 items-center rounded-lg px-2 transition-colors duration-150 ${
                    selectedTaskId === task.id
                      ? "bg-primary-1 hover:bg-primary-1"
                      : "hover:bg-fill-3"
                  }`}
                >
                  {taskIcon && (
                    <span className="mr-2 flex h-4 w-4 shrink-0 items-center justify-center text-text-2">
                      {taskIcon}
                    </span>
                  )}
                  <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[13px] text-text-1">
                    {task.title}
                  </span>
                  {task.sidebarMeta && (
                    <span className="ml-2 shrink-0 text-text-3">
                      {task.sidebarMeta}
                    </span>
                  )}
                  {showAssigneeLabel && task.assignee && (
                    <span className="ml-2 whitespace-nowrap rounded bg-fill-1 px-1.5 py-0.5 text-[10px] text-text-3">
                      {task.assignee}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default GanttSidebar;
