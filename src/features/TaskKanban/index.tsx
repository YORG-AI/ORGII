/**
 * Kanban Page
 *
 * Independent session board — NOT linked to a specific repo or session.
 * Shows ALL sessions (both OS Agent and coding) grouped by status columns.
 *
 * Time range select (12h | 24h | 3d | 7d):
 * - All columns stay visible
 * - Sessions older than the selected window are filtered out
 *
 * View mode (kanban / diary) is driven by the `?view=` URL search param,
 * toggled from the Kanban Workstation header tabs.
 */
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router-dom";

import Button from "@src/components/Button";
import FloatingWindow from "@src/components/FloatingWindow";
import {
  WORK_MANAGEMENT_SESSION_PREVIEW_OVERLAY_CLASS,
  WORK_MANAGEMENT_SESSION_PREVIEW_SURFACE_CLASS,
} from "@src/config/workManagementCardTokens";
import type { KanbanTask, TaskStatus } from "@src/features/KanbanBoard";
import { useCloudSessionActions } from "@src/features/Org2Cloud/useCloudSessionActions";
import { sidebarSelectedOrgIdAtom } from "@src/features/Organizations/sidebarOrgScopeAtom";
import { loadSessionRoster } from "@src/store/session";
import {
  kanbanAgentTypeFilterAtom,
  kanbanAutoArchiveTtlAtom,
  kanbanCloudPreviewTargetAtom,
  kanbanDetailPanelVisibleAtom,
  kanbanManualArchivedSessionIdsAtom,
  kanbanSearchQueryAtom,
  kanbanSelectedTaskIdAtom,
  kanbanSidebarFilterAtom,
  kanbanTimeFilterAtom,
} from "@src/store/ui/kanbanViewStateAtom";
import {
  toggleWorkManagementCreatorVisibleAtom,
  workManagementCreatorVisibleAtom,
} from "@src/store/ui/workManagementCreatorAtom";

import { parseFactoryViewMode } from "./components/FactoryViewPill";
import TaskDetailPanel from "./components/TaskDetailPanel";
import TaskKanbanContent from "./components/TaskKanbanContent";
import {
  type AgentKanbanColumnId,
  DEFAULT_KANBAN_TIME_FILTER,
  type KanbanTimeFilter,
} from "./config";
import { useKanbanCardContextMenu } from "./hooks/useKanbanCardContextMenu";
import { useKanbanTasks } from "./hooks/useKanbanTasks";
import { useTaskKanbanFilters } from "./hooks/useTaskKanbanFilters";
import { useTaskKanbanHeader } from "./hooks/useTaskKanbanHeader";
import { resolveKanbanPreviewTask } from "./utils/cloudSessionPreview";
import {
  beginKanbanHorizontalScrollGuard,
  resetKanbanHorizontalScroll,
} from "./utils/scrollGuard";

interface TaskKanbanProps {
  /**
   * Restrict the board to a subset of session IDs. When set, routines are
   * also hidden (they're a global concern). Used by org-scoped embeds.
   */
  sessionIdFilter?: ReadonlySet<string>;
  /**
   * Hide the "New Session" button in the published Kanban header. Embedders
   * that own their own composer (e.g. the Inbox `OrgChatPanel`) do not want a
   * duplicate trigger here.
   */
  hideAddSessionButton?: boolean;
  /**
   * Suppress publishing Kanban controls into the Workstation 40px header.
   * Embeds that render their own header — e.g. the Inbox `OrgChatPanel`
   * merges the time-filter pills into its own sub-tab row — pass `true`.
   * When hidden, callers must supply `timeFilter` + `onTimeFilterChange`
   * if they still need user-controlled time filtering.
   */
  hideHeader?: boolean;
  /**
   * Controlled time filter. If `onTimeFilterChange` is also provided,
   * the component is fully controlled (caller owns the state). If only
   * `timeFilter` is provided, it's used as the initial value.
   */
  timeFilter?: KanbanTimeFilter;
  onTimeFilterChange?: (filter: KanbanTimeFilter) => void;
  /** Follow the organization selected in the Workstation sidebar. */
  followSidebarOrgScope?: boolean;
}

