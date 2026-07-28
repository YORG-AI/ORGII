/**
 * KanbanBoard Component
 *
 * A reusable drag-and-drop Kanban board component using dnd-kit.
 * Supports column reordering, task moving, and customizable columns.
 *
 * @example
 * ```tsx
 * import KanbanBoard from "@src/features/KanbanBoard";
 *
 * <KanbanBoard
 *   tasks={tasks}
 *   onTaskMove={(taskId, newStatus) => handleMove(taskId, newStatus)}
 *   onTaskClick={(task) => handleClick(task)}
 * />
 * ```
 */
import {
  DndContext,
  type DragEndEvent,
  type DragOverEvent,
  DragOverlay,
  type DragStartEvent,
  pointerWithin,
  rectIntersection,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
} from "@dnd-kit/sortable";
import React, {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { scaleAwareModifier, useWebViewSensors } from "@src/lib/dndKit";

import { KanbanColumn, TaskCard } from "./components";
import { DEFAULT_KANBAN_COLUMNS } from "./config";
import "./index.scss";
import type { KanbanColumnConfig, KanbanTask, TaskStatus } from "./types";

// ============================================
// Drop Indicator State
// ============================================

export interface DropIndicatorState {
  /** Column ID where the drop indicator should show */
  columnId: TaskStatus | null;
  /** Task ID to show indicator before (null = end of column/empty) */
  beforeTaskId: string | null;
}

// ============================================
// Types
// ============================================

export interface TaskMoveInfo {
  taskId: string;
  newStatus: TaskStatus;
  /** Index position within the column (null = end of column) */
  index: number | null;
  /** Task ID to insert before (null = end of column) */
  beforeTaskId: string | null;
}

export interface KanbanBoardProps {
  /** Array of tasks to display */
  tasks: KanbanTask[];
  /** Initial column configuration (used when `columnOrder` is not passed). */
  columns?: KanbanColumnConfig[];
  /**
   * Controlled column order. When provided, the board renders this exact
   * array and reports user-driven reorders via `onColumnOrderChange` —
   * the parent owns the state and is responsible for persisting it (e.g.
   * to a Jotai atom / localStorage). When omitted, the board falls back
   * to internal state initialised from `columns`.
   */
  columnOrder?: KanbanColumnConfig[];
  /** Whether columns can be reordered via drag-and-drop */
  allowColumnReorder?: boolean;
  /** Whether task cards can be dragged within/between columns */
  allowTaskDrag?: boolean;
  /**
   * Apply the root UI-scale correction to dnd-kit transforms.
   * Consumers rendered under document-level zoom may disable this when native
   * browser zoom already keeps pointer coordinates aligned.
   */
  scaleDragTransform?: boolean;
  /**
   * Render a portaled drag preview and hide the source task while dragging.
   * Disable this in zoomed WebViews when the portal coordinate space drifts
   * from the source card.
   */
  useDragOverlay?: boolean;
  /** Whether columns should be constrained to the board width instead of horizontal scrolling. */
  fitColumnsToContainer?: boolean;
  /** Whether to show the add task button in column headers */
  showAddButton?: boolean;
  /** Callback when a task is moved to a different column or position */
  onTaskMove?: (
    taskId: string,
    newStatus: TaskStatus,
    moveInfo?: TaskMoveInfo
  ) => void;
  /** Callback when a task is clicked */
  onTaskClick?: (task: KanbanTask) => void;
  /** Callback when add task button is clicked */
  onAddTask?: (status: TaskStatus) => void;
  /** Callback when column order changes */
  onColumnOrderChange?: (newOrder: KanbanColumnConfig[]) => void;
  /** ID of the task whose preview panel is currently open (drives the
   * selected card accent). `null` / undefined means no card is selected. */
  selectedTaskId?: string | null;
  /**
   * Remount column render windows when the consumer changes data scope or
   * filters. Live task updates within the same key preserve scroll progress.
   */
  taskRenderWindowKey?: string;
  /** Additional className for the board container */
  className?: string;
}

// ============================================
// Component
// ============================================

const KanbanBoard: React.FC<KanbanBoardProps> = ({
  tasks,
  columns = DEFAULT_KANBAN_COLUMNS,
  columnOrder: controlledColumnOrder,
  allowColumnReorder = true,
  allowTaskDrag = true,
  scaleDragTransform = true,
  useDragOverlay = true,
  fitColumnsToContainer = false,
  showAddButton = true,
  onTaskMove,
  onTaskClick,
  onAddTask,
  onColumnOrderChange,
  selectedTaskId,
  taskRenderWindowKey,
  className = "",
}) => {
  const { t } = useTranslation();
  // Column order is controlled-or-uncontrolled: when the parent passes
  // `columnOrder` we read from it and only emit `onColumnOrderChange`;
  // otherwise we own the array internally so a re-mount restarts from
  // `columns`. Parents that want persistence should hold the array in
  // a Jotai atom and pass it back in.
  const isColumnOrderControlled = controlledColumnOrder !== undefined;
  const [internalColumnOrder, setInternalColumnOrder] =
    useState<KanbanColumnConfig[]>(columns);
  const columnOrder = isColumnOrderControlled
    ? controlledColumnOrder
    : internalColumnOrder;
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeType, setActiveType] = useState<"task" | "column" | null>(null);
  const [activeTaskWidth, setActiveTaskWidth] = useState<number | null>(null);
  const columnsRef = useRef<HTMLDivElement>(null);
  const [dropIndicator, setDropIndicator] = useState<DropIndicatorState>({
    columnId: null,
    beforeTaskId: null,
  });

  // WebView-aware sensors for better Tauri/WKWebView support
  const sensors = useWebViewSensors({
    activationDistance: 5,
    enableKeyboard: true,
  });
  const dragModifiers = useMemo(
    () => (scaleDragTransform ? [scaleAwareModifier] : undefined),
    [scaleDragTransform]
  );

  useLayoutEffect(() => {
    if (fitColumnsToContainer && columnsRef.current) {
      columnsRef.current.scrollLeft = 0;
    }
  }, [fitColumnsToContainer, columnOrder.length, tasks.length, selectedTaskId]);

  // Custom collision detection that combines strategies for smooth cross-column detection
  const collisionDetection = useCallback(
    (args: Parameters<typeof pointerWithin>[0]) => {
      // First, check pointer intersection for columns
      const pointerCollisions = pointerWithin(args);

      // If we have pointer collisions, use them
      if (pointerCollisions.length > 0) {
        return pointerCollisions;
      }

      // Fall back to rect intersection for edge cases
      return rectIntersection(args);
    },
    []
  );

  // Group tasks by status
  const groupedTasks = useMemo(() => {
    const grouped = new Map<TaskStatus, KanbanTask[]>();

    // Initialize all columns
    columnOrder.forEach((column) => {
      grouped.set(column.id, []);
    });

    // Group tasks
    tasks.forEach((task) => {
      const column = grouped.get(task.status);
      if (column) {
        column.push(task);
      }
    });

    return grouped;
  }, [tasks, columnOrder]);

  // Get column IDs for SortableContext
  const columnIds = useMemo(
    () => columnOrder.map((col) => col.id),
    [columnOrder]
  );

  // Find active task or column for DragOverlay
  const activeTask = useMemo(() => {
    if (activeType !== "task" || !activeId) return null;
    return tasks.find((task) => task.id === activeId);
  }, [activeId, activeType, tasks]);

  const activeColumn = useMemo(() => {
    if (activeType !== "column" || !activeId) return null;
    return columnOrder.find((col) => col.id === activeId);
  }, [activeId, activeType, columnOrder]);

  // Handle drag start
  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const { active } = event;
      const activeIdStr = String(active.id);

      // Determine if dragging a column or a task
      const isColumn = columnOrder.some((col) => col.id === activeIdStr);

      setActiveId(activeIdStr);
      setActiveType(isColumn ? "column" : "task");
      setActiveTaskWidth(
        isColumn ? null : (active.rect.current.initial?.width ?? null)
      );
    },
    [columnOrder]
  );

  // Handle drag over (for moving tasks between columns and showing drop indicator)
  const handleDragOver = useCallback(
    (event: DragOverEvent) => {
      const { active, over } = event;

      if (!over || activeType !== "task") {
        setDropIndicator({ columnId: null, beforeTaskId: null });
        return;
      }

      const activeIdStr = String(active.id);
      const overIdStr = String(over.id);

      // Don't show indicator on self
      if (activeIdStr === overIdStr) {
        setDropIndicator({ columnId: null, beforeTaskId: null });
        return;
      }

      // Check if dropping onto a column directly (empty column or header)
      const targetColumn = columnOrder.find((col) => col.id === overIdStr);
      if (targetColumn) {
        // Dropping on column - show at end of column (null = end)
        setDropIndicator({
          columnId: targetColumn.id,
          beforeTaskId: null,
        });
        return;
      }

      // Dropping onto another task - show indicator BEFORE that task
      const overTask = tasks.find((task) => task.id === overIdStr);
      if (overTask) {
        setDropIndicator({
          columnId: overTask.status,
          beforeTaskId: overIdStr, // Show before this task
        });
      }
    },
    [activeType, columnOrder, tasks]
  );

  // Handle drag end
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;

      setActiveId(null);
      setActiveType(null);
      setActiveTaskWidth(null);
      setDropIndicator({ columnId: null, beforeTaskId: null });

      if (!over) return;

      const activeIdStr = String(active.id);
      const overIdStr = String(over.id);

      if (activeIdStr === overIdStr) return;

      // Check if dragging a column
      const isActiveColumn = columnOrder.some((col) => col.id === activeIdStr);

      if (isActiveColumn && allowColumnReorder) {
        // Column reordering
        const oldIndex = columnOrder.findIndex((col) => col.id === activeIdStr);
        const newIndex = columnOrder.findIndex((col) => col.id === overIdStr);

        if (oldIndex !== -1 && newIndex !== -1) {
          const newColumnOrder = arrayMove(columnOrder, oldIndex, newIndex);
          if (!isColumnOrderControlled) {
            setInternalColumnOrder(newColumnOrder);
          }
          onColumnOrderChange?.(newColumnOrder);
        }
        return;
      }

      // Task movement - find which column the task is being dropped into
      // over.id could be a column id or a task id
      let targetColumnId: TaskStatus | null = null;
      let beforeTaskId: string | null = null;
      let insertIndex: number | null = null;

      // Check if dropping onto a column directly
      const targetColumn = columnOrder.find((col) => col.id === overIdStr);
      if (targetColumn) {
        targetColumnId = targetColumn.id;
        // Dropping on column = end of column
        beforeTaskId = null;
        insertIndex = null;
      } else {
        // Dropping onto another task - find which column that task is in
        const overTask = tasks.find((task) => task.id === overIdStr);
        if (overTask) {
          targetColumnId = overTask.status;
          beforeTaskId = overIdStr;

          // Calculate insert index
          const columnTasks = groupedTasks.get(targetColumnId) || [];
          // Filter out the active task to get correct index
          const filteredColumnTasks = columnTasks.filter(
            (task) => task.id !== activeIdStr
          );
          insertIndex = filteredColumnTasks.findIndex(
            (task) => task.id === overIdStr
          );
        }
      }

      if (targetColumnId) {
        const moveInfo: TaskMoveInfo = {
          taskId: activeIdStr,
          newStatus: targetColumnId,
          index: insertIndex,
          beforeTaskId: beforeTaskId,
        };
        onTaskMove?.(activeIdStr, targetColumnId, moveInfo);
      }
    },
    [
      columnOrder,
      allowColumnReorder,
      isColumnOrderControlled,
      tasks,
      groupedTasks,
      onTaskMove,
      onColumnOrderChange,
    ]
  );

  const handleDragCancel = useCallback(() => {
    setActiveId(null);
    setActiveType(null);
    setActiveTaskWidth(null);
    setDropIndicator({ columnId: null, beforeTaskId: null });
  }, []);

  // Handle add task
  const handleAddTask = useCallback(
    (status: string) => {
      onAddTask?.(status as TaskStatus);
    },
    [onAddTask]
  );

  return (
    <div
      className={`kanban-board ${className}`}
      data-testid="kanban-board"
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minWidth: 0,
        overflow: "hidden",
      }}
    >
      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
        modifiers={dragModifiers}
      >
        <SortableContext
          items={columnIds}
          strategy={horizontalListSortingStrategy}
          disabled={!allowColumnReorder}
        >
          <div
            ref={columnsRef}
            className="kanban-board__columns"
            style={{
              display: "flex",
              flex: 1,
              minHeight: 0,
              minWidth: 0,
              overflowX: fitColumnsToContainer ? "hidden" : "auto",
              overflowY: "auto",
            }}
          >
            {columnOrder.map((column, index) => (
              <React.Fragment
                key={
                  taskRenderWindowKey == null
                    ? column.id
                    : `${column.id}:${taskRenderWindowKey}`
                }
              >
                <KanbanColumn
                  column={column}
                  tasks={groupedTasks.get(column.id) || []}
                  onTaskClick={onTaskClick}
                  onAddTask={handleAddTask}
                  isDragging={activeType === "column" && activeId === column.id}
                  showAddButton={column.showAddButton ?? showAddButton}
                  allowColumnDrag={allowColumnReorder}
                  allowTaskDrag={allowTaskDrag}
                  scaleDragTransform={scaleDragTransform}
                  useDragOverlay={useDragOverlay}
                  activeTaskId={
                    useDragOverlay && activeType === "task" ? activeId : null
                  }
                  selectedTaskId={selectedTaskId}
                  dropIndicator={
                    dropIndicator.columnId === column.id ? dropIndicator : null
                  }
                />
                {index < columnOrder.length - 1 && (
                  <div className="kanban-board__divider" />
                )}
              </React.Fragment>
            ))}
          </div>
        </SortableContext>

        {/* Drag overlay for visual feedback.
            DragOverlay portals to document root, so it lives outside the
            board container in the DOM. We tag the overlay with the same
            consumer class (`className` prop, e.g. "kanban-board--linear")
            so any variant CSS can still reach it. */}
        <DragOverlay>
          {useDragOverlay && activeTask && (
            <div
              className={`kanban-board ${className}`}
              style={{ width: activeTaskWidth ?? undefined }}
            >
              <TaskCard task={activeTask} isDragging />
            </div>
          )}
          {activeColumn && (
            <div className={`kanban-board ${className}`}>
              <div className="kanban-column kanban-column--dragging">
                <div
                  className="kanban-column__header"
                  style={{ backgroundColor: activeColumn.bgColor }}
                >
                  <div className="kanban-column__header-left">
                    <div
                      className="kanban-column__icon"
                      style={{ color: activeColumn.color }}
                    >
                      <activeColumn.icon size={16} />
                    </div>
                    <div className="kanban-column__title">
                      {t(`sessions:kanban.boardColumns.${activeColumn.id}`)}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </DragOverlay>
      </DndContext>
    </div>
  );
};

export default KanbanBoard;

// Re-export types and config for convenience
export type {
  KanbanColumnConfig,
  KanbanTask,
  KanbanTaskCreator,
  TaskPriority,
  TaskStatus,
} from "./types";
export {
  DEFAULT_KANBAN_COLUMNS,
  GITHUB_ISSUE_KANBAN_COLUMNS,
  getColumnConfig,
} from "./config";
export { KanbanColumn, TaskCard } from "./components";
