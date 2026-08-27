/**
 * KanbanColumn Component
 *
 * Column container for Kanban tasks with drag-and-drop support using dnd-kit.
 * Displays tasks grouped by status.
 */
import { useDroppable } from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useVirtualizer } from "@tanstack/react-virtual";
import cn from "classnames";
import { Plus } from "lucide-react";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { Placeholder } from "@src/components/Placeholder";
import {
  HEADER_BUTTON,
  HEADER_ICON_SIZE,
} from "@src/config/workstation/tokens";
import { getUiScaleFromCssVar } from "@src/lib/dndKit";

import type { KanbanColumnConfig, KanbanTask } from "../../types";
import TaskCard from "../TaskCard";
import "./index.scss";
import {
  INITIAL_TASK_RENDER_COUNT,
  getNextTaskRenderCount,
} from "./taskRenderWindow";

// Drop indicator state type
interface DropIndicatorState {
  columnId: string | null;
  beforeTaskId: string | null;
}

/**
 * Keep the first page in normal document flow so dnd-kit's reorder animation
 * remains pixel-identical for the common case. Once another page is revealed,
 * TanStack Virtual windows the revealed range.
 */
const STATIC_TASK_RENDER_LIMIT = INITIAL_TASK_RENDER_COUNT;

/**
 * Seed height for an unmeasured card. Cards are measured on mount (heights vary
 * with description, tags, and meta rows), so this only affects the very first
 * frame and the scrollbar estimate for not-yet-rendered rows.
 */
const ESTIMATED_TASK_CARD_HEIGHT = 96;

interface ScrollEdgeState {
  atTop: boolean;
  atBottom: boolean;
}

export interface KanbanColumnProps {
  column: KanbanColumnConfig;
  tasks: KanbanTask[];
  onTaskClick?: (task: KanbanTask) => void;
  onTaskContextMenu?: (task: KanbanTask, event: React.MouseEvent) => void;
  onAddTask?: (status: string) => void;
  isDragging?: boolean;
  showAddButton?: boolean;
  allowColumnDrag?: boolean;
  allowTaskDrag?: boolean;
  scaleDragTransform?: boolean;
  useDragOverlay?: boolean;
  /** ID of the task currently being dragged (null if dragging a column or nothing) */
  activeTaskId?: string | null;
  /** ID of the task whose preview panel is currently open (null if none) */
  selectedTaskId?: string | null;
  /** Drop indicator position for this column */
  dropIndicator?: DropIndicatorState | null;
}

