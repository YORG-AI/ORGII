import type { TFunction } from "i18next";

import { CLI_AGENT } from "@src/api/types/keys";
import type { UsageItem } from "@src/api/types/keys";

import type { KeyVaultAccount } from "./types";

const CURSOR_AUTO_COMPOSER_USAGE_TYPES = new Set<string>([
  "cursor_auto_composer",
  "plan",
  "individual_overall",
  "team_pooled",
]);

const CURSOR_API_USAGE_TYPES = new Set<string>(["cursor_api", "on_demand"]);

const WINDOW_PROVIDER_TYPES = new Set<KeyVaultAccount["modelType"]>([
  CLI_AGENT.CLAUDE_CODE,
  CLI_AGENT.CODEX,
]);

export interface AccountQuotaPercentageMetric {
  kind: "percentage";
  key: string;
  label: string;
  remainingPercent: number;
  resetTime?: string | null;
}

export interface AccountQuotaValueMetric {
  kind: "value";
  key: string;
  label: string;
  value: string;
}

export type AccountQuotaMetric =
  | AccountQuotaPercentageMetric
  | AccountQuotaValueMetric;

export interface AccountQuotaCard {
  id: string;
  accountName: string;
  accountPlan?: string | null;
  modelType: KeyVaultAccount["modelType"];
  metrics: AccountQuotaMetric[];
}

function hasUsageItems(
  quotaInfo: KeyVaultAccount["quotaInfo"]
): quotaInfo is NonNullable<KeyVaultAccount["quotaInfo"]> & {
  usage_items: UsageItem[];
} {
  return (
    Boolean(quotaInfo) &&
    Array.isArray((quotaInfo as { usage_items?: unknown }).usage_items)
  );
}

export function getCursorLegacyUsageItems(
  quotaInfo: NonNullable<KeyVaultAccount["quotaInfo"]>
): UsageItem[] {
  const legacyQuota = quotaInfo as {
    remaining_percentage?: number;
    used?: number | null;
    limit?: number | null;
    remaining?: number | null;
    on_demand_enabled?: boolean;
    on_demand_used?: number | null;
    on_demand_limit?: number | null;
    on_demand_remaining?: number | null;
  };

  const autoComposerItem: UsageItem = {
    usage_type: "cursor_auto_composer",
    enabled: true,
    used: legacyQuota.used ?? null,
    limit: legacyQuota.limit ?? null,
    remaining: legacyQuota.remaining ?? null,
    remaining_percentage: legacyQuota.remaining_percentage ?? 0,
  };

  if (!legacyQuota.on_demand_enabled) {
    return [autoComposerItem];
  }

  const apiLimit = legacyQuota.on_demand_limit ?? null;
  const apiRemaining = legacyQuota.on_demand_remaining ?? null;
  const apiRemainingPercentage =
    apiLimit != null && apiLimit > 0 && apiRemaining != null
      ? Math.min(100, Math.max(0, (apiRemaining / apiLimit) * 100))
      : 100;

  return [
    autoComposerItem,
    {
      usage_type: "cursor_api",
      enabled: true,
      used: legacyQuota.on_demand_used ?? null,
      limit: apiLimit,
      remaining: apiRemaining,
      remaining_percentage: apiRemainingPercentage,
    },
  ];
}

function isWindowProvider(modelType: KeyVaultAccount["modelType"]): boolean {
  return WINDOW_PROVIDER_TYPES.has(modelType);
}

function getWindowProviderFallbackUsageItems(
  quotaInfo: NonNullable<KeyVaultAccount["quotaInfo"]>
): UsageItem[] {
  const remainingPercentage = (
    quotaInfo as {
      remaining_percentage?: number | null;
    }
  ).remaining_percentage;

  if (
    typeof remainingPercentage !== "number" ||
    !Number.isFinite(remainingPercentage)
  ) {
    return [];
  }

  const remaining = Math.min(100, Math.max(0, remainingPercentage));
  const used = Math.round(100 - remaining);
  const roundedRemaining = Math.round(remaining);

  return ["session", "weekly"].map((usageType) => ({
    usage_type: usageType,
    enabled: true,
    used,
    limit: 100,
    remaining: roundedRemaining,
    remaining_percentage: remaining,
    reset_time: null,
  }));
}

