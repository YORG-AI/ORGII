import { CheckCircle2, Clock, History, XCircle } from "lucide-react";
import React, { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { getOrgtrackCursorSessions } from "@src/api/tauri/orgtrackHistory";
import type { CursorSession } from "@src/api/tauri/orgtrackHistory/types";
import ModelIcon from "@src/components/ModelIcon";
import SettingsTable, {
  SETTINGS_TABLE_CELL,
  SETTINGS_TABLE_COL,
  type SettingsTableColumn,
} from "@src/components/SettingsTable";
import {
  CollapsibleSection,
  Placeholder,
  STAT_GRID_TOKENS,
} from "@src/modules/shared/layouts/blocks";

import StatCard from "../../components/StatCard";
import {
  formatDuration,
  formatModelNameFull,
} from "../CodingProfileView/config";
import { useSessionAutoRefresh } from "../CodingProfileView/useSessionAutoRefresh";

function sessionDurationSeconds(session: CursorSession): number {
  if (session.lastActiveAt <= session.createdAt) return 0;
  return Math.round((session.lastActiveAt - session.createdAt) / 1000);
}

interface CursorSessionsPanelProps {
  startDate: string;
  endDate: string;
  refreshKey?: number;
}

const CursorSessionsPanel: React.FC<CursorSessionsPanelProps> = memo(
  ({ startDate, endDate, refreshKey }) => {
    const { t } = useTranslation();

    const fetcher = useMemo(
      () => () => getOrgtrackCursorSessions(startDate, endDate),
      [startDate, endDate]
    );

    const { data, error, isInitialLoad } = useSessionAutoRefresh<
      CursorSession[]
    >({
      fetcher,
      countFromData: (sessions) => sessions.length,
      label: t("devActivity.cursorSessions"),
      formatSuccess: (label, count) => ({
        title: t("devActivity.refreshSuccess", { count, label }),
        description: t("devActivity.refreshSuccessDescription"),
      }),
      formatError: (label) => ({
        title: t("devActivity.refreshError", { label }),
        description: t("devActivity.refreshErrorDescription"),
      }),
      cacheKey: `cursor:${startDate}:${endDate}`,
      refreshKey,
    });

    const cursorSessions = useMemo(() => data ?? [], [data]);
    const loading = isInitialLoad;

    const cursorStats = useMemo(() => {
      const durations = cursorSessions.map(sessionDurationSeconds);
      const sessionsWithDuration = durations.filter((dur) => dur > 0);
      const avgDurationSeconds =
        sessionsWithDuration.length > 0
          ? Math.round(
              sessionsWithDuration.reduce((acc, dur) => acc + dur, 0) /
                sessionsWithDuration.length
            )
          : 0;

      return {
        avgDurationSeconds,
      };
    }, [cursorSessions]);

    const columns = useMemo<SettingsTableColumn<CursorSession>[]>(
      () => [
        {
          key: "time",
          label: t("devActivity.cursorTime"),
          width: SETTINGS_TABLE_COL.valueMd,
          sorter: (rowA, rowB) => rowB.createdAt - rowA.createdAt,
          renderCell: (session) => (
            <span
              className={`${SETTINGS_TABLE_CELL.value} whitespace-nowrap tabular-nums`}
            >
              {new Date(session.createdAt).toLocaleDateString([], {
                month: "numeric",
                day: "numeric",
              })}{" "}
              {new Date(session.createdAt).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
                hour12: false,
              })}
            </span>
          ),
        },
        {
          key: "duration",
          label: t("devActivity.cursorDuration"),
          width: "80px",
          sorter: (rowA, rowB) =>
            sessionDurationSeconds(rowA) - sessionDurationSeconds(rowB),
          renderCell: (session) => {
            const dur = sessionDurationSeconds(session);
            return (
              <span
                className={`${SETTINGS_TABLE_CELL.muted} whitespace-nowrap tabular-nums`}
              >
                {dur > 0 ? formatDuration(dur) : "—"}
              </span>
            );
          },
        },
        {
          key: "name",
          label: t("devActivity.cursorName"),
          width: SETTINGS_TABLE_COL.fill,
          renderCell: (session) => (
            <span
              className="flex min-w-0 items-center gap-1.5"
              title={session.name}
            >
              {session.status === "completed" ? (
                <CheckCircle2 size={12} className="shrink-0 text-green-500" />
              ) : (
                <XCircle size={12} className="shrink-0 text-red-400" />
              )}
              <span className={`${SETTINGS_TABLE_CELL.primary} truncate`}>
                {session.name || "—"}
              </span>
            </span>
          ),
        },
        {
          key: "model",
          label: t("devActivity.cursorTopModel"),
          width: SETTINGS_TABLE_COL.hug,
          renderCell: (session) => (
            <span
              className={`${SETTINGS_TABLE_CELL.statusRow} whitespace-nowrap`}
              title={session.model}
            >
              <ModelIcon modelName={session.model} size="small" />
              <span className="text-text-1">
                {formatModelNameFull(session.model) || "—"}
              </span>
            </span>
          ),
        },
      ],
      [t]
    );

    if (loading)
      return (
        <div className="rounded-lg bg-fill-2 p-6">
          <Placeholder variant="loading" />
        </div>
      );
    if (error)
      return (
        <div className="rounded-lg bg-fill-2 p-6">
          <Placeholder variant="error" title={error} />
        </div>
      );

    const hasData = cursorSessions.length > 0;

    return (
      <CollapsibleSection title={t("devActivity.cursorSessions")}>
        <div className={`mb-4 ${STAT_GRID_TOKENS.cols3}`}>
          <StatCard icon={History} label={t("devActivity.sessions")}>
            {hasData
              ? cursorSessions.length.toLocaleString()
              : t("common:status.unknown")}
          </StatCard>
          <StatCard icon={Clock} label={t("devActivity.cursorAvgDuration")}>
            {hasData && cursorStats.avgDurationSeconds > 0
              ? formatDuration(cursorStats.avgDurationSeconds)
              : t("common:status.unknown")}
          </StatCard>
        </div>
        <div className="rounded-lg bg-fill-2 px-4">
          {hasData ? (
            <SettingsTable<CursorSession>
              columns={columns}
              rows={cursorSessions}
              getRowKey={(session) => session.id}
              headerHeight="tall"
              pageSize={50}
              maxHeight="min(420px, calc(100vh - 280px))"
            />
          ) : (
            <div className="py-6">
              <Placeholder
                variant="empty"
                title={t("devActivity.noCursorSessions")}
              />
            </div>
          )}
        </div>
      </CollapsibleSection>
    );
  }
);

CursorSessionsPanel.displayName = "CursorSessionsPanel";

export default CursorSessionsPanel;