const KanbanColumn: React.FC<KanbanColumnProps> = ({
  column,
  tasks,
  onTaskClick,
  onTaskContextMenu,
  onAddTask,
  isDragging,
  showAddButton = true,
  allowColumnDrag = true,
  allowTaskDrag = true,
  scaleDragTransform = true,
  useDragOverlay = true,
  activeTaskId,
  selectedTaskId,
  dropIndicator,
}) => {
  const { t } = useTranslation();
  const Icon = column.icon;

  // Sortable hook for column dragging
  const {
    attributes,
    listeners,
    setNodeRef: setSortableRef,
    transform,
    transition,
    isDragging: isSortableDragging,
  } = useSortable({
    id: column.id,
    disabled: !allowColumnDrag,
  });

  // Droppable hook for receiving tasks
  const { setNodeRef: setDroppableRef, isOver } = useDroppable({
    id: column.id,
  });
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const loadedAtScrollHeightRef = useRef<number | null>(null);
  const [renderedTaskCount, setRenderedTaskCount] = useState(
    INITIAL_TASK_RENDER_COUNT
  );
  const [scrollEdges, setScrollEdges] = useState<ScrollEdgeState>({
    atTop: true,
    atBottom: true,
  });
  const updateScrollEdges = useCallback(() => {
    const body = bodyRef.current;
    if (!body) return;
    const maxScrollTop = Math.max(0, body.scrollHeight - body.clientHeight);
    const nextEdges = {
      atTop: body.scrollTop <= 1,
      atBottom: body.scrollTop >= maxScrollTop - 1,
    };
    setScrollEdges((previousEdges) =>
      previousEdges.atTop === nextEdges.atTop &&
      previousEdges.atBottom === nextEdges.atBottom
        ? previousEdges
        : nextEdges
    );
  }, []);
  const setBodyNode = useCallback(
    (node: HTMLDivElement | null) => {
      bodyRef.current = node;
      setDroppableRef(node);
      updateScrollEdges();
    },
    [setDroppableRef, updateScrollEdges]
  );

  // Get filtered tasks (excluding the actively dragged task)
  const filteredTasks = useMemo(
    () => tasks.filter((task) => task.id !== activeTaskId),
    [tasks, activeTaskId]
  );

  // Get task IDs for SortableContext
  const taskIds = useMemo(
    () => filteredTasks.map((task) => task.id),
    [filteredTasks]
  );

  const renderedTasks = useMemo(
    () => filteredTasks.slice(0, renderedTaskCount),
    [filteredTasks, renderedTaskCount]
  );
  const hasMoreTasks = renderedTasks.length < filteredTasks.length;

  useEffect(() => {
    loadedAtScrollHeightRef.current = null;
  }, [tasks]);

  const handleBodyScroll = useCallback(() => {
    updateScrollEdges();

    const body = bodyRef.current;
    if (!body || !hasMoreTasks) return;

    const maxScrollTop = Math.max(0, body.scrollHeight - body.clientHeight);
    const reachedBottom = body.scrollTop >= maxScrollTop - 1;
    if (!reachedBottom) return;

    // A momentum-scroll can dispatch several events before React commits the
    // next page. Keying the reveal to the current content height guarantees
    // one batch per distinct bottom reach instead of skipping 25 -> 75.
    if (loadedAtScrollHeightRef.current === body.scrollHeight) return;
    loadedAtScrollHeightRef.current = body.scrollHeight;
    setRenderedTaskCount((currentCount) =>
      getNextTaskRenderCount(currentCount, filteredTasks.length)
    );
  }, [filteredTasks.length, hasMoreTasks, updateScrollEdges]);

  useEffect(() => {
    updateScrollEdges();
  }, [renderedTasks.length, showAddButton, updateScrollEdges]);

  // Check if we should show indicator at end of column (when beforeTaskId is null)
  const showEndIndicator =
    dropIndicator?.columnId === column.id &&
    dropIndicator?.beforeTaskId === null;

  // Apply UI scale correction when the consumer opts into it.
  const uiScale = scaleDragTransform ? getUiScaleFromCssVar() : 1;
  const correctedTransform = transform
    ? {
        ...transform,
        x: transform.x / uiScale,
        y: transform.y / uiScale,
      }
    : null;

  const columnStyle: React.CSSProperties = {
    transform: CSS.Transform.toString(correctedTransform),
    transition,
    opacity: isSortableDragging ? 0.5 : 1,
  };
  const handleAddTask = () => {
    onAddTask?.(column.id);
  };

  return (
    <div
      ref={setSortableRef}
      style={columnStyle}
      className={cn("kanban-column", {
        "kanban-column--dragging": isDragging || isSortableDragging,
        "kanban-column--receiving": isOver || dropIndicator !== null,
      })}
    >
      {/* Column Header - Draggable handle (only when allowColumnDrag is
       * true, otherwise no grab cursor / no listeners). */}
      <div
        className={cn("kanban-column__header", {
          "kanban-column__header--draggable": allowColumnDrag,
        })}
        {...(allowColumnDrag ? attributes : {})}
        {...(allowColumnDrag ? listeners : {})}
      >
        <div className="kanban-column__header-left">
          <div className="kanban-column__icon" style={{ color: column.color }}>
            <Icon size={16} />
          </div>
          <div className="kanban-column__title">
            {/* `column.title` is the source of truth for the header label.
             * It must be an i18n key (optionally namespace-prefixed, e.g.
             * "sessions:kanban.boardColumns.todo"). i18next returns the key
             * unchanged when no translation is found, so plain strings still
             * render correctly — but every consumer should pass a key so
             * locale switching works. */}
            {t(column.title)}
          </div>
          <span className="kanban-column__count">{tasks.length}</span>
        </div>
        {showAddButton && (
          <button
            type="button"
            className={`kanban-column__add-btn ${HEADER_BUTTON.actionTreeRow}`}
            onClick={handleAddTask}
          >
            <Plus size={HEADER_ICON_SIZE.sm} />
          </button>
        )}
      </div>

      {/* Column Body - Droppable Area */}
      <div
        ref={setBodyNode}
        className={cn("kanban-column__body", {
          "kanban-column__body--dragging-over":
            isOver || dropIndicator !== null,
          "kanban-column__body--empty": filteredTasks.length === 0,
          "kanban-column__body--at-top": scrollEdges.atTop,
          "kanban-column__body--at-bottom": scrollEdges.atBottom,
        })}
        onScroll={handleBodyScroll}
      >
        <SortableContext
          items={taskIds}
          strategy={verticalListSortingStrategy}
          disabled={!allowTaskDrag}
        >
          {filteredTasks.length === 0 && !showEndIndicator ? (
            <div className="kanban-column__empty">
              <Placeholder variant="empty" title={t("placeholders.noTasks")} />
            </div>
          ) : (
            <ColumnTaskList
              tasks={renderedTasks}
              scrollElementRef={bodyRef}
              onTaskClick={onTaskClick}
              onTaskContextMenu={onTaskContextMenu}
              dropIndicator={dropIndicator}
              columnColor={column.color}
              allowTaskDrag={allowTaskDrag}
              scaleDragTransform={scaleDragTransform}
              useDragOverlay={useDragOverlay}
              selectedTaskId={selectedTaskId}
              showEndIndicator={showEndIndicator}
            />
          )}
        </SortableContext>
      </div>
    </div>
  );
};

