import React from "react";

import ModelIcon from "@src/components/ModelIcon";
import type { KeyVaultAccount } from "@src/hooks/keyVault/types";
import { getModelAliasDisplayName } from "@src/hooks/models/modelAliasRegistry";
import { accountHasModel } from "@src/hooks/models/useModelAccountLookup";
import type { RecentModelEntry } from "@src/store/session/recentModelEntriesAtom";
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
import { MODEL_SECTION, type ModelSection } from "./modelSection";

interface BuildModelSelectionRowParams {
  entry: RecentModelEntry;
  section: ModelSection;
  idPrefix: string;
  isCurrentSelection: boolean;
  accounts: KeyVaultAccount[];
  groupByModel: Map<string, readonly string[]>;
  onSelect: (entry: RecentModelEntry) => void;
  persistDefaultVariantForAccount: (
    accountId: string,
    baseModel: string,
    modelId: string
  ) => void;
  /**
   * Only supplied for the current-selection row. When the user edits the
   * effort/variant of the model in use, re-select that variant as the active
   * model so the displayed pill AND the model the session launches with both
   * reflect the change immediately (the dispatch path uses the stored concrete
   * model id, not the per-key default variant).
   */
  onReselectVariant?: (entry: RecentModelEntry, nextModelId: string) => void;
  modelAliasVersion: number;
}

export function buildModelSelectionSpotlightItem({
  entry,
  section,
  idPrefix,
  isCurrentSelection,
  accounts,
  groupByModel,
  onSelect,
  persistDefaultVariantForAccount,
  onReselectVariant,
  modelAliasVersion,
}: BuildModelSelectionRowParams): SpotlightItem {
  void modelAliasVersion;
  const sourceName = entry.accountName ?? entry.modelType;
  const recentAccount = entry.accountId
    ? accounts.find((account) => account.id === entry.accountId)
    : undefined;
  const family = groupByModel.get(entry.modelId) ?? [entry.modelId];
  const concreteModelDisplay =
    getModelAliasDisplayName(entry.modelId) ??
    formatModelNameFull(entry.modelId);
  const groupedModel = groupModels([...family])[0];
  const modelDisplay =
    groupedModel && groupedModel.label !== "Other"
      ? groupedModel.label
      : concreteModelDisplay;
  const searchableLabel = `${sourceName} ${modelDisplay} ${concreteModelDisplay} ${entry.modelId}`;

  const selectedTextClassName = "text-text-1";
  const selectedMutedTextClassName = "text-text-2";
  const selectedDividerClassName = "text-text-3";

  const labelContent = (
    <>
      <span className={`shrink-0 ${selectedMutedTextClassName}`}>
        {sourceName}
      </span>
      <span className={`mx-0.5 shrink-0 ${selectedDividerClassName}`}>›</span>
      <span className="shrink-0 text-text-1">
        <ModelIcon modelName={entry.modelId} size={14} />
      </span>
      <span
        className={`min-w-0 truncate font-semibold ${selectedTextClassName}`}
      >
        {modelDisplay}
      </span>
    </>
  );

  const AccountListIcon = () => (
    <ModelIcon agentType={entry.modelType} size={14} />
  );
  const accountFamilyIds = recentAccount
    ? family.filter((modelId) => accountHasModel(recentAccount, modelId))
    : [entry.modelId];

  const variant = parseModelVariant(entry.modelId);
  const previewBaseModel =
    variant?.baseModel ?? resolveModelVariantFields(entry.modelId).base_model;
  const persistedVariant =
    recentAccount && previewBaseModel
      ? (recentAccount.defaultVariants ?? []).find(
          (defaultVariant) =>
            defaultVariant.base_model === previewBaseModel &&
            accountFamilyIds.includes(defaultVariant.model)
        )?.model
      : undefined;
  const effectiveVariantModel =
    previewBaseModel && accountFamilyIds.length > 0
      ? (resolveDefaultVariant(
          previewBaseModel,
          accountFamilyIds.map((modelId) => resolveModelVariantFields(modelId)),
          persistedVariant
        ) ?? entry.modelId)
      : entry.modelId;
  const handleApply =
    recentAccount && previewBaseModel
      ? (nextModelId: string) => {
          persistDefaultVariantForAccount(
            recentAccount.id,
            previewBaseModel,
            nextModelId
          );
          // For the current selection, also make the in-use model become the
          // chosen variant so the pill + launched model update immediately.
          if (isCurrentSelection) {
            onReselectVariant?.(entry, nextModelId);
          }
        }
      : undefined;

  const accountHasMultipleVariants = accountFamilyIds.length > 1;
  const trailing: React.ReactNode =
    variant && accountHasMultipleVariants ? (
      <VariantPill
        modelId={effectiveVariantModel}
        groupModelIds={accountFamilyIds}
        onApply={handleApply}
      />
    ) : (
      <VariantPill modelId={variant?.baseModel ?? entry.modelId} />
    );

  return {
    id: `${idPrefix}:${entry.modelId}:${entry.accountId ?? entry.sourceType}`,
    label: searchableLabel,
    icon: AccountListIcon,
    type: "action" as const,
    data: {
      isSelector: true,
      isCurrentSelection,
      modelSection: section,
      modelId: entry.modelId,
      groupModelIds: accountFamilyIds,
      labelContent,
      rightContent: trailing,
      searchAlias: `${concreteModelDisplay} ${entry.modelId}`,
    },
    action: () => onSelect(entry),
  };
}

