import type { MobileModelOption } from "@src/modules/MobileRemote/connection/types";
import { buildGroupByModel } from "@src/scaffold/GlobalSpotlight/palettes/UnifiedModelPalette/modelSection";
import { resolveDefaultVariant } from "@src/util/defaultModelVariant";
import { compareModelsByVersion } from "@src/util/formatModelName";
import { groupModels } from "@src/util/modelGrouping";
import { resolveModelVariantFields } from "@src/util/modelVariants";

function resolveLaunchModelId(modelIds: string[]): string {
  const sortedVariants = [...modelIds].sort(compareModelsByVersion);
  const variantInfos = sortedVariants.map((modelId) =>
    resolveModelVariantFields(modelId)
  );
  const baseModel = variantInfos[0]?.base_model ?? sortedVariants[0];
  return (
    resolveDefaultVariant(baseModel, variantInfos, undefined) ??
    sortedVariants[0]
  );
}

/** One catalog row per model family so effort/fast variants stay in settings. */
export function collapseMobileModelOptions(
  options: MobileModelOption[]
): MobileModelOption[] {
  const byAccount = new Map<string, MobileModelOption[]>();
  for (const option of options) {
    const accountOptions = byAccount.get(option.accountId) ?? [];
    accountOptions.push(option);
    byAccount.set(option.accountId, accountOptions);
  }

  const collapsed: MobileModelOption[] = [];
  for (const accountOptions of byAccount.values()) {
    const optionById = new Map(
      accountOptions.map((option) => [option.id, option])
    );
    const groups = groupModels(accountOptions.map((option) => option.id));

    for (const group of groups) {
      const launchId = resolveLaunchModelId(group.models);
      const source =
        optionById.get(launchId) ?? optionById.get(group.models[0]);
      if (!source) continue;
      collapsed.push({ ...source, id: launchId });
    }
  }

  return collapsed;
}

export function mobileModelOptionsShareFamily(
  options: MobileModelOption[],
  modelIdA: string,
  modelIdB: string
): boolean {
  const family = buildGroupByModel(options.map((option) => option.id)).get(
    modelIdA
  );
  return family ? family.includes(modelIdB) : modelIdA === modelIdB;
}
