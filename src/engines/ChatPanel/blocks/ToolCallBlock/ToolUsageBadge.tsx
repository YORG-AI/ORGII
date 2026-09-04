import { useAtomValue } from "jotai";
import React from "react";
import { useTranslation } from "react-i18next";

import type { ToolUsageMetadata } from "@src/engines/SessionCore/core/types";
import {
  ArrowDownToDotIcon,
  ArrowUpFromDotIcon,
  HugeiconsIcon,
} from "@src/icons";
import { chatTokenUsageVisibleAtom } from "@src/store/ui/chatPanelAtom";

interface UsagePairBadgeProps {
  inputTokens: number;
  outputTokens: number;
  title: string;
}

interface ToolUsageBadgeProps {
  usage: ToolUsageMetadata;
}

export function formatToolUsageTokenCount(tokens: number): string {
  if (tokens >= 1000) {
    const value = tokens / 1000;
    return `${value.toFixed(value >= 10 ? 0 : 1)}k`;
  }
  return String(tokens);
}

export const UsagePairBadge: React.FC<UsagePairBadgeProps> = ({
  inputTokens,
  outputTokens,
  title,
}) => {
  const tokenUsageVisible = useAtomValue(chatTokenUsageVisibleAtom);
  if (!tokenUsageVisible || inputTokens + outputTokens <= 0) return null;

  return (
    <span
      className="border-border/60 bg-muted/50 inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] font-medium text-text-2"
      title={title}
    >
      {inputTokens > 0 && (
        <span className="inline-flex items-center gap-0.5">
          <HugeiconsIcon
            icon={ArrowUpFromDotIcon}
            data-icon="arrow-up-from-dot"
            size={11}
            strokeWidth={2}
          />
          {formatToolUsageTokenCount(inputTokens)}
        </span>
      )}
      {inputTokens > 0 && outputTokens > 0 && (
        <span className="h-3 w-px bg-border-2" />
      )}
      {outputTokens > 0 && (
        <span className="inline-flex items-center gap-0.5">
          <HugeiconsIcon
            icon={ArrowDownToDotIcon}
            data-icon="arrow-down-to-dot"
            size={11}
            strokeWidth={2}
          />
          {formatToolUsageTokenCount(outputTokens)}
        </span>
      )}
    </span>
  );
};

const ToolUsageBadge: React.FC<ToolUsageBadgeProps> = ({ usage }) => {
  const { t } = useTranslation("sessions");
  const inputTokens = usage.resultContextTokens;
  const outputTokens =
    usage.decisionCompletionTokens + usage.followupCompletionTokens;

  const title = t("toolUsage.tooltip", {
    method: usage.attributionMethod,
    inputBytes: usage.inputBytes,
    outputBytes: usage.outputBytes,
    decisionTokens: usage.decisionCompletionTokens,
    contextTokens: usage.resultContextTokens,
    followupTokens: usage.followupCompletionTokens,
    cacheReadTokens: usage.relatedCacheReadTokens,
    cacheWriteTokens: usage.relatedCacheWriteTokens,
  });

  return (
    <UsagePairBadge
      inputTokens={inputTokens}
      outputTokens={outputTokens}
      title={title}
    />
  );
};

export default React.memo(ToolUsageBadge);
