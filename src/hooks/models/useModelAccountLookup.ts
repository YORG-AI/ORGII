import { useMemo } from "react";

import { type KeyVaultAccount, useKeyVault } from "@src/hooks/keyVault";

import type { ModelAccountInfo } from "./types";

/**
 * Returns true if `account` currently exposes and has enabled `modelId`.
 *
 * Two ways an id counts as selectable:
 * - it is present in both `availableModels` and `enabledModels`, or
 * - it is a variant row from `modelVariants` (e.g. a backend-synthesized
 *   effort rung like `claude-opus-4-8-high`) whose BASE model is available
 *   and enabled —
 *   variant ids never appear in enabledModels themselves, so gating on
 *   enabledModels alone hides every synthesized effort ladder from the
 *   picker's variant-edit affordance.
 */
export function accountHasModel(
  account: Pick<
    KeyVaultAccount,
    "availableModels" | "enabledModels" | "enabled" | "modelVariants"
  >,
  modelId: string
): boolean {
  if (!account.enabled) return false;
  const available = new Set(account.availableModels ?? []);
  const enabled = new Set(account.enabledModels ?? []);
  if (available.has(modelId) && enabled.has(modelId)) return true;
  return (account.modelVariants ?? []).some(
    (variant) =>
      variant.model === modelId &&
      available.has(variant.base_model) &&
      enabled.has(variant.base_model)
  );
}

/**
 * Every model id an account exposes: `availableModels` plus variant ids
 * from `modelVariants` (deduped). The variant ids must enter the model
 * universe or `groupByModel` family expansion can never offer them.
 */
export function accountModelIds(account: KeyVaultAccount): string[] {
  const ids = new Set(account.availableModels ?? []);
  for (const variant of account.modelVariants ?? []) {
    if (variant.model) ids.add(variant.model);
  }
  return [...ids];
}

/**
 * Pure utility: build a lookup from model ID → account info
 * (total key count + unique provider agent types).
 */
export function buildAccountLookup(
  accounts: KeyVaultAccount[]
): Map<string, ModelAccountInfo> {
  const lookup = new Map<string, ModelAccountInfo>();
  for (const account of accounts) {
    if (account.status !== "ready") continue;
    for (const modelId of accountModelIds(account)) {
      if (!modelId || !accountHasModel(account, modelId)) continue;
      const existing = lookup.get(modelId);
      if (existing) {
        existing.totalKeys += 1;
        if (!existing.agentTypes.includes(account.modelType)) {
          existing.agentTypes.push(account.modelType);
        }
      } else {
        lookup.set(modelId, {
          totalKeys: 1,
          agentTypes: [account.modelType],
        });
      }
    }
  }
  return lookup;
}

/**
 * Hook: loads code accounts and provides a memoised model → account info lookup.
 *
 * Returns both the lookup map and the raw accounts array so callers can
 * derive additional data (e.g. available source types) without a second
 * useKeyVault call.
 */
export function useModelAccountLookup() {
  const { accounts } = useKeyVault({ autoLoad: true });

  const accountLookup = useMemo(() => buildAccountLookup(accounts), [accounts]);

  return { accountLookup, accounts };
}
