import { useAtomValue } from "jotai";
import React, { memo, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { getColumnTitleKey } from "@src/features/TaskKanban/config";
import { sessionToKanbanTask } from "@src/features/TaskKanban/hooks/useKanbanTasks/sessionToKanbanTask";
import { useSessionView } from "@src/hooks/ui/tabs/useSessionView";
import {
  Placeholder,
  SessionTable,
  mapKanbanTaskToSessionTableItem,
} from "@src/modules/shared/layouts/blocks";
import { type Session, sessionsAtom } from "@src/store/session";
import { toIntlLocaleTag } from "@src/util/data/formatters/date";

interface RecentSessionsPanelViewProps {
  repoPath: string;
  repoName?: string;
}

const EMPTY_SESSION_SET = new Set<string>();

function normalizePath(path: string | undefined): string {
  return (path ?? "").replace(/\/+$|\\+$/g, "").toLowerCase();
}

function getTimestampValue(value: string | undefined): number {
  if (!value) return 0;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function getSessionTitle(session: Session): string {
  return session.name ?? session.user_input ?? session.session_id;
}

const RecentSessionsPanelView: React.FC<RecentSessionsPanelViewProps> = memo(
  ({ repoPath, repoName }) => {
    const { t, i18n } = useTranslation(["sessions", "common"]);
    const sessions = useAtomValue(sessionsAtom);
    const { activeSessionId, openSession } = useSessionView();

    const normalizedRepoPath = useMemo(
      () => normalizePath(repoPath),
      [repoPath]
    );
    const dateTimeLabelOptions = useMemo(
      () => ({
        todayLabel: t("common:relativeDate.today"),
        yesterdayLabel: t("common:relativeDate.yesterday"),
        locale: toIntlLocaleTag(i18n.resolvedLanguage),
      }),
      [i18n.resolvedLanguage, t]
    );
    const recentSessions = useMemo(
      () =>
        sessions
          .filter((session) => {
            const sessionRepoPath = normalizePath(session.repoPath);
            const worktreePath = normalizePath(session.worktreePath);
            return (
              sessionRepoPath === normalizedRepoPath ||
              worktreePath === normalizedRepoPath
            );
          })
          .sort(
            (left, right) =>
              getTimestampValue(right.updated_at ?? right.updated_time) -
              getTimestampValue(left.updated_at ?? left.updated_time)
          )
          .slice(0, 25),
      [normalizedRepoPath, sessions]
    );

    const tableItems = useMemo(
      () =>
        recentSessions.map((session) => {
          const task = sessionToKanbanTask(
            session,
            EMPTY_SESSION_SET,
            EMPTY_SESSION_SET,
            "never",
            0
          );

          return mapKanbanTaskToSessionTableItem({
            task,
            statusLabel: t(`sessions:${getColumnTitleKey(task.status)}`),
            dateTimeLabelOptions,
            active: session.session_id === activeSessionId,
            testId: `workspace-recent-session-${session.session_id}`,
          });
        }),
      [activeSessionId, dateTimeLabelOptions, recentSessions, t]
    );

    const handleSelectSession = useCallback(
      (item: { id: string }) => {
        const session = recentSessions.find(
          (candidate) => candidate.session_id === item.id
        );
        if (!session) return;
        openSession(
          session.session_id,
          getSessionTitle(session),
          session.repoPath
        );
      },
      [openSession, recentSessions]
    );

    if (recentSessions.length === 0) {
      return (
        <Placeholder
          variant="empty"
          placement="detail-panel"
          title={t("sessions:kanban.list.emptyTitle")}
          subtitle={
            repoName ? t("sessions:kanban.list.emptyDescription") : undefined
          }
        />
      );
    }

    return (
      <SessionTable
        items={tableItems}
        onSelect={handleSelectSession}
        surfaceVariant="chatPanel"
        showSearch
        maxHeight={520}
        pageSize={10}
        pageSizeOptions={[10, 25, 50]}
      />
    );
  }
);

RecentSessionsPanelView.displayName = "RecentSessionsPanelView";

export default RecentSessionsPanelView;
