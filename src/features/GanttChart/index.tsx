/**
 * GanttChart Component
 *
 * A reusable Gantt chart component for visualizing tasks on a timeline.
 * Supports 3d/7d/1m/3m view scopes with dynamic column widths.
 *
 * @example
 * ```tsx
 * import GanttChart from "@src/features/GanttChart";
 *
 * <GanttChart
 *   tasks={tasks}
 *   onTaskClick={(task) => handleClick(task)}
 * />
 * ```
 */
import { useVirtualizer } from "@tanstack/react-virtual";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import GanttSidebar from "./components/Sidebar";
import GanttTimeline from "./components/Timeline";
import GanttToolbar from "./components/Toolbar";
import { generateViewScopePeriods, getMsPerColumn } from "./config";
import { useGanttDrag, useGanttScroll, useGanttZoom } from "./hooks";
import "./index.scss";
import type {
  GanttMarker,
  GanttMarkerRow,
  GanttMilestone,
  GanttTask,
  GanttTimeScale,
  GanttViewScope,
} from "./types";
import { DEFAULT_GANTT_CONFIG, VIEW_SCOPE_CONFIGS } from "./types";

// ============================================
// Types
// ============================================

export interface GanttChartProps {
  /** Array of tasks to display */
  tasks: GanttTask[];
  /** Default view scope (3d, 7d, 1m, 3m) */
  defaultViewScope?: GanttViewScope;
  /** @deprecated Use defaultViewScope instead */
  defaultTimeScale?: GanttTimeScale;
  /** Callback when a task is clicked */
  onTaskClick?: (task: GanttTask) => void;
  /** Currently selected task ID */
  selectedTaskId?: string | null;
  /** Additional className */
  className?: string;
  /** Enable drag-to-resize and drag-to-move */
  editable?: boolean;
  /** Callback when task dates are updated via drag */
  onTaskUpdate?: (
    taskId: string,
    updates: { startDate?: Date; endDate?: Date }
  ) => void;
  /** Snap to grid when dragging (default: true) */
  snapToGrid?: boolean;
  /** Show tooltips on hover (default: true) */
  showTooltips?: boolean;
  renderTooltipWrapper?: (
    task: GanttTask,
    children: React.ReactElement
  ) => React.ReactElement;
  /** Callback when task is edited */
  onEdit?: (task: GanttTask) => void;
  /** Callback when task is deleted */
  onDelete?: (taskId: string) => void;
  /** Callback when task status is changed */
  onStatusChange?: (taskId: string, status: GanttTask["status"]) => void;
  /** Array of milestones to display */
  milestones?: GanttMilestone[];
  /** Callback when milestone is clicked */
  onMilestoneClick?: (milestone: GanttMilestone) => void;
  /** Show dependency arrows (default: false) */
  showDependencies?: boolean;
  /** Enable zoom controls (default: false) */
  enableZoom?: boolean;
  /** Default zoom level (default: 100) */
  defaultZoom?: number;
  /** Initial timeline date. Defaults to today. */
  initialDate?: Date;
  /** Optional timestamp to bring into view on initial horizontal scroll. */
  initialScrollTargetDate?: Date;
  /** Horizontal alignment for initialScrollTargetDate. */
  initialScrollTargetAlignment?: "start" | "center";
  /** Show a vertical marker at the current time when it falls inside the timeline. */
  showCurrentTimeMarker?: boolean;
  /** Hide the built-in Gantt toolbar. */
  hideToolbar?: boolean;
  /** Remove the default Gantt surface background. */
  transparentSurface?: boolean;
  /** Number of offscreen period windows to generate before/after the visible range. */
  periodScrollMultiplier?: number;
  /** Optional minimum width for each timeline column. */
  minColumnWidth?: number;
  /** Hide the secondary date row while keeping the primary time row. */
  hideTimelineDateHeader?: boolean;
  /** Hide timeline body scrollbars while preserving scroll behavior. */
  hideScrollbars?: boolean;
  /** Remove timeline header/grid background highlights. */
  transparentTimelineSurface?: boolean;
  /** Show agent/session icons before task titles in the sidebar. */
  showSidebarTaskIcons?: boolean;
  /** Show assignee labels after task titles in the sidebar. */
  showSidebarAssigneeLabels?: boolean;
  /** Marker rows rendered as dot timelines below task rows. */
  markerRows?: GanttMarkerRow[];
  /** Optional marker hover wrapper. */
  renderMarkerTooltipWrapper?: (
    marker: GanttMarker,
    row: GanttMarkerRow,
    children: React.ReactElement
  ) => React.ReactElement;
  /** Format primary timeline header labels without changing period generation. */
  formatPrimaryHeaderLabel?: (date: Date, viewScope: GanttViewScope) => string;
  /** Emphasize selected primary timeline header labels. */
  isPrimaryHeaderLabelEmphasized?: (
    date: Date,
    viewScope: GanttViewScope
  ) => boolean;
}

