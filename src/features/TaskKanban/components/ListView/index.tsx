import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { Placeholder } from "@src/components/Placeholder";
import type { KanbanTask } from "@src/features/KanbanBoard";
import {
  SessionTable,
  type SessionTableColumnKey,
  type SessionTableColumnOverrides,
  type SessionTableItem,
  mapKanbanTaskToSessionTableItem,
} from "@src/modules/shared/layouts/blocks";
import { toIntlLocaleTag } from "@src/util/data/formatters/date";

import { getColumnTitleKey } from "../../config";

const PAGE_SIZE = 25;
const PAGE_SIZE_OPTIONS = [25, 50];

// Stable identity so <SessionTable>'s column memo isn't rebuilt each render.
// Kanban keeps file/line impact but omits git-commit columns, which are covered
// by the Diary view and are not meaningful for every imported/agent session.
const LIST_COLUMN_VISIBILITY: Partial<Record<SessionTableColumnKey, boolean>> =
  {
    relatedCommits: false,
    committedRate: false,
    filesChanged: false,
    tokens: true,
  };

const EMPTY_STAT = "—";

function combineFileAndLineChanges(item: SessionTableItem): SessionTableItem {
  if (item.filesChangedLabel == null && item.impactLabel == null) return item;

  return {
    ...item,
    impactLabel: (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap tabular-nums">
        <span>{item.filesChangedLabel ?? EMPTY_STAT}</span>
        <span aria-hidden="true">·</span>
        <span>{item.impactLabel ?? EMPTY_STAT}</span>
      </span>
    ),
  };
}

function getTaskTimestamp(task: KanbanTask): number {
  const timestamp = task.updated_at || task.created_at;
  if (!timestamp) return 0;
  return new Date(timestamp).getTime();
}

interface ListViewProps {
  tasks: KanbanTask[];
  selectedTaskId: string | null;
  detailPanelVisible: boolean;
  onTaskClick: (task: KanbanTask) => void;
  renderRowAction?: (task: KanbanTask) => React.ReactNode;
}

const ListView: React.FC<ListViewProps> = ({
  tasks,
  selectedTaskId,
  detailPanelVisible,
  onTaskClick,
  renderRowAction,
}) => {
  const { t, i18n } = useTranslation(["sessions", "common", "projects"]);
  const sortedTasks = useMemo(
    () => [...tasks].sort((a, b) => getTaskTimestamp(b) - getTaskTimestamp(a)),
    [tasks]
  );
  const dateTimeLabelOptions = useMemo(
    () => ({
      todayLabel: t("common:relativeDate.today"),
      yesterdayLabel: t("common:relativeDate.yesterday"),
      locale: toIntlLocaleTag(i18n.resolvedLanguage),
    }),
    [i18n.resolvedLanguage, t]
  );
  const sessionTableItems = useMemo(
    () =>
      sortedTasks.map((task) =>
        combineFileAndLineChanges(
          mapKanbanTaskToSessionTableItem({
            task,
            active: task.id === selectedTaskId && detailPanelVisible,
            statusLabel: t(`sessions:${getColumnTitleKey(task.status)}`),
            dateTimeLabelOptions,
            testId: "kanban-list-session-row",
            rowAction: renderRowAction?.(task),
          })
        )
      ),
    [
      dateTimeLabelOptions,
      detailPanelVisible,
      renderRowAction,
      selectedTaskId,
      sortedTasks,
      t,
    ]
  );
  const columnVisibility = useMemo(
    () => ({
      ...LIST_COLUMN_VISIBILITY,
      owner: sortedTasks.some((task) => Boolean(task.createdBy)),
    }),
    [sortedTasks]
  );
  const columnOverrides = useMemo<SessionTableColumnOverrides>(
    () => ({
      impact: {
        label: (
          <>
            {t("common:labels.files")} <span aria-hidden="true">·</span>{" "}
            {t("common:aiImpact.lines")}
          </>
        ),
        width: "190px",
      },
    }),
    [t]
  );

  return (
    <div className="absolute inset-0 flex flex-col overflow-hidden">
      {sortedTasks.length === 0 ? (
        <Placeholder
          variant="empty"
          placement="detail-panel"
          title={t("sessions:kanban.list.emptyTitle")}
          subtitle={t("sessions:kanban.list.emptyDescription")}
        />
      ) : (
        <SessionTable
          items={sessionTableItems}
          className="[&_.table-fixed-header]:scrollbar-hide [&_.table-scroll]:scrollbar-hide"
          columnVisibility={columnVisibility}
          columnOverrides={columnOverrides}
          ownerColumnLabel={t("projects:projects.groupBy.createdBy")}
          onSelect={(item) => {
            const task = sortedTasks.find(
              (candidate) => candidate.id === item.id
            );
            if (task) {
              onTaskClick(task);
            }
          }}
          fillHeight
          showSearch
          // Bound the rendered row count. The List view feeds the shared
          // semantic <table>, which can't be windowed without breaking table
          // layout, so we cap DOM/memory with the table's own pagination —
          // only kicks in past one page, keeping short lists single-page.
          pageSize={PAGE_SIZE}
          pageSizeOptions={PAGE_SIZE_OPTIONS}
        />
      )}
    </div>
  );
};

export default ListView;
