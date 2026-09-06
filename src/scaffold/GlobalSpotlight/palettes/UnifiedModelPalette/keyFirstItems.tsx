/**
 * keyFirstItems — row builders for the palette's "Key first" mode.
 *
 * In this mode the two-column flow runs the other way round from the
 * default: the left column lists keys (Key Vault accounts) and the right
 * column lists the models the focused key serves. Selecting a model in
 * the right column commits the (key, model) pair.
 */
import React from "react";

import ModelIcon from "@src/components/ModelIcon";
import type { KeyVaultAccount } from "@src/hooks/keyVault/types";
import { getModelAliasDisplayName } from "@src/hooks/models/modelAliasRegistry";
import {
  accountHasModel,
  accountModelIds,
} from "@src/hooks/models/useModelAccountLookup";
import { resolveDefaultVariant } from "@src/util/defaultModelVariant";
import {
  compareModelsByVersion,
  formatModelNameFull,
} from "@src/util/formatModelName";
import { groupModels } from "@src/util/modelGrouping";
import {
  parseModelVariant,
  resolveModelVariantFields,
} from "@src/util/modelVariants";

import type { SpotlightItem } from "../../types";
import { VariantPill } from "./VariantPill";
import { MODEL_SECTION } from "./modelSection";

export const KEY_FIRST_KEY_TEST_ID = "unified-model-key-option";
export const KEY_FIRST_MODEL_TEST_ID = "unified-model-key-model-option";

/** Model ids the account can actually launch (enabled, incl. variant rungs). */
export function enabledAccountModelIds(account: KeyVaultAccount): string[] {
  return accountModelIds(account).filter((modelId) =>
    accountHasModel(account, modelId)
  );
}

/** Keys that appear in the left column of key-first mode. */
export function selectableKeyAccounts(
  accounts: KeyVaultAccount[],
  isCliAgent: boolean
): KeyVaultAccount[] {
  return accounts.filter((account) => {
    if (account.status !== "ready" || !account.hasKey) return false;
    // A CLI-agent key with no model listing is still launchable — the
    // session falls back to the agent's own default model — so keep it.
    return isCliAgent || enabledAccountModelIds(account).length > 0;
  });
}

interface BuildKeyItemsParams {
  accounts: KeyVaultAccount[];
  isCliAgent: boolean;
  /** Focus the key and hand the cursor to the models column. */
  onSelectKey: (accountId: string) => void;
  /** Commit a (key, model) pair. `modelId` may be "" for model-less CLI keys. */
  onCommit: (account: KeyVaultAccount, modelId: string) => void;
}

export function buildKeyItems({
  accounts,
  isCliAgent,
  onSelectKey,
  onCommit,
}: BuildKeyItemsParams): SpotlightItem[] {
  return selectableKeyAccounts(accounts, isCliAgent).map((account) => {
    const modelIds = enabledAccountModelIds(account);
    const groupCount = groupModels(modelIds).length;
    const KeyIcon = () => <ModelIcon agentType={account.modelType} size={14} />;

    const labelContent = (
      <span className="shrink-0 font-normal text-text-1">{account.name}</span>
    );

    return {
      id: `key:${account.id}`,
      label: account.name,
      icon: KeyIcon,
      type: "action" as const,
      data: {
        isSelector: true,
        modelSection: MODEL_SECTION.ALL,
        keyAccountId: account.id,
        labelContent,
        rightContent: (
          <span className="text-[12px] text-text-3">{groupCount}</span>
        ),
        showDisclosureChevron: groupCount > 0,
        searchAlias: account.modelType,
        testId: KEY_FIRST_KEY_TEST_ID,
      },
      // A key with nothing to pick in Step 2 is a one-click launch.
      action: () =>
        groupCount > 0 ? onSelectKey(account.id) : onCommit(account, ""),
    };
  });
}

interface BuildKeyModelItemsParams {
  account: KeyVaultAccount;
  onCommit: (account: KeyVaultAccount, modelId: string) => void;
  persistDefaultVariantForAccount: (
    accountId: string,
    baseModel: string,
    modelId: string
  ) => void;
}

/**
 * Right-column rows for key-first mode: one row per model family the key
 * serves. Multi-variant families carry an editable {@link VariantPill}
 * bound to the key's persisted default variant, exactly like the account
 * rows of the default mode.
 */
export function buildKeyModelItems({
  account,
  onCommit,
  persistDefaultVariantForAccount,
}: BuildKeyModelItemsParams): SpotlightItem[] {
  const items: SpotlightItem[] = [];
  const literalModels = account.modelType === "custom_api";
  const groups = literalModels
    ? enabledAccountModelIds(account).flatMap((model) => groupModels([model]))
    : groupModels(enabledAccountModelIds(account));

  for (const group of groups) {
    const sortedVariants = [...group.models].sort(compareModelsByVersion);
    const representative = sortedVariants[0];
    if (!representative) continue;

    const variantInfos = sortedVariants.map((modelId) =>
      resolveModelVariantFields(modelId)
    );
    const baseModel = literalModels
      ? representative
      : (parseModelVariant(representative)?.baseModel ??
        variantInfos[0]?.base_model ??
        representative);
    const persisted = (account.defaultVariants ?? []).find(
      (entry) =>
        entry.base_model === baseModel && sortedVariants.includes(entry.model)
    )?.model;
    const launchModel = literalModels
      ? representative
      : (resolveDefaultVariant(baseModel, variantInfos, persisted) ??
        representative);

    const ModelItemIcon = () => (
      <ModelIcon modelName={representative} size={14} />
    );

    const hasMultipleVariants = sortedVariants.length > 1;
    const aliasDisplayName = getModelAliasDisplayName(
      representative,
      account.id
    );
    const displayLabel = hasMultipleVariants
      ? group.label
      : (aliasDisplayName ?? formatModelNameFull(representative));

    const labelContent =
      !hasMultipleVariants && aliasDisplayName ? (
        <>
          <span className="shrink-0 font-normal text-text-1">
            {displayLabel}
          </span>
          <span className="ml-1.5 min-w-0 truncate text-[12px] text-text-2">
            {representative}
          </span>
        </>
      ) : (
        <span className="shrink-0 font-normal text-text-1">{displayLabel}</span>
      );

    const trailing: React.ReactNode =
      literalModels ? null : hasMultipleVariants ? (
        <VariantPill
          modelId={launchModel}
          groupModelIds={sortedVariants}
          onApply={(nextModelId) =>
            persistDefaultVariantForAccount(account.id, baseModel, nextModelId)
          }
        />
      ) : (
        <VariantPill modelId={baseModel} />
      );

    items.push({
      id: literalModels
        ? `key-model:${account.id}:${representative}`
        : `key-model:${account.id}:${group.label}:${group.sortVersion}`,
      label: [displayLabel, ...sortedVariants].join(" "),
      icon: ModelItemIcon,
      type: "action" as const,
      data: {
        isSelector: true,
        modelId: launchModel,
        groupModelIds: sortedVariants,
        labelContent,
        rightContent: trailing,
        testId: KEY_FIRST_MODEL_TEST_ID,
      },
      action: () => onCommit(account, launchModel),
    });
  }

  return items;
}