// ============================================
// Helper Functions
// ============================================

function parseDate(date: Date | string): Date {
  if (date instanceof Date) return date;
  return new Date(date);
}

// ============================================
// Component
// ============================================

// Map legacy timeScale to viewScope
function mapTimeScaleToViewScope(timeScale: GanttTimeScale): GanttViewScope {
  const mapping: Record<GanttTimeScale, GanttViewScope> = {
    day: "3d",
    week: "7d",
    month: "1m",
    quarter: "3m",
  };
  return mapping[timeScale];
}

const GanttChart: React.FC<GanttChartProps> = ({
  tasks,
  defaultViewScope,
  defaultTimeScale = "week",
  onTaskClick,
  selectedTaskId,
  className = "",
  editable = false,
  onTaskUpdate,
  snapToGrid = true,
  showTooltips = true,
  renderTooltipWrapper,
  onEdit,
  onDelete,
  onStatusChange,
  milestones = [],
  onMilestoneClick,
  showDependencies = false,
  enableZoom = false,
  defaultZoom = 100,
  initialDate,
  initialScrollTargetDate,
  initialScrollTargetAlignment = "start",
  showCurrentTimeMarker = false,
  hideToolbar = false,
  transparentSurface = false,
  periodScrollMultiplier = 5,
  minColumnWidth,
  hideTimelineDateHeader = false,
  hideScrollbars = false,
  transparentTimelineSurface = false,
  showSidebarTaskIcons = false,
  showSidebarAssigneeLabels = true,
  markerRows = [],
  renderMarkerTooltipWrapper,
  formatPrimaryHeaderLabel,
  isPrimaryHeaderLabelEmphasized,
}) => {
  // Determine initial view scope from props
  const initialViewScope =
    defaultViewScope ?? mapTimeScaleToViewScope(defaultTimeScale);

  const [viewScope, setViewScope] = useState<GanttViewScope>(initialViewScope);
  const [viewStart, setViewStart] = useState<Date>(() => {
    const startDate = initialDate ? new Date(initialDate) : new Date();
    startDate.setHours(0, 0, 0, 0);
    return startDate;
  });
  const [containerWidth, setContainerWidth] = useState(0);

  const timelineContainerRef = useRef<HTMLDivElement>(null);
  const timelineBodyRef = useRef<HTMLDivElement>(null);
  const sidebarContentRef = useRef<HTMLDivElement>(null);
  const headerScrollRef = useRef<HTMLDivElement>(null);
  const hasAppliedInitialScrollRef = useRef(false);

  const config = DEFAULT_GANTT_CONFIG;
  const scopeConfig = VIEW_SCOPE_CONFIGS[viewScope];

  // Measure container width for dynamic column sizing
  useEffect(() => {
    const container = timelineContainerRef.current;
    if (!container) return;

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const width = entry.contentRect.width - config.sidebarWidth;
        setContainerWidth(Math.max(width, 0));
      }
    });

    resizeObserver.observe(container);

    // Initial measurement
    const initialWidth = container.offsetWidth - config.sidebarWidth;
    setContainerWidth(Math.max(initialWidth, 0));

    return () => resizeObserver.disconnect();
  }, [config.sidebarWidth]);

  // Zoom functionality
  const { zoomLevel, zoomIn, zoomOut, resetZoom, getScaledColumnWidth } =
    useGanttZoom({
      defaultZoom: defaultZoom as 50 | 75 | 100 | 125 | 150 | 200,
    });

  // Calculate dynamic column width based on container and number of columns
  const columnWidth = useMemo(() => {
    if (containerWidth <= 0) return config.minColumnWidth;

    const baseWidth = containerWidth / scopeConfig.columns;
    const scaledWidth = enableZoom
      ? getScaledColumnWidth(baseWidth)
      : baseWidth;

    return Math.max(scaledWidth, minColumnWidth ?? config.minColumnWidth);
  }, [
    containerWidth,
    scopeConfig.columns,
    enableZoom,
    getScaledColumnWidth,
    config.minColumnWidth,
    minColumnWidth,
  ]);

  // Generate periods using the new view scope model (bidirectional from viewStart)
  const periods = useMemo(() => {
    return generateViewScopePeriods(
      viewStart,
      viewScope,
      periodScrollMultiplier
    );
  }, [periodScrollMultiplier, viewStart, viewScope]);

  // The actual start date of the timeline (first period)
  const timelineStart = useMemo(() => {
    if (periods.length === 0) return viewStart;
    return periods[0].date;
  }, [periods, viewStart]);

  // Calculate total width
  const totalWidth = periods.length * columnWidth;

  const totalRowCount = markerRows.length + tasks.length;
  // The timeline body is the single scroll authority. Both panes consume this
  // exact row window, which keeps their absolute row offsets synchronized.
  // Fixed sizing plus overscan lets scroll-driven renders stay asynchronous;
  // forcing React to flush inside the native scroll event stalls the WebView.
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual exposes imperative helpers that cannot be memoized safely.
  const rowVirtualizer = useVirtualizer({
    count: totalRowCount,
    getScrollElement: () => timelineBodyRef.current,
    estimateSize: () => config.rowHeight,
    overscan: 6,
    useFlushSync: false,
    getItemKey: (index) => {
      if (index < markerRows.length) {
        return `marker:${markerRows[index]?.id ?? index}`;
      }
      return `task:${tasks[index - markerRows.length]?.id ?? index}`;
    },
  });
  const periodVirtualizer = useVirtualizer({
    horizontal: true,
    count: periods.length,
    getScrollElement: () => timelineBodyRef.current,
    estimateSize: () => columnWidth,
    overscan: 3,
    useFlushSync: false,
    getItemKey: (index) => periods[index]?.date.getTime() ?? index,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();
  const virtualPeriods = periodVirtualizer.getVirtualItems();
  const isVirtualizerScrolling =
    rowVirtualizer.isScrolling || periodVirtualizer.isScrolling;

  // Column widths change with zoom and container resizing. Clear the horizontal
  // size cache so visible-period offsets stay exact after either transition.
  useEffect(() => {
    periodVirtualizer.measure();
  }, [columnWidth, periodVirtualizer, periods]);

  const initialScrollOffset = useMemo(() => {
    const msPerColumn = getMsPerColumn(viewScope);
    const targetDate = initialScrollTargetDate ?? viewStart;
    const msFromStart = targetDate.getTime() - timelineStart.getTime();
    const targetOffset = (msFromStart / msPerColumn) * columnWidth;

    if (initialScrollTargetAlignment === "center") {
      return Math.max(targetOffset - containerWidth / 2, 0);
    }

    return Math.max(targetOffset, 0);
  }, [
    initialScrollTargetAlignment,
    initialScrollTargetDate,
    viewStart,
    timelineStart,
    viewScope,
    columnWidth,
    containerWidth,
  ]);

  useEffect(() => {
    if (hasAppliedInitialScrollRef.current || containerWidth <= 0) return;
    if (!timelineBodyRef.current) return;

    timelineBodyRef.current.scrollLeft = initialScrollOffset;
    if (headerScrollRef.current) {
      headerScrollRef.current.scrollLeft = initialScrollOffset;
    }
    hasAppliedInitialScrollRef.current = true;
  }, [containerWidth, initialScrollOffset]);

  // Hooks
  const { handleTimelineScroll, handleSidebarScroll } = useGanttScroll({
    timelineBodyRef,
    sidebarContentRef,
    headerScrollRef,
  });

  // Navigation handlers
  const handleNavigate = useCallback(
    (direction: "prev" | "next") => {
      const scopeConfig = VIEW_SCOPE_CONFIGS[viewScope];
      const daysToMove =
        direction === "next" ? scopeConfig.days : -scopeConfig.days;

      setViewStart((prev) => {
        const newDate = new Date(prev);
        newDate.setDate(newDate.getDate() + daysToMove);
        return newDate;
      });
    },
    [viewScope]
  );

  const handleGoToToday = useCallback(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    setViewStart(today);
  }, []);

  // Drag functionality - map viewScope to legacy timeScale for drag hook
  const legacyTimeScale: GanttTimeScale = useMemo(() => {
    const mapping: Record<GanttViewScope, GanttTimeScale> = {
      "1d": "day",
      "3d": "day",
      "7d": "week",
      "1m": "month",
      "3m": "quarter",
    };
    return mapping[viewScope];
  }, [viewScope]);

  const { dragState, ghostPreview, handleResizeStart, handleMoveStart } =
    useGanttDrag({
      viewScope,
      columnWidth,
      viewStart: timelineStart, // Use timelineStart for correct position calculations
      snapToGrid,
      onTaskUpdate,
    });

  // Drag handlers with task context
  const handleTaskResizeStart = (
    taskId: string,
    edge: "start" | "end",
    task: GanttTask,
    event: React.MouseEvent
  ) => {
    const start = parseDate(task.startDate);
    const end = parseDate(task.endDate);
    handleResizeStart(taskId, edge, start, end, event);
  };

  const handleTaskMoveStart = (
    taskId: string,
    task: GanttTask,
    event: React.MouseEvent
  ) => {
    const start = parseDate(task.startDate);
    const end = parseDate(task.endDate);
    handleMoveStart(taskId, start, end, event);
  };

  // Handle view scope change
  const handleViewScopeChange = (newScope: GanttViewScope) => {
    setViewScope(newScope);
  };

  // Legacy handler — maps old TimeScale to ViewScope
  const handleTimeScaleChange = (newScale: GanttTimeScale) => {
    const newScope = mapTimeScaleToViewScope(newScale);
    setViewScope(newScope);
  };

  return (
    <div
      ref={timelineContainerRef}
      className={`flex h-full w-full flex-col overflow-hidden ${transparentSurface ? "" : "bg-bg-2"} ${className}`}
    >
      {!hideToolbar && (
        <GanttToolbar
          timeScale={legacyTimeScale}
          viewScope={viewScope}
          onTimeScaleChange={handleTimeScaleChange}
          onViewScopeChange={handleViewScopeChange}
          onNavigate={handleNavigate}
          onGoToToday={handleGoToToday}
          currentDate={viewStart}
          zoomLevel={enableZoom ? zoomLevel : undefined}
          onZoomIn={enableZoom ? zoomIn : undefined}
          onZoomOut={enableZoom ? zoomOut : undefined}
          onResetZoom={enableZoom ? resetZoom : undefined}
        />
      )}

      {/* Main Container */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Sidebar */}
        <GanttSidebar
          tasks={tasks}
          markerRows={markerRows}
          config={config}
          selectedTaskId={selectedTaskId}
          onTaskClick={onTaskClick}
          sidebarContentRef={sidebarContentRef}
          compactHeader={hideTimelineDateHeader}
          hideScrollbars={hideScrollbars}
          transparentSurface={transparentSurface}
          showTaskIcons={showSidebarTaskIcons}
          showAssigneeLabel={showSidebarAssigneeLabels}
          virtualRows={virtualRows}
          totalSize={rowVirtualizer.getTotalSize()}
          onScroll={handleSidebarScroll}
        />

        {/* Timeline */}
        <GanttTimeline
          tasks={tasks}
          markerRows={markerRows}
          config={config}
          viewScope={viewScope}
          timeScale={legacyTimeScale}
          viewStart={timelineStart}
          timelineStart={timelineStart}
          periods={periods}
          columnWidth={columnWidth}
          totalWidth={totalWidth}
          timelineBodyRef={timelineBodyRef}
          headerScrollRef={headerScrollRef}
          onTimelineScroll={handleTimelineScroll}
          onTaskClick={onTaskClick}
          editable={editable}
          dragState={dragState}
          ghostPreview={ghostPreview}
          onTaskResizeStart={handleTaskResizeStart}
          onTaskMoveStart={handleTaskMoveStart}
          showTooltips={showTooltips && !isVirtualizerScrolling}
          renderTooltipWrapper={renderTooltipWrapper}
          renderMarkerTooltipWrapper={
            isVirtualizerScrolling ? undefined : renderMarkerTooltipWrapper
          }
          hideDateHeader={hideTimelineDateHeader}
          hideScrollbars={hideScrollbars}
          transparentSurface={transparentTimelineSurface}
          formatPrimaryHeaderLabel={formatPrimaryHeaderLabel}
          isPrimaryHeaderLabelEmphasized={isPrimaryHeaderLabelEmphasized}
          showCurrentTimeMarker={showCurrentTimeMarker}
          onEdit={onEdit}
          onDelete={onDelete}
          onStatusChange={onStatusChange}
          milestones={milestones}
          onMilestoneClick={onMilestoneClick}
          showDependencies={showDependencies}
          highlightedTaskId={selectedTaskId}
          virtualRows={virtualRows}
          totalRowSize={rowVirtualizer.getTotalSize()}
          virtualPeriods={virtualPeriods}
        />
      </div>
    </div>
  );
};

export default GanttChart;

// Re-export types for convenience
export type {
  GanttConfig,
  GanttGroup,
  GanttMarker,
  GanttMarkerRow,
  GanttTask,
  GanttTaskStatus,
  GanttTimeScale,
  GanttViewScope,
  GanttTimeUnit,
  GanttMilestone,
  GanttMilestoneType,
} from "./types";
export { TIME_SCALE_OPTIONS, VIEW_SCOPE_OPTIONS } from "./config";
export { DEFAULT_GANTT_CONFIG, VIEW_SCOPE_CONFIGS } from "./types";
