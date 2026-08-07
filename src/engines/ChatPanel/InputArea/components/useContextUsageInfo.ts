import { useAtomValue } from "jotai";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { useKeyVault } from "@src/hooks/keyVault";
import { useValidatedLastPair } from "@src/hooks/models/useValidatedLastPair";
import type { ContextUsageSnapshot } from "@src/store/session/cliSessionStatusAtom";
import {
  sessionContextTokensAtom,
  sessionContextUsageAtom,
} from "@src/store/session/cliSessionStatusAtom";
import { getModelInfo } from "@src/util/modelInfo";

export interface ContextUsageInfo {
  percentage: number;
  clampedPercentage: number;
  tokenLabel: string;
  maxTokens: number;
  displayTokens: number;
  contextUsage: ContextUsageSnapshot | null;
  /** Cache-read tokens saved by Anthropic prompt caching (not counted as used). */
  cacheReadTokens: number;
  /** Cache-write tokens written this turn. */
  cacheWriteTokens: number;
  /** Remaining available tokens (maxTokens - displayTokens excluding cache). */
  remainingTokens: number;
  /**
   * Prompt-cache hit rate in [0, 1]: `cacheRead / (cacheRead + billableInput)`.
   * Matches the backend `cache_hit_rate` cost metric — at 0.9 the prompt costs
   * ~10% of full price. 0 when there is no cache activity.
   */
  cacheHitRate: number;
  /** Tokens served from cache this turn (i.e. cacheReadTokens), surfaced as savings. */
  cacheSavedTokens: number;
}

export function formatTokenCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return `${count}`;
}

/**
 * Prompt-cache hit rate `cacheRead / (cacheRead + billableInput)`.
 *
 * Mirrors the Rust `cache_hit_rate` helper. `billableInput` is the
 * non-cached input the provider charged full price for this turn. Returns 0
 * when both inputs are zero (no usage yet) so it is safe to render
 * unconditionally.
 */
export function computeCacheHitRate(
  cacheReadTokens: number,
  billableInputTokens: number
): number {
  const denom = Math.max(0, cacheReadTokens) + Math.max(0, billableInputTokens);
  if (denom <= 0) return 0;
  return Math.max(0, cacheReadTokens) / denom;
}

export function useContextUsageInfo(): ContextUsageInfo {
  const { t } = useTranslation();
  const sessionTokens = useAtomValue(sessionContextTokensAtom);
  const contextUsage = useAtomValue(sessionContextUsageAtom);
  const lastModel = useValidatedLastPair();
  const { accounts } = useKeyVault({ autoLoad: true });

  const modelName = lastModel?.model || lastModel?.listingModel || "";
  const modelInfo = useMemo(
    () => (modelName ? getModelInfo(modelName) : null),
    [modelName]
  );
  const accountContextWindow = useMemo(() => {
    const accountId = lastModel?.selectedAccountId;
    if (!modelName || !accountId) return null;
    const account = accounts.find((entry) => entry.id === accountId);
    const contextWindow = account?.modelVariants?.find(
      (variant) => variant.model === modelName
    )?.context_window;
    return typeof contextWindow === "number" && contextWindow > 0
      ? contextWindow
      : null;
  }, [accounts, lastModel?.selectedAccountId, modelName]);
  const contextWindowK = modelInfo?.contextWindow ?? 200;
  const modelMaxTokens = accountContextWindow ?? contextWindowK * 1000;
  const maxTokens = contextUsage?.maxTokens ?? modelMaxTokens;
  const snapshotTokens = contextUsage?.usedTokens ?? 0;
  const displayTokens = sessionTokens > 0 ? sessionTokens : snapshotTokens;
  const hasFreshSnapshot = contextUsage?.usedTokens === displayTokens;
  const percentage =
    hasFreshSnapshot && contextUsage?.percentUsed != null
      ? contextUsage.percentUsed
      : maxTokens > 0
        ? (displayTokens / maxTokens) * 100
        : 0;
  const clampedPercentage = Math.min(percentage, 100);

  const tokenLabel = `${percentage.toFixed(1)}% · ${formatTokenCount(displayTokens)} / ${formatTokenCount(maxTokens)} ${t("contextInfo.contextUsed")}`;

  const cacheReadTokens = contextUsage?.cacheReadTokens ?? 0;
  const cacheWriteTokens = contextUsage?.cacheWriteTokens ?? 0;
  const remainingTokens = Math.max(0, maxTokens - displayTokens);

  // displayTokens (== last_prompt) = billableInput + cacheRead + cacheWrite,
  // so the non-cached input the provider charged full price for is the
  // remainder. The hit-rate denominator is cacheRead + billableInput.
  const billableInputTokens = Math.max(
    0,
    displayTokens - cacheReadTokens - cacheWriteTokens
  );
  const cacheHitRate = computeCacheHitRate(
    cacheReadTokens,
    billableInputTokens
  );
  const cacheSavedTokens = cacheReadTokens;

  return {
    percentage,
    clampedPercentage,
    tokenLabel,
    maxTokens,
    displayTokens,
    contextUsage,
    cacheReadTokens,
    cacheWriteTokens,
    remainingTokens,
    cacheHitRate,
    cacheSavedTokens,
  };
}
