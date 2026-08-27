import { isOrgiiTierModel } from "@src/config/orgiiCategories";
import type { KeyVaultAccount } from "@src/hooks/keyVault";
import type { ModelTableVariantInfo } from "@src/types/modelTable";
import {
  type ModelGroup,
  groupModels,
  isLegacyGroup,
  isUncategorizedModelGroup,
} from "@src/util/modelGrouping";
import {
  groupHasParsedModelVariants,
  resolveModelVariantFields,
} from "@src/util/modelVariants";

import type {
  ConsolidatedModelRow,
  ModelSourceEntry,
} from "../../../Tables/types";

/** Single group row for all ORGII tier models (Turbo / Pro / Pro max). */
export const INTEGRATIONS_ORGII_MARKET_GROUP_KEY = "ORGII_MARKET";

export type IntegrationsModelGroupEra = "current" | "older";

export interface IntegrationsModelGroupRow {
  key: string;
  /** Display label: ModelGroup.label; ORGII bucket uses i18n orgiiMarketGroup */
  label: string;
  models: ConsolidatedModelRow[];
  era: IntegrationsModelGroupEra;
  isOrgiiGroup: boolean;
  sortVersion: number;
}

function modelGroupKey(
  group: ModelGroup,
  era: IntegrationsModelGroupEra
): string {
  if (isUncategorizedModelGroup(group) && group.models.length === 1) {
    return `other::${group.models[0]}`;
  }
  return `${era}::${group.label}::${group.sortVersion}`;
}

function resolveGroupEra(
  group: ModelGroup,
  groupRows: ConsolidatedModelRow[]
): IntegrationsModelGroupEra {
  if (isUncategorizedModelGroup(group)) {
    return groupRows.some((row) => row.isOlder) ? "older" : "current";
  }
  return isLegacyGroup(group) ? "older" : "current";
}

/**
 * Partition consolidated rows like ModelTable group view: {@link groupModels} buckets
 * (versioned model families), not provider tabs. All ORGII tier rows (Turbo / Pro /
 * Pro max) are grouped under one ORGII Market row.
 */
export function buildIntegrationsModelGroups(
  rows: ConsolidatedModelRow[]
): IntegrationsModelGroupRow[] {
  const rowByModel = new Map<string, ConsolidatedModelRow>();
  for (const row of rows) {
    rowByModel.set(row.model, row);
  }

  const orgiiRows: ConsolidatedModelRow[] = [];
  const normalRows: ConsolidatedModelRow[] = [];
  for (const row of rows) {
    if (isOrgiiTierModel(row.model)) orgiiRows.push(row);
    else normalRows.push(row);
  }

  orgiiRows.sort((rowA, rowB) => rowA.model.localeCompare(rowB.model));

  const result: IntegrationsModelGroupRow[] = [];

  if (orgiiRows.length > 0) {
    result.push({
      key: INTEGRATIONS_ORGII_MARKET_GROUP_KEY,
      label: "",
      models: orgiiRows,
      era: "current",
      isOrgiiGroup: true,
      sortVersion: Number.MAX_SAFE_INTEGER,
    });
  }

  const normalModelIds = [...new Set(normalRows.map((row) => row.model))];
  for (const group of groupModels(normalModelIds)) {
    const groupRows = group.models
      .map((modelId) => rowByModel.get(modelId))
      .filter((row): row is ConsolidatedModelRow => row != null);
    groupRows.sort((rowA, rowB) => rowA.model.localeCompare(rowB.model));
    const era = resolveGroupEra(group, groupRows);
    result.push({
      key: modelGroupKey(group, era),
      label: group.label,
      models: groupRows,
      era,
      isOrgiiGroup: false,
      sortVersion: group.sortVersion,
    });
  }

  return result;
}

/** Enabled groups first, then by model generation (newest first). */
export function sortIntegrationsModelGroups(
  groups: IntegrationsModelGroupRow[]
): IntegrationsModelGroupRow[] {
  return [...groups].sort((rowA, rowB) => {
    const enabledDiff =
      Number(groupSomeEnabled(rowB)) - Number(groupSomeEnabled(rowA));
    if (enabledDiff !== 0) return enabledDiff;
    return rowB.sortVersion - rowA.sortVersion;
  });
}

