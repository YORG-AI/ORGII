import React, { Suspense, lazy } from "react";
import { useTranslation } from "react-i18next";

import KanbanBoard from "@src/features/KanbanBoard";
import type {
  KanbanColumnConfig,
  KanbanTask,
  TaskStatus,
} from "@src/features/KanbanBoard";

import type { FactoryViewMode } from "../FactoryViewPill";

// The three secondary views are code-split and only fetched the first time
// the user switches to them. Because the `switch` below renders exactly one
// branch, navigating away also unmounts (offloads) the previous view — its
// DOM, virtualizers, and any in-flight data effects are torn down. Kanban is
// the default view, so it stays eagerly imported to avoid a first-paint flash.
const DataSourcePanel = lazy(() => import("@src/modules/shared/dataSource"));
const DiaryView = lazy(() => import("../DiaryView"));
const ListView = lazy(() => import("../ListView"));

export interface TaskKanbanContentProps {
  viewMode: FactoryViewMode;
  visibleTasks: KanbanTask[];
  diaryTasks: KanbanTask[];
  visibleColumns: readonly unknown[];
  selectedTaskId: string | null;
  detailPanelVisible: boolean;
  calendarDate: Date;
  onTaskMove: (taskId: string, newStatus: TaskStatus) => void;
  onTaskClick: (task: KanbanTask) => void;
  onAddTask: () => void;
  renderListRowAction?: (task: KanbanTask) => React.ReactNode;
  hasFileSearchQuery: boolean;
  taskRenderWindowKey: string;
}

const TaskKanbanContent: React.FC<TaskKanbanContentProps> = ({
  viewMode,
  visibleTasks,
  diaryTasks,
  visibleColumns,
  selectedTaskId,
  detailPanelVisible,
  calendarDate,
  onTaskMove,
  onTaskClick,
  onAddTask,
  renderListRowAction,
  hasFileSearchQuery,
  taskRenderWindowKey,
}) => {
  const { t } = useTranslation("sessions");
  if (
    hasFileSearchQuery &&
    visibleTasks.length === 0 &&
    (viewMode === "kanban" || viewMode === "list")
  ) {
    return (
      <div
        className="absolute inset-0 flex items-center justify-center px-6 text-center text-[13px] text-text-3"
        data-testid="kanban-file-search-empty"
      >
        {t("kanban.fileSearch.noResults")}
      </div>
    );
  }

  // Kanban is eager (default view); the lazy branches need a Suspense
  // boundary while their chunk loads. The fallback is an empty full-bleed
  // surface so the layout doesn't jump during the brief fetch.
  switch (viewMode) {
    case "datasource":
      return (
        <Suspense fallback={<ViewFallback />}>
          <DataSourcePanel />
        </Suspense>
      );
    case "diary":
      return (
        <Suspense fallback={<ViewFallback />}>
          <DiaryView
            tasks={diaryTasks}
            date={calendarDate}
            onTaskClick={onTaskClick}
          />
        </Suspense>
      );
    case "list":
      return (
        <Suspense fallback={<ViewFallback />}>
          <ListView
            tasks={visibleTasks}
            selectedTaskId={selectedTaskId}
            detailPanelVisible={detailPanelVisible}
            onTaskClick={onTaskClick}
            renderRowAction={renderListRowAction}
          />
        </Suspense>
      );
    case "kanban":
    default:
      return (
        <KanbanBoard
          tasks={visibleTasks}
          columns={visibleColumns as unknown as KanbanColumnConfig[]}
          onTaskMove={onTaskMove}
          onTaskClick={onTaskClick}
          onAddTask={onAddTask}
          allowColumnReorder={false}
          allowTaskDrag
          showAddButton={false}
          selectedTaskId={detailPanelVisible ? selectedTaskId : null}
          taskRenderWindowKey={taskRenderWindowKey}
          className="kanban-board--linear"
        />
      );
  }
};

const ViewFallback: React.FC = () => (
  <div className="absolute inset-0" aria-hidden="true" />
);

export default TaskKanbanContent;
