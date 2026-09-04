import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  type ModelPricing,
  usageDashboardModelPricing,
} from "@src/api/tauri/usageDashboard";
import { HugeiconsIcon, Loading03Icon } from "@src/icons";

import { formatInt, formatUsd } from "./usageFormat";

export interface PricingBreakdown {
  model?: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

function costOf(tokens: number, perMtok: number): number {
  return (Math.max(tokens, 0) / 1_000_000) * perMtok;
}

function Line({
  label,
  tokens,
  cost,
}: {
  label: string;
  tokens: number;
  cost: number;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-text-2">{label}</span>
      <span className="text-text-3 tabular-nums">
        {formatInt(tokens)}
        <span className="ml-2 text-text-1">{formatUsd(cost, 4)}</span>
      </span>
    </div>
  );
}

/**
 * Tooltip content for a cost figure. With `breakdown` (one round) it lazily
 * fetches that model's list rates on open and shows the per-line Input / Cache
 * / Output dollar split + Total. Without it (an aggregate total), it shows a
 * terse note pointing at the per-request breakdown.
 */
export default function UsagePricingHint({
  breakdown,
}: {
  breakdown?: PricingBreakdown;
}) {
  const { t } = useTranslation("sessions", { keyPrefix: "kanban.dataSource" });
  const [rates, setRates] = useState<ModelPricing | null>(null);

  const model = breakdown?.model ?? null;
  useEffect(() => {
    if (!breakdown) return;
    let cancelled = false;
    // setState lives in the promise callback (not the effect body), so this
    // satisfies react-hooks/set-state-in-effect.
    usageDashboardModelPricing(model)
      .then((result) => {
        if (!cancelled) setRates(result);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [breakdown, model]);

  if (!breakdown) {
    return (
      <div className="max-w-[240px] space-y-1 text-left text-[11px] leading-snug">
        <div className="font-medium text-text-1">
          {t("usage.pricing.estimate")}
        </div>
        <div className="text-text-3">{t("usage.pricing.hint")}</div>
      </div>
    );
  }

  if (!rates) {
    return (
      <span className="flex items-center gap-1.5 text-[11px] text-text-3">
        <HugeiconsIcon
          icon={Loading03Icon}
          data-icon="loader-2"
          className="h-3 w-3 animate-spin"
        />
        {t("usage.pricing.loading")}
      </span>
    );
  }

  const inputCost = costOf(breakdown.inputTokens, rates.inputPerMtok);
  const outputCost = costOf(breakdown.outputTokens, rates.outputPerMtok);
  const cacheReadCost = costOf(
    breakdown.cacheReadTokens,
    rates.cacheReadPerMtok
  );
  const cacheWriteCost = costOf(
    breakdown.cacheWriteTokens,
    rates.cacheWritePerMtok
  );
  const cacheTokens = breakdown.cacheReadTokens + breakdown.cacheWriteTokens;
  const cacheCost = cacheReadCost + cacheWriteCost;
  const total = inputCost + outputCost + cacheCost;

  return (
    <div className="min-w-[180px] space-y-1 text-left text-[11px] leading-snug">
      {breakdown.model && (
        <div
          className="truncate font-medium text-text-1"
          title={breakdown.model}
        >
          {breakdown.model}
        </div>
      )}
      <Line
        label={t("usage.pricing.input")}
        tokens={breakdown.inputTokens}
        cost={inputCost}
      />
      <Line
        label={t("usage.pricing.cache")}
        tokens={cacheTokens}
        cost={cacheCost}
      />
      <Line
        label={t("usage.pricing.output")}
        tokens={breakdown.outputTokens}
        cost={outputCost}
      />
      <div className="flex items-baseline justify-between gap-4 border-t border-border-2 pt-1">
        <span className="font-medium text-text-1">
          {t("usage.pricing.total")}
        </span>
        <span className="font-medium text-text-1 tabular-nums">
          {formatUsd(total, 4)}
        </span>
      </div>
    </div>
  );
}
