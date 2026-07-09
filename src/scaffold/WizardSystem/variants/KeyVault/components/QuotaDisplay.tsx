/**
 * QuotaDisplay Component
 *
 * Consolidated quota usage display used across the app.
 * Wraps QuotaBar(s) in a SectionContainer with optional labeled SectionRow.
 *
 * Handles all quota variants:
 * - Standard: single bar with remaining %
 * - Cursor: Auto/Composer quota + API quota + provider messages
 * - Premium items (e.g., Copilot Business premium requests)
 * - Simple: unlimited / credit-based text only
 *
 * Used by: CursorSetup, GenericSetup, KiroSetup, OAuthSetup, ValidationResults,
 *          AccountDetailsPanel (QuotaInfoSection replacement)
 */
import React from "react";
import { useTranslation } from "react-i18next";

import type { QuotaSnapshot } from "@src/api/types/keyVault";
import QuotaBar from "@src/components/QuotaBar";
import {
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";

interface QuotaDisplayProps {
  quotaInfo: QuotaSnapshot;
  /** Show SectionRow with "Quota Usage" label (default: true) */
  showLabel?: boolean;
  /** Use "full" variant with used/limit numbers (default: "compact") */
  variant?: "compact" | "full";
  /** When true, render only the bars (no SectionContainer) for embedding inside another SectionContainer */
  noContainer?: boolean;
  /** When true with noContainer, hide labels in QuotaBar (for row + indented bar layout) */
  hideBarLabels?: boolean;
  className?: string;
}

const QuotaDisplay: React.FC<QuotaDisplayProps> = ({
  quotaInfo,
  showLabel = true,
  variant = "compact",
  noContainer = false,
  hideBarLabels = false,
  className = "",
}) => {
  const { t } = useTranslation("integrations");
  const hasMainBar =
    quotaInfo.remaining_percentage != null &&
    quotaInfo.remaining_percentage >= 0;

  const hasOnDemand =
    quotaInfo.on_demand_enabled &&
    quotaInfo.on_demand_limit != null &&
    quotaInfo.on_demand_limit > 0;

  const planLabel = quotaInfo.plan_type
    ? quotaInfo.plan_type.charAt(0).toUpperCase() + quotaInfo.plan_type.slice(1)
    : null;

  const mainBarRemainingPercent =
    quotaInfo.total_percent_used != null
      ? 100 - quotaInfo.total_percent_used
      : (quotaInfo.remaining_percentage ?? 0);

  const onDemandRemainingPercent = hasOnDemand
    ? ((quotaInfo.on_demand_remaining ?? 0) / quotaInfo.on_demand_limit!) * 100
    : 0;

  const bars = (
    <>
      {hasMainBar && (
        <QuotaBar
          variant={variant}
          showLabel={!hideBarLabels}
          label={
            quotaInfo.on_demand_enabled ? (
              t("keyVault.quota.includedRequests")
            ) : planLabel ? (
              <span className="font-medium text-text-1">
                {t("keyVault.planLabel", { plan: planLabel })}
              </span>
            ) : (
              t("keyVault.quota.quotaUsage")
            )
          }
          remainingPercent={mainBarRemainingPercent}
          used={quotaInfo.used}
          limit={quotaInfo.limit}
          isUnlimited={quotaInfo.is_unlimited}
          className={hasOnDemand ? "mb-3" : undefined}
        />
      )}

      {hasOnDemand && (
        <QuotaBar
          variant={variant}
          showLabel={!hideBarLabels}
          label={t("keyVault.quota.onDemandBudget")}
          remainingPercent={onDemandRemainingPercent}
          used={quotaInfo.on_demand_used}
          limit={quotaInfo.on_demand_limit}
          formatValue={(cents) => `$${(cents / 100).toFixed(2)}`}
          isUnlimited={false}
        />
      )}

      {quotaInfo.reset_time && (
        <div className="mt-2 text-[11px] text-text-2">
          {t("keyVault.quota.resets", {
            date: new Date(quotaInfo.reset_time).toLocaleDateString(),
          })}
        </div>
      )}
    </>
  );

  if (noContainer) {
    return <div className={className}>{bars}</div>;
  }

  if (!showLabel) {
    return (
      <SectionContainer className={className} padding="default">
        {bars}
      </SectionContainer>
    );
  }

  return (
    <SectionContainer className={className}>
      <SectionRow
        label={t("keyVault.quotaUsageLabel")}
        description={t("keyVault.quotaUsageDesc")}
      />
      <SectionRow label="" indent showHeader={false}>
        {bars}
      </SectionRow>
    </SectionContainer>
  );
};

export default QuotaDisplay;
