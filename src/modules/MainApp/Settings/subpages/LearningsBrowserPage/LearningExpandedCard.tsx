import {
  ToolInlineCompactRows,
  ToolInlineInfoCard,
} from "@/src/modules/shared/layouts/blocks";
import type { TFunction } from "i18next";
import React from "react";

import type { LearningRecord } from "@src/api/tauri/rpc/schemas/learning";

import { formatRelativeTime, truncate } from "./formatters";

interface LearningExpandedCardProps {
  row: LearningRecord;
  t: TFunction;
  getAgentLabel: (row: LearningRecord) => string;
  getCategoryLabel: (row: LearningRecord) => string;
}

export const LearningExpandedCard: React.FC<LearningExpandedCardProps> = ({
  row,
  t,
  getAgentLabel,
  getCategoryLabel,
}) => {
  const details = (
    <ToolInlineCompactRows
      rows={[
        {
          key: "agent",
          label: (
            <span className="font-medium text-text-1">
              {t("common:terminology.agent")}
            </span>
          ),
          value: <span className="text-text-2">{getAgentLabel(row)}</span>,
        },
        {
          key: "category",
          label: (
            <span className="font-medium text-text-1">
              {t("learningsBrowser.filterLabels.category")}
            </span>
          ),
          value: <span className="text-text-2">{getCategoryLabel(row)}</span>,
        },
        {
          key: "status",
          label: (
            <span className="font-medium text-text-1">
              {t("learningsBrowser.columns.status")}
            </span>
          ),
          value: (
            <span className="text-text-2">
              {t(`learningsBrowser.status.${row.status}`, row.status)}
            </span>
          ),
        },
        {
          key: "source",
          label: (
            <span className="font-medium text-text-1">
              {t("learningsBrowser.columns.source")}
            </span>
          ),
          value: (
            <span className="text-text-2">
              {t(`learningsBrowser.source.${row.source}`, row.source)}
            </span>
          ),
        },
        {
          key: "reinforcement",
          label: (
            <span className="font-medium text-text-1">
              {t("learningsBrowser.columns.reinforcement")}
            </span>
          ),
          value: (
            <span className="text-text-2">×{row.reinforcement_count}</span>
          ),
        },
        {
          key: "updated",
          label: (
            <span className="font-medium text-text-1">
              {t("learningsBrowser.columns.updatedAt")}
            </span>
          ),
          value: (
            <span className="text-text-2">
              {formatRelativeTime(row.updated_at)}
            </span>
          ),
        },
        {
          key: "lastRecalled",
          label: (
            <span className="font-medium text-text-1">
              {t("learningsBrowser.columns.lastRecalled")}
            </span>
          ),
          value: (
            <span className="text-text-2">
              {row.last_recalled_at
                ? formatRelativeTime(row.last_recalled_at)
                : "—"}
            </span>
          ),
        },
      ]}
    />
  );

  return (
    <ToolInlineInfoCard
      title={row.takeaway ?? truncate(row.content, 80)}
      actionCountLabel={t(`learningsBrowser.status.${row.status}`, row.status)}
      description=""
      actions={[]}
      agentSection={{
        title: t("common:labels.details"),
        content: details,
        defaultOpen: true,
      }}
      commandsTitle={t("learningsBrowser.columns.takeaway")}
      sectionLayout="tabs"
      commandsContent={
        <div className="policy-markdown-scroll max-h-[360px] w-full max-w-full min-w-0 overflow-auto text-[13px] leading-relaxed whitespace-pre-wrap text-text-2 select-text">
          {row.content || row.takeaway || "—"}
        </div>
      }
    />
  );
};