const Kanban: React.FC<TaskKanbanProps> = ({
  sessionIdFilter,
  hideAddSessionButton = false,
  hideHeader = false,
  timeFilter: controlledTimeFilter,
  onTimeFilterChange,
  followSidebarOrgScope = true,
}) => {
  const { t } = useTranslation("sessions");
  const { t: tCommon } = useTranslation("common");
  const location = useLocation();
  const containerRef = useRef<HTMLDivElement>(null);

  const [selectedTaskId, setSelectedTaskId] = useAtom(kanbanSelectedTaskIdAtom);
  const [detailPanelVisible, setDetailPanelVisible] = useAtom(
    kanbanDetailPanelVisibleAtom
  );
  const [internalTimeFilter, setInternalTimeFilter] =
    useAtom(kanbanTimeFilterAtom);
  const sidebarFilter = useAtomValue(kanbanSidebarFilterAtom);
  const agentTypeFilter = useAtomValue(kanbanAgentTypeFilterAtom);
  const searchQuery = useAtomValue(kanbanSearchQueryAtom);
  const [autoArchiveTtl, setAutoArchiveTtl] = useAtom(kanbanAutoArchiveTtlAtom);
  const setManualArchivedSessionIds = useSetAtom(
    kanbanManualArchivedSessionIdsAtom
  );
  const [creatorVisible, setCreatorVisible] = useAtom(
    workManagementCreatorVisibleAtom
  );
  const toggleCreatorVisible = useSetAtom(
    toggleWorkManagementCreatorVisibleAtom
  );
  const [cloudPreviewTarget, setCloudPreviewTarget] = useAtom(
    kanbanCloudPreviewTargetAtom
  );
  const selectedOrgId = useAtomValue(sidebarSelectedOrgIdAtom);
  const previousSelectedOrgIdRef = useRef(selectedOrgId);

  const isControlled = onTimeFilterChange !== undefined;
  const timeFilter = isControlled
    ? (controlledTimeFilter ?? DEFAULT_KANBAN_TIME_FILTER)
    : internalTimeFilter;
  const setTimeFilter = useCallback(
    (next: KanbanTimeFilter) => {
      if (isControlled) {
        onTimeFilterChange(next);
      } else {
        setInternalTimeFilter(next);
      }
    },
    [isControlled, onTimeFilterChange, setInternalTimeFilter]
  );

  const viewMode = parseFactoryViewMode(location.search);
  const searchEnabled =
    !hideHeader && (viewMode === "kanban" || viewMode === "list");
  const effectiveSearchQuery = searchEnabled ? searchQuery : "";
  const [calendarDate, setCalendarDate] = useState<Date>(() => new Date());
  const taskRenderWindowKey = [
    followSidebarOrgScope ? (selectedOrgId ?? "personal") : "unscoped",
    timeFilter,
    autoArchiveTtl,
    sidebarFilter,
    agentTypeFilter,
    effectiveSearchQuery,
  ].join(":");

  useEffect(() => {
    void loadSessionRoster();
  }, []);

  const { tasks, allTasks, cloudOrgId, remoteSessionsByTaskId } =
    useKanbanTasks({
      timeFilter,
      autoArchiveTtl,
      sessionIdFilter,
      followSidebarOrgScope,
    });
  const {
    replaySession: openRemoteSession,
    forkSession,
    busySessionRows,
  } = useCloudSessionActions(cloudOrgId);

  const renderListRowAction = useCallback(
    (task: KanbanTask): React.ReactNode => {
      const remoteSession = remoteSessionsByTaskId.get(task.id);
      if (!remoteSession || remoteSession.eventsEpoch === undefined) {
        return undefined;
      }
      return (
        <Button
          htmlType="button"
          size="small"
          variant="secondary"
          disabled={busySessionRows.has(remoteSession.id)}
          loading={busySessionRows.has(remoteSession.id)}
          data-testid={`kanban-list-session-take-over-${remoteSession.sourceSessionId}`}
          onClick={() => void forkSession(remoteSession)}
        >
          {tCommon("workstation.takeOver")}
        </Button>
      );
    },
    [busySessionRows, forkSession, remoteSessionsByTaskId, tCommon]
  );

  const { visibleTasks, visibleDiaryTasks, visibleColumns, selectedTask } =
    useTaskKanbanFilters({
      tasks,
      diaryTasks: allTasks,
      sidebarFilter,
      agentTypeFilter,
      selectedTaskId,
      searchQuery: effectiveSearchQuery,
    });

  const handlePointerDownCapture = useCallback((event: React.PointerEvent) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (
      target.closest(".kanban-task-card") ||
      target.closest(".kanban-session-preview-overlay")
    ) {
      beginKanbanHorizontalScrollGuard();
    }
  }, []);

  const openTaskPreview = useCallback(
    (taskId: string) => {
      setSelectedTaskId(taskId);
      setDetailPanelVisible(true);
      setCreatorVisible(false);
      beginKanbanHorizontalScrollGuard();
    },
    [setCreatorVisible, setDetailPanelVisible, setSelectedTaskId]
  );

  const handleTaskClick = useCallback(
    (task: KanbanTask) => {
      const remoteSession = remoteSessionsByTaskId.get(task.id);
      if (remoteSession) {
        if (task.canOpen === false) return;
        // Team sessions open in the board's own preview window. Handing
        // them to a Chat Pane tab instead unmounts Work Management — and the
        // import's abort controller with it — so the import this click just
        // started would be cancelled and the new tab would stay empty.
        void openRemoteSession(remoteSession, {
          openSurface: ({ localSessionId }) => {
            setCloudPreviewTarget({
              taskId: task.id,
              sessionId: localSessionId,
            });
            openTaskPreview(task.id);
          },
        });
        return;
      }
      setCloudPreviewTarget(null);
      openTaskPreview(task.id);
    },
    [
      openTaskPreview,
      remoteSessionsByTaskId,
      openRemoteSession,
      setCloudPreviewTarget,
    ]
  );

  // Secondary click offers the same target in either surface: the board's
  // floating preview (what the primary click does) or its own Chat Pane tab.
  const handleTaskContextMenu = useKanbanCardContextMenu({
    onOpenFloatingPane: handleTaskClick,
    remoteSessionsByTaskId,
  });

  const handleCloseDetailPanel = useCallback(() => {
    setDetailPanelVisible(false);
    setSelectedTaskId(null);
    setCloudPreviewTarget(null);
    resetKanbanHorizontalScroll();
  }, [setCloudPreviewTarget, setDetailPanelVisible, setSelectedTaskId]);

  const detailTask = useMemo(
    () => resolveKanbanPreviewTask(selectedTask, cloudPreviewTarget, allTasks),
    [allTasks, cloudPreviewTarget, selectedTask]
  );

  useEffect(() => {
    const previousOrgId = previousSelectedOrgIdRef.current;
    previousSelectedOrgIdRef.current = selectedOrgId;
    if (!followSidebarOrgScope || previousOrgId === selectedOrgId) return;
    handleCloseDetailPanel();
  }, [followSidebarOrgScope, handleCloseDetailPanel, selectedOrgId]);

  const handleNavigateTask = useCallback(
    (direction: "prev" | "next") => {
      if (!selectedTaskId) return;
      const currentIndex = visibleTasks.findIndex(
        (task) => task.id === selectedTaskId
      );
      if (currentIndex === -1) return;

      const newIndex =
        direction === "prev" ? currentIndex - 1 : currentIndex + 1;
      if (newIndex >= 0 && newIndex < visibleTasks.length) {
        setSelectedTaskId(visibleTasks[newIndex].id);
        resetKanbanHorizontalScroll();
      }
    },
    [selectedTaskId, visibleTasks, setSelectedTaskId]
  );

  const taskNavigation = useMemo(() => {
    if (!selectedTaskId) return { hasPrev: false, hasNext: false };
    const currentIndex = visibleTasks.findIndex(
      (task) => task.id === selectedTaskId
    );
    return {
      hasPrev: currentIndex > 0,
      hasNext: currentIndex < visibleTasks.length - 1,
    };
  }, [selectedTaskId, visibleTasks]);

  const handleAddTask = useCallback(() => {
    toggleCreatorVisible();
  }, [toggleCreatorVisible]);

  React.useLayoutEffect(() => {
    resetKanbanHorizontalScroll();
  }, [detailPanelVisible, selectedTaskId]);

  const handleTaskMove = useCallback(
    (taskId: string, newStatus: TaskStatus) => {
      if (remoteSessionsByTaskId.has(taskId)) return;
      const targetStatus = newStatus as AgentKanbanColumnId;
      setManualArchivedSessionIds((previousIds) => {
        const nextIds = previousIds.filter(
          (existingId) => existingId !== taskId
        );
        if (targetStatus === "archived") {
          return [taskId, ...nextIds].slice(0, 1000);
        }
        return nextIds;
      });
      if (selectedTaskId === taskId && targetStatus === "archived") {
        setDetailPanelVisible(false);
        setSelectedTaskId(null);
      }
    },
    [
      selectedTaskId,
      remoteSessionsByTaskId,
      setDetailPanelVisible,
      setManualArchivedSessionIds,
      setSelectedTaskId,
    ]
  );

  useTaskKanbanHeader({
    viewMode,
    calendarDate,
    onCalendarDateChange: setCalendarDate,
    autoArchiveTtl,
    onAutoArchiveTtlChange: setAutoArchiveTtl,
    timeFilter,
    onTimeFilterChange: setTimeFilter,
    tasks: allTasks,
    addTaskLabel: t("chat.newSession"),
    addTaskActive: creatorVisible,
    onAddTask: !hideAddSessionButton ? handleAddTask : undefined,
    hidden: hideHeader,
  });

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 flex flex-col overflow-hidden"
      onPointerDownCapture={handlePointerDownCapture}
    >
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <TaskKanbanContent
          viewMode={viewMode}
          visibleTasks={visibleTasks}
          diaryTasks={visibleDiaryTasks}
          visibleColumns={visibleColumns}
          selectedTaskId={selectedTaskId}
          detailPanelVisible={detailPanelVisible}
          calendarDate={calendarDate}
          onTaskMove={handleTaskMove}
          onTaskClick={handleTaskClick}
          onTaskContextMenu={handleTaskContextMenu}
          onAddTask={handleAddTask}
          renderListRowAction={renderListRowAction}
          hasSearchQuery={effectiveSearchQuery.trim().length > 0}
          taskRenderWindowKey={taskRenderWindowKey}
        />
      </div>

      {detailPanelVisible && (
        <FloatingWindow
          overlayClassName={`${WORK_MANAGEMENT_SESSION_PREVIEW_OVERLAY_CLASS} kanban-session-preview-overlay`}
          surfaceClassName={WORK_MANAGEMENT_SESSION_PREVIEW_SURFACE_CLASS}
        >
          <TaskDetailPanel
            visible={detailPanelVisible}
            task={detailTask}
            onClose={handleCloseDetailPanel}
            onNavigate={handleNavigateTask}
            hasPrev={taskNavigation.hasPrev}
            hasNext={taskNavigation.hasNext}
          />
        </FloatingWindow>
      )}
    </div>
  );
};

export default Kanban;
