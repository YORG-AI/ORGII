import { Clock, GitBranch, History, MessageSquare, Zap } from "lucide-react";
import React, { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";

import {
  getOrgtrackClaudeCodeSessions,
  getOrgtrackCliSessions,
} from "@src/api/tauri/orgtrackHistory";
import type {
  ClaudeCodeSession,
  CliSession,
} from "@src/api/tauri/orgtrackHistory/types";
import { CLI_TOOL_LABELS } from "@src/api/tauri/orgtrackHistory/types";
import { CLI_AGENT } from "@src/api/tauri/rpc/schemas/validation";
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
  formatTokenCount,
} from "../CodingProfileView/config";
import { useSessionAutoRefresh } from "../CodingProfileView/useSessionAutoRefresh";

// ============================================
// Unified row type — merges Claude Code + other CLI tools
// ============================================

export interface UnifiedCliRow {
  id: string;
  tool: string;
  toolLabel: string;
  name: string;
  createdAt: number;
  lastActiveAt: number;
  messageCount: number;
  model: string;
  workspacePath: string;
  gitBranch: string;
  inputTokens: number;
  outputTokens: number;
}

function claudeToRow(session: ClaudeCodeSession): UnifiedCliRow {
  return {
    id: `claude:${session.id}`,
    tool: CLI_AGENT.CLAUDE_CODE,
    toolLabel: "Claude Code",
    name: session.name,
    createdAt: session.createdAt,
    lastActiveAt: session.lastActiveAt,
    messageCount: session.messageCount,
    model: session.model,
    workspacePath: session.workspacePath,
    gitBranch: session.gitBranch,
    inputTokens: session.inputTokens,
    outputTokens: session.outputTokens,
  };
}

function cliToRow(session: CliSession): UnifiedCliRow {
  return {
    id: session.id,
    tool: session.tool,
    toolLabel: CLI_TOOL_LABELS[session.tool] ?? session.tool,
    name: session.name,
    createdAt: session.createdAt,
    lastActiveAt: session.lastActiveAt,
    messageCount: session.messageCount,
    model: session.model,
    workspacePath: session.workspacePath,
    gitBranch: "",
    inputTokens: session.inputTokens,
    outputTokens: session.outputTokens,
  };
}

function sessionDurationSeconds(row: UnifiedCliRow): number {
  if (row.lastActiveAt <= row.createdAt) return 0;
  return Math.round((row.lastActiveAt - row.createdAt) / 1000);
}

// ============================================
// Tool -> ModelIcon agent type mapping
// ============================================

const TOOL_AGENT_TYPE: Record<string, string> = {
  [CLI_AGENT.CLAUDE_CODE]: CLI_AGENT.CLAUDE_CODE,
  [CLI_AGENT.CODEX]: CLI_AGENT.CODEX,
  [CLI_AGENT.GEMINI]: CLI_AGENT.GEMINI,
  [CLI_AGENT.KIRO]: CLI_AGENT.KIRO,
  aider: "aider", // not in CliAgentTypeSchema
  [CLI_AGENT.CURSOR]: CLI_AGENT.CURSOR,
};

// ============================================
// Component
// ============================================

interface CliSessionsPanelProps {
  startDate: string;
  endDate: string;
  refreshKey?: number;
}