function normalizeDisplayText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function formatPlanLabel(value: string | null | undefined): string | null {
  const trimmed = normalizeDisplayText(value);
  if (!trimmed) return null;

  return trimmed
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .split(" ")
    .map((part) =>
      part.length > 0 ? part.charAt(0).toUpperCase() + part.slice(1) : part
    )
    .join(" ");
}

const GENERIC_QUOTA_PLAN_TYPES = new Set<string>([
  CLI_AGENT.CLAUDE_CODE,
  CLI_AGENT.CODEX,
]);

function isGenericQuotaPlanType(
  modelType: KeyVaultAccount["modelType"],
  planType: string | null | undefined
): boolean {
  const normalized = planType?.trim().toLowerCase();
  if (!normalized) return true;
  if (normalized === modelType.toLowerCase()) return true;
  return GENERIC_QUOTA_PLAN_TYPES.has(normalized);
}

function getQuotaAccountIdentityLabel(account: KeyVaultAccount): string {
  return normalizeDisplayText(account.name) ?? account.modelType;
}

export function resolveQuotaPlanLabel(account: KeyVaultAccount): string | null {
  if (!account.quotaInfo) return null;

  if (account.modelType === CLI_AGENT.CLAUDE_CODE) {
    const tier = formatPlanLabel(account.accountMetadata?.rate_limit_tier);
    if (tier) return tier;
  }

  const planFromQuota = formatPlanLabel(account.quotaInfo.plan_type);
  if (
    !planFromQuota ||
    isGenericQuotaPlanType(account.modelType, account.quotaInfo.plan_type)
  ) {
    return null;
  }

  return planFromQuota;
}

function getQuotaAccountPlanLabel(account: KeyVaultAccount): string | null {
  return resolveQuotaPlanLabel(account);
}

function getQuotaCardLabels(account: KeyVaultAccount): {
  accountName: string;
  accountPlan: string | null;
} {
  const identityLabel = getQuotaAccountIdentityLabel(account);
  const planLabel = getQuotaAccountPlanLabel(account);
  if (!planLabel) {
    return { accountName: identityLabel, accountPlan: null };
  }
  if (identityLabel.toLowerCase().includes(planLabel.toLowerCase())) {
    return { accountName: identityLabel, accountPlan: null };
  }
  return { accountName: identityLabel, accountPlan: planLabel };
}

export function resolveAccountUsageItems(
  account: KeyVaultAccount
): UsageItem[] {
  if (!account.quotaInfo) return [];

  if (hasUsageItems(account.quotaInfo)) {
    const enabledItems = account.quotaInfo.usage_items.filter(
      (item) => item.enabled
    );
    if (enabledItems.length > 0) return enabledItems;
  }

  if (account.modelType === CLI_AGENT.CURSOR) {
    return getCursorLegacyUsageItems(account.quotaInfo);
  }

  if (isWindowProvider(account.modelType)) {
    return getWindowProviderFallbackUsageItems(account.quotaInfo);
  }

  return [];
}

function findUsageItem(
  items: UsageItem[],
  usageTypes: Set<string>
): UsageItem | undefined {
  return items.find((item) => usageTypes.has(item.usage_type));
}

function toMetric(
  item: UsageItem,
  key: string,
  label: string
): AccountQuotaMetric {
  return {
    kind: "percentage",
    key,
    label,
    remainingPercent: item.remaining_percentage,
    resetTime: item.reset_time,
  };
}

