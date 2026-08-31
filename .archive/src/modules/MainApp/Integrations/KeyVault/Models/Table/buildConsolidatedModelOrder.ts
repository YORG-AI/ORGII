/**
 * Builds the same consolidated model row order as ModelsTableSection (no optimistic toggles).
 * Used for preview-panel prev/next navigation so keys align with the models table.
 */
import { formatModelAgentType } from "@src/assets/providers";
import { ORGII_ORCHESTRATOR } from "@src/assets/providers/types";
import { ORGII_FALLBACK_TIERS } from "@src/config/orgiiCategories";
import type { KeyVaultAccount } from "@src/hooks/keyVault";
import { groupModels, isLegacyGroup } from "@src/util/modelGrouping";

import type {
  AvailableModelRow,
  ConsolidatedModelRow,
  ModelSourceEntry,
} from "../../../Tables/types";

const TOKEN_MARKET_SOURCE = "Token Market";

function buildOlderModelSet(allModelNames: string[]): Set<string> {
  const groups = groupModels(allModelNames);
  const set = new Set<string>();
  for (const group of groups) {
    if (isLegacyGroup(group)) {
      for (const model of group.models) set.add(model);
    }
  }
  return set;
}

export function buildConsolidatedModelRowsSnapshot(
  accounts: KeyVaultAccount[]
): ConsolidatedModelRow[] {
  const allModelNames = accounts.flatMap((acc) => acc.availableModels ?? []);
  const olderModelSet = buildOlderModelSet(allModelNames);

  const sourceMap = new Map<string, Map<string, ModelSourceEntry>>();

  for (const acc of accounts) {
    const source = formatModelAgentType(acc.modelType);
    const enabled = acc.enabled
      ? new Set(acc.enabledModels ?? [])
      : new Set<string>();
    for (const model of acc.availableModels ?? []) {
      let modelSources = sourceMap.get(model);
      if (!modelSources) {
        modelSources = new Map();
        sourceMap.set(model, modelSources);
      }
      const isEnabled = enabled.has(model);
      const existing = modelSources.get(acc.modelType);
      if (existing) {
        existing.keys += 1;
        if (isEnabled) {
          existing.enabledKeys += 1;
          existing.enabled = true;
        }
      } else {
        modelSources.set(acc.modelType, {
          source,
          modelType: acc.modelType,
          keys: 1,
          enabledKeys: isEnabled ? 1 : 0,
          enabled: isEnabled,
        });
      }
    }
  }

  const rows: ConsolidatedModelRow[] = [];
  for (const [model, sourcesMap] of sourceMap) {
    const sources = Array.from(sourcesMap.values());
    const allEnabled = sources.every((src) => src.enabledKeys === src.keys);
    const someEnabled = sources.some((src) => src.enabledKeys > 0);
    rows.push({
      model,
      sources,
      totalKeys: sources.reduce((sum, src) => sum + src.keys, 0),
      allEnabled,
      someEnabled,
      isOlder: olderModelSet.has(model),
    });
  }

  const orgiiRows: ConsolidatedModelRow[] = ORGII_FALLBACK_TIERS.map(
    (category) => ({
      model: `orgii:${category.id}`,
      sources: [
        {
          source: TOKEN_MARKET_SOURCE,
          modelType: ORGII_ORCHESTRATOR,
          keys: 0,
          enabledKeys: 0,
          enabled: true,
        },
      ],
      totalKeys: 0,
      allEnabled: true,
      someEnabled: true,
      isOlder: false,
    })
  );

  const sortedUserRows = [...rows].sort(
    (rowA, rowB) =>
      Number(
        rowA.someEnabled === rowB.someEnabled ? 0 : rowA.someEnabled ? -1 : 1
      ) || rowA.model.localeCompare(rowB.model)
  );

  return [...orgiiRows, ...sortedUserRows];
}

export function consolidatedRowToAvailableModelRow(
  row: ConsolidatedModelRow
): AvailableModelRow {
  const first = row.sources[0];
  return {
    model: row.model,
    source: first.source,
    modelType: first.modelType,
    keys: row.totalKeys,
    enabled: row.someEnabled,
    isOlder: row.isOlder,
  };
}
