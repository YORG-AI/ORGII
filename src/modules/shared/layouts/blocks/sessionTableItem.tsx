import React from "react";

import DiffStatsBadge from "@src/components/DiffStatsBadge";
import ModelIcon from "@src/components/ModelIcon";
import type { KanbanTask } from "@src/features/KanbanBoard";
import { KANBAN_RESULT_STATUS } from "@src/features/KanbanBoard/types";
import { formatSmartDateTime } from "@src/util/data/formatters/date";
import { formatModelNameFull } from "@src/util/formatModelName";
import { resolveSessionRowIcon } from "@src/util/session/sessionSidebarRow";

import type { SessionTableItem } from "./SessionTable";

export interface SessionTableDateTimeLabelOptions {
  todayLabel?: string;
  yesterdayLabel?: string;
  locale?: string;
}

interface MapKanbanTaskToSessionTableItemInput {
  task: KanbanTask;
  statusLabel: React.ReactNode;
  dateTimeLabelOptions?: SessionTableDateTimeLabelOptions;
  active?: boolean;
  testId?: string;
}

const WORKSPACE_LABEL_MAX_LENGTH = 15;

const compactNumberFormatter = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});

function formatTokenCount(total: number | undefined): string | undefined {
  if (!total || total <= 0) return undefined;
  return compactNumberFormatter.format(total);
}

function truncateWorkspaceLabel(label: string | undefined): string | undefined {
  if (!label || label.length <= WORKSPACE_LABEL_MAX_LENGTH) return label;
  return `${label.slice(0, WORKSPACE_LABEL_MAX_LENGTH)}...`;
}

function renderAgentIcon(task: KanbanTask): React.ReactNode {
  // Match the sidebar: a monochrome, text-colored Lucide-style glyph (via the
  // shared resolver) rather than the full-color brand logo.
  const AgentIcon = resolveSessionRowIcon({
    session_id: task.id,
    agentIconId: task.agentIconId ?? undefined,
    cliAgentType: task.cliAgentType ?? undefined,
  });
  return <AgentIcon size={14} strokeWidth={1.75} className="text-text-3" />;
}

function getStatusColor(task: KanbanTask): string | undefined {
  switch (task.resultStatus) {
    case KANBAN_RESULT_STATUS.Failed:
      return "var(--color-danger-6)";
    case KANBAN_RESULT_STATUS.Archived:
      return "var(--color-text-3)";
    default:
      return undefined;
  }
}

function formatDateTimeLabel(
  dateString: string | undefined,
  options: SessionTableDateTimeLabelOptions | undefined
): string | undefined {
  if (!dateString) return undefined;
  return formatSmartDateTime(dateString, {
    yesterdayLabel: options?.yesterdayLabel,
    locale: options?.locale,
  });
}

export function mapKanbanTaskToSessionTableItem({
  task,
  statusLabel,
  dateTimeLabelOptions,
  active,
  testId,
}: MapKanbanTaskToSessionTableItemInput): SessionTableItem {
  const impact = task.impact;
  const committedRateValue = impact?.committedRatePercent;
  const hasLinesChanged = Boolean(
    impact && (impact.linesAdded > 0 || impact.linesRemoved > 0)
  );

  return {
    id: task.id,
    title: task.title,
    description: task.description,
    statusLabel,
    statusColor: getStatusColor(task),
    agentIcon: renderAgentIcon(task),
    agentLabel: task.agentLabel ?? task.assignee,
    modelIcon: task.modelName ? (
      // Force text-1 so monochrome (currentColor) provider marks match the
      // board card's meta-pill instead of inheriting the table cell's text-2.
      // Baked brand-color icons ignore the color class and keep their hues.
      <ModelIcon
        modelName={task.modelName}
        agentType={task.cliAgentType}
        size={14}
        className="text-text-1"
      />
    ) : undefined,
    modelLabel: task.modelName
      ? formatModelNameFull(task.modelName)
      : undefined,
    workspaceLabel: truncateWorkspaceLabel(task.workspaceName),
    workspaceTitle: task.workspaceName,
    impactLabel:
      hasLinesChanged && impact ? (
        <DiffStatsBadge
          additions={impact.linesAdded}
          deletions={impact.linesRemoved}
          variant="plain"
          size="inherit"
          reserveValueWidth={false}
          valueClassName="font-normal"
          formatValue={(value) => value.toLocaleString()}
        />
      ) : undefined,
    filesChangedLabel:
      impact && impact.filesChanged > 0
        ? impact.filesChanged.toLocaleString()
        : undefined,
    relatedCommitsLabel:
      impact && impact.relatedCommits > 0
        ? impact.relatedCommits.toLocaleString()
        : undefined,
    committedRateLabel:
      committedRateValue !== undefined ? `${committedRateValue}%` : undefined,
    committedRateValue,
    tokensLabel: formatTokenCount(task.totalTokens),
    tokensValue: task.totalTokens,
    startedLabel: formatDateTimeLabel(task.created_at, dateTimeLabelOptions),
    lastUpdatedLabel: formatDateTimeLabel(
      task.updated_at ?? task.completed_at,
      dateTimeLabelOptions
    ),
    active,
    testId,
  };
}