export function getIntegrationsGroupRowKey(
  group: IntegrationsModelGroupRow
): string {
  return group.key;
}

export function aggregateGroupSources(
  models: ConsolidatedModelRow[]
): ModelSourceEntry[] {
  const sourceMap = new Map<string, ModelSourceEntry>();
  for (const row of models) {
    for (const src of row.sources) {
      const existing = sourceMap.get(src.modelType);
      if (existing) {
        existing.keys += src.keys;
        existing.enabledKeys += src.enabledKeys;
        existing.enabled = existing.enabledKeys > 0;
      } else {
        sourceMap.set(src.modelType, { ...src });
      }
    }
  }
  return Array.from(sourceMap.values());
}

export function groupSomeEnabled(group: IntegrationsModelGroupRow): boolean {
  return group.models.some((row) => row.someEnabled);
}

/** Apply a model-group on/off to one account's enabled_models set (all variants in group). */
export function applyModelGroupToEnabledSet(
  currentEnabled: Iterable<string>,
  groupModelIds: readonly string[],
  availableModels: readonly string[],
  checked: boolean
): string[] {
  const groupModelSet = new Set(groupModelIds);
  const next = new Set(currentEnabled);
  for (const model of availableModels) {
    if (!groupModelSet.has(model)) continue;
    if (checked) {
      next.add(model);
    } else {
      next.delete(model);
    }
  }
  return [...next];
}

export function getModelGroupEnableSummary(
  groupModelIds: readonly string[],
  enabledModels: Iterable<string>
): { allEnabled: boolean; anyEnabled: boolean; mixed: boolean } {
  const enabledSet = new Set(enabledModels);
  const allEnabled = groupModelIds.every((model) => enabledSet.has(model));
  const anyEnabled = groupModelIds.some((model) => enabledSet.has(model));
  return {
    allEnabled,
    anyEnabled,
    mixed: anyEnabled && !allEnabled,
  };
}

export function syncAccountEnabledForEnabledModels(
  account: KeyVaultAccount,
  enabledModels: readonly string[],
  isAccountEnabled: (account: KeyVaultAccount) => boolean,
  onToggleAccount?: (account: KeyVaultAccount, enabled: boolean) => void
): void {
  if (!onToggleAccount) return;

  const anyModelEnabled = enabledModels.length > 0;
  const accountEnabled = isAccountEnabled(account);

  if (!anyModelEnabled && accountEnabled) {
    onToggleAccount(account, false);
  } else if (anyModelEnabled && !accountEnabled) {
    onToggleAccount(account, true);
  }
}

export function buildVariantsByModelFromAccounts(
  accounts: KeyVaultAccount[]
): Map<string, ModelTableVariantInfo> {
  const backendByModel = new Map<string, ModelTableVariantInfo>();

  for (const account of accounts) {
    for (const variant of account.modelVariants ?? []) {
      if (!backendByModel.has(variant.model)) {
        backendByModel.set(variant.model, {
          model: variant.model,
          base_model: variant.base_model,
          reasoning: variant.reasoning,
          fast: variant.fast,
          context_window: variant.context_window,
        });
      }
    }
  }

  const allModels = new Set<string>([
    ...accounts.flatMap((account) => account.availableModels ?? []),
    ...backendByModel.keys(),
  ]);

  const map = new Map<string, ModelTableVariantInfo>();
  for (const model of allModels) {
    map.set(model, resolveModelVariantFields(model, backendByModel.get(model)));
  }
  return map;
}

export function integrationsGroupHasParsedVariants(
  group: IntegrationsModelGroupRow,
  _variantsByModel: Map<string, ModelTableVariantInfo>
): boolean {
  if (group.isOrgiiGroup) return false;
  return groupHasParsedModelVariants(group.models.map((row) => row.model));
}

export function integrationsGroupShowsVariantsTab(
  group: IntegrationsModelGroupRow,
  variantsByModel: Map<string, ModelTableVariantInfo>
): boolean {
  if (group.isOrgiiGroup) return group.models.length > 1;
  if (group.models.length > 1) return true;
  return integrationsGroupHasParsedVariants(group, variantsByModel);
}