const CliSessionsPanel: React.FC<CliSessionsPanelProps> = memo(
  ({ startDate, endDate, refreshKey }) => {
    const { t } = useTranslation();

    const fetcher = useMemo(
      () => async (): Promise<UnifiedCliRow[]> => {
        const [claudeSessions, cliSessions] = await Promise.all([
          getOrgtrackClaudeCodeSessions(startDate, endDate).catch(
            () => [] as ClaudeCodeSession[]
          ),
          getOrgtrackCliSessions(startDate, endDate).catch(
            () => [] as CliSession[]
          ),
        ]);
        const claudeRows = claudeSessions.map(claudeToRow);
        const cliRows = cliSessions.map(cliToRow);
        return [...claudeRows, ...cliRows].sort(
          (rowA, rowB) => rowB.createdAt - rowA.createdAt
        );
      },
      [startDate, endDate]
    );

    const { data, error, isInitialLoad } = useSessionAutoRefresh<
      UnifiedCliRow[]
    >({
      fetcher,
      countFromData: (rows) => rows.length,
      label: t("devActivity.cliSessions"),
      formatSuccess: (label, count) => ({
        title: t("devActivity.refreshSuccess", { count, label }),
        description: t("devActivity.refreshSuccessDescription"),
      }),
      formatError: (label) => ({
        title: t("devActivity.refreshError", { label }),
        description: t("devActivity.refreshErrorDescription"),
      }),
      cacheKey: `cli-all:${startDate}:${endDate}`,
      refreshKey,
    });

    const sessions = useMemo(() => data ?? [], [data]);
    const loading = isInitialLoad;

    const stats = useMemo(() => {
      const totalInput = sessions.reduce(
        (acc, row) => acc + row.inputTokens,
        0
      );
      const totalOutput = sessions.reduce(
        (acc, row) => acc + row.outputTokens,
        0
      );
      const durations = sessions.map(sessionDurationSeconds);
      const sessionsWithDuration = durations.filter((dur) => dur > 0);
      const avgDurationSeconds =
        sessionsWithDuration.length > 0
          ? Math.round(
              sessionsWithDuration.reduce((acc, dur) => acc + dur, 0) /
                sessionsWithDuration.length
            )
          : 0;

      const toolCounts = new Map<string, number>();
      for (const row of sessions) {
        toolCounts.set(row.tool, (toolCounts.get(row.tool) ?? 0) + 1);
      }

      return { totalInput, totalOutput, avgDurationSeconds, toolCounts };
    }, [sessions]);

    const columns = useMemo<SettingsTableColumn<UnifiedCliRow>[]>(
      () => [
        {
          key: "time",
          label: t("devActivity.cursorTime"),
          width: SETTINGS_TABLE_COL.valueMd,
          sorter: (rowA, rowB) => rowB.createdAt - rowA.createdAt,
          renderCell: (row) => (
            <span
              className={`${SETTINGS_TABLE_CELL.value} whitespace-nowrap tabular-nums`}
            >
              {new Date(row.createdAt).toLocaleDateString([], {
                month: "numeric",
                day: "numeric",
              })}{" "}
              {new Date(row.createdAt).toLocaleTimeString([], {
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
          renderCell: (row) => {
            const dur = sessionDurationSeconds(row);
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
          label: t("devActivity.cliPrompt"),
          width: SETTINGS_TABLE_COL.fill,
          renderCell: (row) => (
            <div
              className={`${SETTINGS_TABLE_CELL.primary} truncate`}
              title={row.name}
            >
              {row.name || "—"}
            </div>
          ),
        },
        {
          key: "tool",
          label: t("devActivity.cliTool"),
          width: "110px",
          renderCell: (row) => (
            <span
              className={`${SETTINGS_TABLE_CELL.statusRow} whitespace-nowrap`}
            >
              <ModelIcon
                agentType={TOOL_AGENT_TYPE[row.tool] ?? row.tool}
                size="small"
              />
              <span className={SETTINGS_TABLE_CELL.muted}>{row.toolLabel}</span>
            </span>
          ),
        },
        {
          key: "model",
          label: t("devActivity.cursorTopModel"),
          width: "130px",
          renderCell: (row) => (
            <span
              className={`${SETTINGS_TABLE_CELL.statusRow} whitespace-nowrap`}
              title={row.model}
            >
              <ModelIcon modelName={row.model} size="small" />
              <span className={SETTINGS_TABLE_CELL.muted}>
                {formatModelNameFull(row.model) || "—"}
              </span>
            </span>
          ),
        },
        {
          key: "messages",
          label: t("devActivity.cliMessages"),
          width: "70px",
          align: "right",
          sorter: (rowA, rowB) => rowA.messageCount - rowB.messageCount,
          renderCell: (row) =>
            row.messageCount > 0 ? (
              <span className={`${SETTINGS_TABLE_CELL.value} tabular-nums`}>
                {row.messageCount}
              </span>
            ) : (
              <span className={SETTINGS_TABLE_CELL.muted}>—</span>
            ),
        },
        {
          key: "tokens",
          label: t("devActivity.cliTokens"),
          width: SETTINGS_TABLE_COL.valueMd,
          align: "right",
          sorter: (rowA, rowB) =>
            rowA.inputTokens +
            rowA.outputTokens -
            (rowB.inputTokens + rowB.outputTokens),
          renderCell: (row) => {
            const total = row.inputTokens + row.outputTokens;
            return total > 0 ? (
              <span
                className={`${SETTINGS_TABLE_CELL.value} whitespace-nowrap tabular-nums`}
              >
                {formatTokenCount(total)}
              </span>
            ) : (
              <span className={SETTINGS_TABLE_CELL.muted}>—</span>
            );
          },
        },
        {
          key: "workspace",
          label: t("devActivity.cliWorkspace"),
          width: "120px",
          renderCell: (row) => {
            const workspaceName = row.workspacePath
              ? row.workspacePath.split("/").pop() || row.workspacePath
              : "";
            return workspaceName ? (
              <span
                className={`${SETTINGS_TABLE_CELL.muted} flex items-center gap-1 truncate`}
                title={row.workspacePath}
              >
                {row.gitBranch && <GitBranch size={11} className="shrink-0" />}
                {workspaceName}
              </span>
            ) : (
              <span className={SETTINGS_TABLE_CELL.muted}>—</span>
            );
          },
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

    const hasData = sessions.length > 0;

    return (
      <CollapsibleSection title={t("devActivity.cliSessions")}>
        <div className={`mb-4 ${STAT_GRID_TOKENS.cols3}`}>
          <StatCard icon={History} label={t("devActivity.sessions")}>
            {hasData ? (
              <span className="flex items-center gap-2 tabular-nums">
                {sessions.length.toLocaleString()}
                {stats.toolCounts.size > 1 && (
                  <span className="text-[10px] text-text-2">
                    (
                    {Array.from(stats.toolCounts.entries())
                      .map(([tool, count]) => {
                        const toolLabel =
                          tool === CLI_AGENT.CLAUDE_CODE
                            ? "Claude"
                            : (CLI_TOOL_LABELS[
                                tool as keyof typeof CLI_TOOL_LABELS
                              ] ?? tool);
                        return `${count} ${toolLabel}`;
                      })
                      .join(", ")}
                    )
                  </span>
                )}
              </span>
            ) : (
              t("common:status.unknown")
            )}
          </StatCard>
          <StatCard icon={Zap} label={t("devActivity.cliTotalTokens")}>
            {hasData ? (
              <span className="flex items-center gap-1.5 tabular-nums">
                <MessageSquare size={11} className="text-text-2" />
                {formatTokenCount(stats.totalInput + stats.totalOutput)}
              </span>
            ) : (
              t("common:status.unknown")
            )}
          </StatCard>
          <StatCard icon={Clock} label={t("devActivity.cursorAvgDuration")}>
            {hasData && stats.avgDurationSeconds > 0
              ? formatDuration(stats.avgDurationSeconds)
              : t("common:status.unknown")}
          </StatCard>
        </div>
        <div className="rounded-lg bg-fill-2 px-4">
          {hasData ? (
            <SettingsTable<UnifiedCliRow>
              columns={columns}
              rows={sessions}
              getRowKey={(row) => row.id}
              headerHeight="tall"
              pageSize={50}
              maxHeight="min(420px, calc(100vh - 280px))"
              className="table-layout-fixed"
            />
          ) : (
            <div className="py-6">
              <Placeholder
                variant="empty"
                title={t("devActivity.noCliSessions")}
              />
            </div>
          )}
        </div>
      </CollapsibleSection>
    );
  }
);

CliSessionsPanel.displayName = "CliSessionsPanel";

export default CliSessionsPanel;