// ============================================
// DropIndicatorLine - Visual drop position indicator
// ============================================

interface DropIndicatorLineProps {
  color: string;
}

const DropIndicatorLine: React.FC<DropIndicatorLineProps> = ({ color }) => {
  return (
    <div className="kanban-drop-indicator">
      <div
        className="kanban-drop-indicator__dot"
        style={{ backgroundColor: color }}
      />
      <div
        className="kanban-drop-indicator__line"
        style={{ backgroundColor: color }}
      />
      <div
        className="kanban-drop-indicator__dot"
        style={{ backgroundColor: color }}
      />
    </div>
  );
};

// ============================================
// ColumnTaskList - static / virtualized card list
// ============================================

interface ColumnTaskListProps {
  tasks: KanbanTask[];
  /** The scrollable column body — used as the virtualizer's scroll element. */
  scrollElementRef: React.MutableRefObject<HTMLDivElement | null>;
  onTaskClick?: (task: KanbanTask) => void;
  onTaskContextMenu?: (task: KanbanTask, event: React.MouseEvent) => void;
  dropIndicator?: DropIndicatorState | null;
  columnColor: string;
  allowTaskDrag: boolean;
  scaleDragTransform: boolean;
  useDragOverlay: boolean;
  selectedTaskId?: string | null;
  showEndIndicator: boolean;
}

/**
 * Renders a column's cards. Short columns take the static flow path (identical
 * to the pre-virtualization behaviour, including dnd-kit's reorder animation);
 * long columns switch to a windowed renderer so only on-screen cards mount.
 *
 * The full task-id ordering still lives in the parent `<SortableContext>`, so
 * drag math stays correct even for cards that aren't currently rendered.
 */
const ColumnTaskList: React.FC<ColumnTaskListProps> = ({
  tasks,
  scrollElementRef,
  onTaskClick,
  onTaskContextMenu,
  dropIndicator,
  columnColor,
  allowTaskDrag,
  scaleDragTransform,
  useDragOverlay,
  selectedTaskId,
  showEndIndicator,
}) => {
  const renderCard = useCallback(
    (task: KanbanTask, suppressSortTransform: boolean) => (
      <SortableTaskCard
        key={task.id}
        task={task}
        onTaskClick={task.canOpen === false ? undefined : onTaskClick}
        onTaskContextMenu={
          task.canOpen === false ? undefined : onTaskContextMenu
        }
        showIndicatorBefore={dropIndicator?.beforeTaskId === task.id}
        indicatorColor={columnColor}
        allowDrag={allowTaskDrag && task.canMove !== false}
        scaleDragTransform={scaleDragTransform}
        useDragOverlay={useDragOverlay}
        isSelected={selectedTaskId != null && task.id === selectedTaskId}
        suppressSortTransform={suppressSortTransform}
      />
    ),
    [
      allowTaskDrag,
      columnColor,
      dropIndicator?.beforeTaskId,
      onTaskClick,
      onTaskContextMenu,
      scaleDragTransform,
      selectedTaskId,
      useDragOverlay,
    ]
  );

  if (tasks.length <= STATIC_TASK_RENDER_LIMIT) {
    return (
      <>
        {tasks.map((task) => renderCard(task, false))}
        {showEndIndicator && <DropIndicatorLine color={columnColor} />}
      </>
    );
  }

  return (
    <VirtualTaskList
      tasks={tasks}
      scrollElementRef={scrollElementRef}
      renderCard={renderCard}
      columnColor={columnColor}
      showEndIndicator={showEndIndicator}
    />
  );
};

// ============================================
// VirtualTaskList - windowed card renderer
// ============================================

