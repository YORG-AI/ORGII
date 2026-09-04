import React from "react";

import { KEY_SOURCE } from "@src/api/tauri/session";
import ModelIcon from "@src/components/ModelIcon";
import type { KeyVaultAccount } from "@src/hooks/keyVault/types";
import { accountHasModel } from "@src/hooks/models/useModelAccountLookup";
import { resolveDefaultVariant } from "@src/util/defaultModelVariant";
import {
  parseModelVariant,
  resolveModelVariantFields,
} from "@src/util/modelVariants";

import type { SpotlightItem } from "../../types";
import { VariantPill } from "./VariantPill";
import type { SourceOption } from "./types";

/** The {@link SourceOption} a Key Vault account is launched through. */
export function toSourceOption(account: KeyVaultAccount): SourceOption {
  return {
    id: account.id,
    label: account.name,
    modelType: account.modelType,
    type: KEY_SOURCE.OWN,
    accountId: account.id,
    nativeHarnessType: account.nativeHarnessType,
  };
}

export function buildSourceOptions(
  modelIds: string[],
  accounts: KeyVaultAccount[],
  isCliAgent: boolean
): SourceOption[] {
  const options: SourceOption[] = [];
  const variantSet = new Set(modelIds.filter(Boolean));

  const readyAccounts = accounts.filter(
    (account) => account.status === "ready" && account.hasKey
  );
  for (const account of readyAccounts) {
    const hasConcreteModelFilter = variantSet.size > 0;
    const hasAnyVariant =
      account.availableModels && account.availableModels.length > 0
        ? [...variantSet].some((modelId) => accountHasModel(account, modelId))
        : false;
    const modelMatches = hasConcreteModelFilter ? hasAnyVariant : isCliAgent;
    if (modelMatches) {
      options.push(toSourceOption(account));
    }
  }

  return options;
}

interface BuildSourceItemsParams {
  sourceOptions: SourceOption[];
  selectedModelId: string | null;
  selectedGroupModelIds: string[];
  accounts: KeyVaultAccount[];
  handleSourceSelect: (source: SourceOption) => void;
  persistDefaultVariantForAccount: (
    accountId: string,
    baseModel: string,
    modelId: string
  ) => void;
}

export function buildSourceItems({
  sourceOptions,
  selectedModelId,
  selectedGroupModelIds,
  accounts,
  handleSourceSelect,
  persistDefaultVariantForAccount,
}: BuildSourceItemsParams): SpotlightItem[] {
  const previewVariantInfo = selectedModelId
    ? parseModelVariant(selectedModelId)
    : null;
  const previewBaseModel =
    previewVariantInfo?.baseModel ?? selectedModelId ?? undefined;

  const accountById = new Map(accounts.map((account) => [account.id, account]));

  return sourceOptions.map((source) => {
    const SourceIcon = () => (
      <ModelIcon agentType={source.modelType} size={14} />
    );

    const sourceAccount = source.accountId
      ? accountById.get(source.accountId)
      : undefined;

    const accountVariantIds = sourceAccount
      ? selectedGroupModelIds.filter((modelId) =>
          accountHasModel(sourceAccount, modelId)
        )
      : [];

    let accountEffectiveModelId: string | undefined;
    if (sourceAccount && previewBaseModel && accountVariantIds.length > 0) {
      const persisted = (sourceAccount.defaultVariants ?? []).find(
        (entry) =>
          entry.base_model === previewBaseModel &&
          accountVariantIds.includes(entry.model)
      )?.model;
      const variantInfos = accountVariantIds.map((modelId) =>
        resolveModelVariantFields(modelId)
      );
      accountEffectiveModelId =
        resolveDefaultVariant(previewBaseModel, variantInfos, persisted) ??
        accountVariantIds[0];
    }

    const handleApply =
      sourceAccount && previewBaseModel
        ? (nextModelId: string) =>
            persistDefaultVariantForAccount(
              sourceAccount.id,
              previewBaseModel,
              nextModelId
            )
        : undefined;

    const hasMultipleVariants = accountVariantIds.length > 1;
    const trailing: React.ReactNode = (() => {
      if (!sourceAccount || accountVariantIds.length === 0) return null;
      if (hasMultipleVariants && accountEffectiveModelId) {
        return (
          <VariantPill
            modelId={accountEffectiveModelId}
            groupModelIds={accountVariantIds}
            onApply={handleApply}
          />
        );
      }
      return <VariantPill modelId={previewBaseModel ?? ""} />;
    })();

    return {
      id: source.id,
      label: source.label,
      icon: SourceIcon,
      type: "action" as const,
      data: {
        isSelector: true,
        rightContent: trailing,
        testId: "unified-model-source-option",
        sourceAccountId: source.accountId,
        sourceModelType: source.modelType,
        sourceType: source.type,
      },
      action: () => handleSourceSelect(source),
    };
  });
}
