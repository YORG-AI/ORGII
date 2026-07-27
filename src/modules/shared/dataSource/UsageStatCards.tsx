import { type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { UsageSummary } from "@src/api/tauri/usageDashboard";
import Tooltip from "@src/components/Tooltip";
import { STAT_GRID_TOKENS } from "@src/modules/shared/layouts/blocks";

import UsagePricingHint from "./UsagePricingHint";
import {
  formatInt,
  formatPercent,
  formatTokensShort,
  formatUsd,
} from "./usageFormat";

interface StatTileProps {
  label: string;
  value: string;
  secondaryValue?: string;
  emphasis?: boolean;
  /** When set, the value shows a dotted-underline and reveals this on hover. */
  tooltip?: ReactNode;
}

/** One KPI tile — mirrors the AIImpactContent StatItem card surface. */
function StatTile({
  label,
  value,
  secondaryValue,
  emphasis,
  tooltip,
}: StatTileProps) {
  const valueClass = emphasis
    ? "text-xl font-semibold text-text-1"
    : "text-base font-semibold text-text-1";
  const valueNode = tooltip ? (
    <Tooltip content={tooltip} position="bottom" mouseEnterDelay={500}>
      <span
        className={`${valueClass} w-fit cursor-help underline decoration-text-3 decoration-dotted underline-offset-4`}
      >
        {value}
      </span>
    </Tooltip>
  ) : (
    <span className={valueClass}>{value}</span>
  );
  return (
    <div className="flex flex-col gap-1.5 rounded-xl border border-border-1 bg-primary-container p-4">
      <span className="text-xs text-text-2">{label}</span>
      <div className="flex items-baseline gap-2">
        {valueNode}
        {secondaryValue ? (
          <span className="text-xs font-medium text-text-3">
            {secondaryValue}
          </span>
        ) : null}
      </div>
    </div>
  );
}

interface UsageStatCardsProps {
  summary: UsageSummary;
  /** Resolved UI language, for locale-aware integer grouping. */
  language: string;
}

/**
 * Headline KPI grid: real total tokens, estimated cost, sessions, cache-hit
 * rate, plus the input/output/cache token split — mirroring the reference
 * dashboard's hero row.
 */
export default function UsageStatCards({
  summary,
  language,
}: UsageStatCardsProps) {
  const { t } = useTranslation("sessions", { keyPrefix: "kanban.dataSource" });
  const tokens = (value: number) => formatTokensShort(value);

  return (
    // @container so STAT_GRID_TOKENS.cols4's `@[600px]:grid-cols-4` resolves
    // against the panel width — collapses the 8 tiles to two rows of four.
    <div className="flex flex-col gap-3 @container">
      <div className={STAT_GRID_TOKENS.cols4}>
        <StatTile
          label={t("usage.cards.realTokens")}
          value={tokens(summary.realTotalTokens)}
          emphasis
        />
        <StatTile
          label={t("usage.cards.cost")}
          value={formatUsd(summary.costUsd, 2)}
          emphasis
          tooltip={<UsagePricingHint />}
        />
        <StatTile
          label={`${t("usage.cards.sessions")} & ${t("usage.cards.requests")}`}
          value={formatInt(summary.sessionCount, language)}
          secondaryValue={formatInt(summary.requestCount, language)}
          emphasis
        />
        <StatTile
          label={t("usage.cards.cacheHit")}
          value={formatPercent(summary.cacheHitRate)}
          emphasis
        />
      </div>
      <div className={STAT_GRID_TOKENS.cols4}>
        <StatTile
          label={t("usage.cards.input")}
          value={tokens(summary.inputTokens)}
        />
        <StatTile
          label={t("usage.cards.output")}
          value={tokens(summary.outputTokens)}
        />
        <StatTile
          label={t("usage.cards.cacheCreate")}
          value={tokens(summary.cacheWriteTokens)}
        />
        <StatTile
          label={t("usage.cards.cacheRead")}
          value={tokens(summary.cacheReadTokens)}
        />
      </div>
    </div>
  );
}
