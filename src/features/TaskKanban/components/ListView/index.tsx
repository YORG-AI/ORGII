import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { KanbanTask } from "@src/features/KanbanBoard";
import {
  Placeholder,
  SessionTable,
  type SessionTableColumnKey,
  mapKanbanTaskToSessionTableItem,
} from "@src/modules/shared/layouts/blocks";
import { toIntlLocaleTag } from "@src/util/data/formatters/date";

import { getColumnTitleKey } from "../../config";

const PAGE_SIZE = 50;
const PAGE_SIZE_OPTIONS = [50, 100, 200];

// Stable identity so <SessionTable>'s column memo isn't rebuilt each render.
// The list drops the git-commit "Committed" ratio because it is not meaningful
// for read-only imported/agent sessions.
const LIST_COLUMN_VISIBILITY: Partial<Record<SessionTableColumnKey, boolean>> =
  {
    committedRate: false,
    tokens: true,
  };

function getTaskTimestamp(task: KanbanTask): number {
  const timestamp = task.updated_at || task.created_at;
  if (!timestamp) return 0;
  return new Date(timestamp).getTime();
}

export interface ListViewProps {
  tasks: KanbanTask[];
  selectedTaskId: string | null;
  detailPanelVisible: boolean;
  onTaskClick: (task: KanbanTask) => void;
}

const ListView: React.FC<ListViewProps> = ({
  tasks,
  selectedTaskId,
  detailPanelVisible,
  onTaskClick,
}) => {
  const { t, i18n } = useTranslation(["sessions", "common"]);
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
        mapKanbanTaskToSessionTableItem({
          task,
          active: task.id === selectedTaskId && detailPanelVisible,
          statusLabel: t(`sessions:${getColumnTitleKey(task.status)}`),
          dateTimeLabelOptions,
        })
      ),
    [dateTimeLabelOptions, detailPanelVisible, selectedTaskId, sortedTasks, t]
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
          columnVisibility={LIST_COLUMN_VISIBILITY}
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