function formatBalanceValue(amount: number, currency: string): string {
  const normalizedCurrency = currency.trim().toUpperCase();
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: normalizedCurrency,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${normalizedCurrency}`.trim();
  }
}

function formatQuotaResetDurationUntil(
  resetTime: string | null | undefined,
  now: Date = new Date()
): { compact: string; full: string } | null {
  if (!resetTime) return null;

  const resetDate = new Date(resetTime);
  if (Number.isNaN(resetDate.getTime())) return null;

  const diffMs = resetDate.getTime() - now.getTime();
  if (diffMs <= 0) return null;

  const totalMinutes = Math.ceil(diffMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const compact =
    hours > 0
      ? minutes > 0
        ? `${hours}h ${minutes}m`
        : `${hours}h`
      : `${minutes}m`;
  const full =
    formatQuotaResetTime(resetTime)?.full ??
    `${compact} (${resetDate.toISOString()})`;

  return { compact, full };
}

export function formatQuotaResetTime(
  resetTime: string | null | undefined
): { compact: string; full: string } | null {
  if (!resetTime) return null;

  const resetDate = new Date(resetTime);
  if (Number.isNaN(resetDate.getTime())) return null;

  const now = new Date();
  const sameDay = resetDate.toDateString() === now.toDateString();
  const sameYear = resetDate.getFullYear() === now.getFullYear();
  const compact = new Intl.DateTimeFormat(undefined, {
    ...(sameDay ? {} : { month: "short", day: "numeric" }),
    ...(sameDay || sameYear ? {} : { year: "numeric" }),
    hour: "2-digit",
    minute: "2-digit",
  }).format(resetDate);
  const full = new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  }).format(resetDate);

  return { compact, full };
}

export function formatQuotaResetHint(
  usageType: string,
  remainingPercent: number,
  resetTime: string | null | undefined,
  tIntegrations: TFunction<"integrations">
): { compact: string; full?: string } | null {
  if (usageType === "session") {
    const sessionResetLabel = formatQuotaResetDurationUntil(resetTime);
    if (sessionResetLabel) return sessionResetLabel;
  } else {
    const resetLabel = formatQuotaResetTime(resetTime);
    if (resetLabel) return resetLabel;
  }

  if (remainingPercent < 99.5) return null;

  return {
    compact: tIntegrations(
      usageType === "session"
        ? "keyVault.quota.nextUsePlusFiveHours"
        : "keyVault.quota.availableNow"
    ),
  };
}

function getGenericMetricLabel(
  usageType: string,
  tSessions: TFunction<"sessions">,
  tIntegrations: TFunction<"integrations">
): string {
  if (usageType === "session") {
    return tSessions("chat.startPage.quota.metrics.fiveHour");
  }
  if (usageType === "weekly") {
    return tSessions("chat.startPage.quota.metrics.sevenDay");
  }
  if (usageType === "monthly") {
    return tSessions("chat.startPage.quota.metrics.monthly");
  }
  if (usageType === "chat") {
    return tIntegrations("keyVault.quota.includedRequests");
  }
  if (usageType === "completions") {
    return tIntegrations("keyVault.quota.quotaUsage");
  }
  if (usageType === "premium") {
    return tIntegrations("keyVault.quota.onDemandBudget");
  }
  return usageType.replace(/_/g, " ");
}

export function buildAccountQuotaMetrics(
  account: KeyVaultAccount,
  usageItems: UsageItem[],
  tSessions: TFunction<"sessions">,
  tIntegrations: TFunction<"integrations">
): AccountQuotaMetric[] {
  const isCursorAccount = account.modelType === CLI_AGENT.CURSOR;

  if (isCursorAccount) {
    const autoItem = findUsageItem(
      usageItems,
      CURSOR_AUTO_COMPOSER_USAGE_TYPES
    );
    const apiItem = findUsageItem(usageItems, CURSOR_API_USAGE_TYPES);
    return [autoItem, apiItem]
      .filter((item): item is UsageItem => Boolean(item))
      .map((item) =>
        toMetric(
          item,
          item.usage_type,
          CURSOR_API_USAGE_TYPES.has(item.usage_type)
            ? tSessions("chat.startPage.quota.metrics.api")
            : tSessions("chat.startPage.quota.metrics.auto")
        )
      );
  }

  if (isWindowProvider(account.modelType)) {
    const sessionItem = usageItems.find(
      (item) => item.usage_type === "session"
    );
    const weeklyItem = usageItems.find((item) => item.usage_type === "weekly");
    return [sessionItem, weeklyItem]
      .filter((item): item is UsageItem => Boolean(item))
      .map((item) =>
        toMetric(
          item,
          item.usage_type,
          item.usage_type === "session"
            ? tSessions("chat.startPage.quota.metrics.fiveHour")
            : tSessions("chat.startPage.quota.metrics.sevenDay")
        )
      );
  }

  return usageItems.map((item) =>
    toMetric(
      item,
      item.usage_type,
      getGenericMetricLabel(item.usage_type, tSessions, tIntegrations)
    )
  );
}

export function getQuotaUsageLabel(
  modelType: KeyVaultAccount["modelType"],
  usageType: string,
  tIntegrations: TFunction<"integrations">,
  tSessions?: TFunction<"sessions">
): string {
  if (modelType === CLI_AGENT.CURSOR) {
    return CURSOR_API_USAGE_TYPES.has(usageType)
      ? tIntegrations("keyVault.quota.cursorApiUsage")
      : tIntegrations("keyVault.quota.cursorIncludedRequests");
  }
  if (usageType === "session") {
    return (
      tSessions?.("chat.startPage.quota.metrics.fiveHour") ??
      tIntegrations("keyVault.quota.sessionUsage")
    );
  }
  if (usageType === "weekly") {
    return (
      tSessions?.("chat.startPage.quota.metrics.sevenDay") ??
      tIntegrations("keyVault.quota.weeklyUsage")
    );
  }
  if (usageType === "monthly") {
    return tIntegrations("keyVault.quota.monthlyUsage");
  }
  return usageType.replace(/_/g, " ");
}

export function collectAccountQuotaCards(
  accounts: KeyVaultAccount[],
  tSessions: TFunction<"sessions">,
  tIntegrations: TFunction<"integrations">
): AccountQuotaCard[] {
  const cards: AccountQuotaCard[] = [];

  for (const account of accounts) {
    if (!account.quotaInfo || account.healthStatus === "invalid") continue;

    const accountLabels = getQuotaCardLabels(account);
    const usageItems = resolveAccountUsageItems(account);
    const metrics =
      usageItems.length > 0
        ? buildAccountQuotaMetrics(
            account,
            usageItems,
            tSessions,
            tIntegrations
          )
        : [];
    const balance =
      "balance" in account.quotaInfo ? account.quotaInfo.balance : undefined;
    if (
      balance &&
      Number.isFinite(balance.amount) &&
      balance.amount >= 0 &&
      balance.currency.trim()
    ) {
      metrics.unshift({
        kind: "value",
        key: "balance",
        label: tIntegrations("keyVault.quota.balance", {
          defaultValue: "Balance",
        }),
        value: formatBalanceValue(balance.amount, balance.currency),
      });
    }

    if (metrics.length === 0) {
      const remainingPercent = account.quotaInfo.remaining_percentage;
      if (
        typeof remainingPercent !== "number" ||
        !Number.isFinite(remainingPercent) ||
        remainingPercent < 0
      ) {
        continue;
      }
      cards.push({
        id: account.id,
        accountName: accountLabels.accountName,
        accountPlan: accountLabels.accountPlan,
        modelType: account.modelType,
        metrics: [
          {
            kind: "percentage",
            key: "overall",
            label: tIntegrations("keyVault.quota.quotaUsage"),
            remainingPercent,
          },
        ],
      });
      continue;
    }

    cards.push({
      id: account.id,
      accountName: accountLabels.accountName,
      accountPlan: accountLabels.accountPlan,
      modelType: account.modelType,
      metrics,
    });
  }

  return cards;
}

export function getGroupedUsageItemsForDisplay(
  account: KeyVaultAccount,
  usageItems: UsageItem[]
): UsageItem[] {
  if (account.modelType === CLI_AGENT.CURSOR) {
    const autoComposerItem = usageItems.find((item) =>
      CURSOR_AUTO_COMPOSER_USAGE_TYPES.has(item.usage_type)
    );
    const apiItem = usageItems.find((item) =>
      CURSOR_API_USAGE_TYPES.has(item.usage_type)
    );
    return [autoComposerItem, apiItem].filter((item): item is UsageItem =>
      Boolean(item)
    );
  }

  if (isWindowProvider(account.modelType)) {
    const sessionItem = usageItems.find(
      (item) => item.usage_type === "session"
    );
    const weeklyItem = usageItems.find((item) => item.usage_type === "weekly");
    return [sessionItem, weeklyItem].filter((item): item is UsageItem =>
      Boolean(item)
    );
  }

  return usageItems;
}