interface BuildAllModelItemsParams {
  accountLookup: ReadonlyMap<string, unknown>;
  accounts: KeyVaultAccount[];
  handleModelSelect: (
    modelId: string,
    modelLabel: string,
    groupModelIds: string[]
  ) => void;
  modelAliasVersion: number;
  resolveGroupLaunchModel: (sortedVariants: string[]) => string;
}

export function buildAllModelItems({
  accountLookup,
  accounts,
  handleModelSelect,
  modelAliasVersion,
  resolveGroupLaunchModel,
}: BuildAllModelItemsParams): SpotlightItem[] {
  void modelAliasVersion;

  const items: SpotlightItem[] = [];
  const modelIds = Array.from(accountLookup.keys());
  const groups = groupModels(modelIds);

  const getAccountCount = (modelIdsForRow: string[]) =>
    accounts.filter(
      (account) =>
        account.status === "ready" &&
        account.hasKey &&
        modelIdsForRow.some((modelId) => accountHasModel(account, modelId))
    ).length;

  const renderAccountCount = (count: number) => (
    <span className="text-[12px] text-text-3">{count}</span>
  );

  for (const group of groups) {
    const sortedVariants = [...group.models].sort(compareModelsByVersion);

    if (sortedVariants.length === 1) {
      const modelId = sortedVariants[0];
      const info = accountLookup.get(modelId);
      if (!info) continue;
      const aliasDisplayName = getModelAliasDisplayName(modelId);
      const displayLabel = aliasDisplayName ?? formatModelNameFull(modelId);

      void info;

      const ModelItemIcon = () => <ModelIcon modelName={modelId} size={14} />;
      const accountCount = getAccountCount([modelId]);

      const labelContent = aliasDisplayName ? (
        <>
          <span className="shrink-0 font-normal text-text-1">
            {displayLabel}
          </span>
          <span className="ml-1.5 min-w-0 truncate text-[12px] text-text-2">
            {modelId}
          </span>
        </>
      ) : (
        <span className="shrink-0 font-normal text-text-1">{displayLabel}</span>
      );

      items.push({
        id: modelId,
        label: displayLabel,
        icon: ModelItemIcon,
        type: "action" as const,
        data: {
          isSelector: true,
          modelSection: MODEL_SECTION.ALL,
          modelId,
          groupModelIds: [modelId],
          rightContent: renderAccountCount(accountCount),
          showDisclosureChevron: true,
          labelContent,
          searchAlias: aliasDisplayName ? modelId : undefined,
        },
        action: () => handleModelSelect(modelId, displayLabel, [modelId]),
      });
      continue;
    }

    const aliasParts: string[] = [];
    for (const modelId of sortedVariants) {
      const alias = getModelAliasDisplayName(modelId);
      if (alias) aliasParts.push(alias);
    }

    const representativeModel = sortedVariants[0];
    const GroupItemIcon = () => (
      <ModelIcon modelName={representativeModel} size={14} />
    );

    const labelContent = (
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="shrink-0 font-normal text-text-1">{group.label}</span>
      </span>
    );

    const searchableLabel = [
      group.label,
      ...aliasParts,
      ...sortedVariants,
    ].join(" ");

    const launchModel = resolveGroupLaunchModel(sortedVariants);
    const accountCount = getAccountCount(sortedVariants);

    items.push({
      id: `group:${group.label}:${group.sortVersion}`,
      label: searchableLabel,
      icon: GroupItemIcon,
      type: "action" as const,
      data: {
        isSelector: true,
        modelSection: MODEL_SECTION.ALL,
        modelId: launchModel,
        groupModelIds: sortedVariants,
        labelContent,
        rightContent: renderAccountCount(accountCount),
        showDisclosureChevron: true,
      },
      action: () =>
        handleModelSelect(
          launchModel,
          getModelAliasDisplayName(launchModel) ??
            formatModelNameFull(launchModel),
          sortedVariants
        ),
    });
  }

  return items;
}
