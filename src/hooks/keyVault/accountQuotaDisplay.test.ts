import type { TFunction } from "i18next";
import { describe, expect, it } from "vitest";

import { collectAccountQuotaCards } from "./accountQuotaDisplay";
import type { KeyVaultAccount } from "./types";

const translate = ((key: string, options?: { defaultValue?: string }) =>
  options?.defaultValue ?? key) as TFunction;

function deepSeekAccount(): KeyVaultAccount {
  return {
    id: "deepseek-account",
    hasLocalKey: true,
    isListed: false,
    modelType: "deepseek_api",
    name: "DeepSeek",
    status: "ready",
    hasKey: true,
    hasApiKey: true,
    hasSessionToken: false,
    enabled: true,
    quotaInfo: {
      remaining_percentage: -1,
      used: null,
      limit: null,
      remaining: null,
      reset_time: null,
      billing_start: null,
      plan_type: "Pay-as-you-go",
      limit_type: null,
      is_unlimited: false,
      quota_source: "deepseek_balance",
      usage_items: [],
      balance: { amount: 12.34, currency: "USD" },
      auto_message: null,
      named_message: null,
    },
  };
}

describe("collectAccountQuotaCards", () => {
  it("renders an exact balance without inventing a percentage meter", () => {
    const [card] = collectAccountQuotaCards(
      [deepSeekAccount()],
      translate,
      translate
    );

    expect(card.accountPlan).toBe("Pay As You Go");
    expect(card.metrics).toHaveLength(1);
    expect(card.metrics[0]).toMatchObject({
      kind: "value",
      key: "balance",
      label: "Balance",
    });
    expect(card.metrics.some((metric) => metric.kind === "percentage")).toBe(
      false
    );
  });
});