interface VirtualTaskListProps {
  tasks: KanbanTask[];
  scrollElementRef: React.MutableRefObject<HTMLDivElement | null>;
  renderCard: (
    task: KanbanTask,
    suppressSortTransform: boolean
  ) => React.ReactNode;
  columnColor: string;
  showEndIndicator: boolean;
}

const VirtualTaskList: React.FC<VirtualTaskListProps> = ({
  tasks,
  scrollElementRef,
  renderCard,
  columnColor,
  showEndIndicator,
}) => {
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual exposes imperative helpers that cannot be memoized safely.
  const virtualizer = useVirtualizer({
    count: tasks.length,
    getScrollElement: () => scrollElementRef.current,
    estimateSize: () => ESTIMATED_TASK_CARD_HEIGHT,
    overscan: 6,
    getItemKey: (index) => tasks[index]?.id ?? index,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  // Dynamic measurement — card heights vary (description, tags, meta rows), so
  // each rendered row is measured via TanStack's own `measureElement` ref. It
  // manages the ResizeObserver internally and unobserves on unmount, so detached
  // rows don't leak while scrolling. Because an absolutely-positioned row
  // establishes its own block formatting context, the card's `margin-bottom`
  // gap is included in the measured height — inter-card spacing is preserved
  // with no style changes.
  return (
    <div
      className="kanban-column__virtual"
      style={{ position: "relative", width: "100%", height: totalSize }}
    >
      {virtualItems.map((virtualItem) => {
        const task = tasks[virtualItem.index];
        if (!task) return null;
        return (
          <div
            key={virtualItem.key}
            ref={virtualizer.measureElement}
            data-index={virtualItem.index}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              transform: `translateY(${virtualItem.start}px)`,
            }}
          >
            {/* Sort transform is suppressed in the virtualized path: rows are
                positioned by the virtualizer, so a second dnd-kit translate
                would fight it. The drop indicator conveys drop position. */}
            {renderCard(task, true)}
          </div>
        );
      })}
      {showEndIndicator && (
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            transform: `translateY(${totalSize}px)`,
          }}
        >
          <DropIndicatorLine color={columnColor} />
        </div>
      )}
    </div>
  );
};

// ============================================
// SortableTaskCard - Inner sortable wrapper
// ============================================

interface SortableTaskCardProps {
  task: KanbanTask;
  onTaskClick?: (task: KanbanTask) => void;
  onTaskContextMenu?: (task: KanbanTask, event: React.MouseEvent) => void;
  showIndicatorBefore?: boolean;
  indicatorColor?: string;
  allowDrag?: boolean;
  scaleDragTransform?: boolean;
  useDragOverlay?: boolean;
  isSelected?: boolean;
  /**
   * When true, the dnd-kit sort transform/transition are dropped. The
   * virtualized column path sets this because it positions each row itself —
   * letting the sortable also translate the card would double-offset it.
   */
  suppressSortTransform?: boolean;
}

const SortableTaskCard: React.FC<SortableTaskCardProps> = ({
  task,
  onTaskClick,
  onTaskContextMenu,
  showIndicatorBefore,
  indicatorColor = "var(--color-primary-6)",
  allowDrag = true,
  scaleDragTransform = true,
  useDragOverlay = true,
  isSelected = false,
  suppressSortTransform = false,
}) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id, disabled: !allowDrag });

  // Apply UI scale correction when the consumer opts into it.
  const uiScale = scaleDragTransform ? getUiScaleFromCssVar() : 1;
  const correctedTransform =
    transform && !suppressSortTransform
      ? {
          ...transform,
          x: transform.x / uiScale,
          y: transform.y / uiScale,
        }
      : null;

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(correctedTransform),
    transition: suppressSortTransform
      ? undefined
      : transition || "transform 200ms ease",
    opacity: useDragOverlay && isDragging ? 0 : 1,
    zIndex: isDragging ? 999 : "auto",
  };

  return (
    <>
      {/* Drop indicator BEFORE this task */}
      {showIndicatorBefore && <DropIndicatorLine color={indicatorColor} />}
      <div
        ref={setNodeRef}
        style={style}
        className={cn("kanban-task-wrapper", {
          "kanban-task-wrapper--overlay-dragging": useDragOverlay && isDragging,
          "kanban-task-wrapper--source-dragging": !useDragOverlay && isDragging,
        })}
        {...(allowDrag ? attributes : {})}
        {...(allowDrag ? listeners : {})}
      >
        <TaskCard
          task={task}
          onClick={onTaskClick}
          onContextMenu={onTaskContextMenu}
          isDragging={isDragging}
          isSelected={isSelected}
        />
      </div>
    </>
  );
};

export default KanbanColumn;
