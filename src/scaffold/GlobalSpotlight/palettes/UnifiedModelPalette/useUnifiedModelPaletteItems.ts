import { useCallback, useMemo } from "react";

import { KEY_SOURCE } from "@src/api/tauri/session";
import { ORGII_ORCHESTRATOR } from "@src/assets/providers";
import type { AdvancedConfig } from "@src/features/SessionCreator/types";
import type { KeyVaultAccount } from "@src/hooks/keyVault/types";
import { isPairCompatible } from "@src/hooks/models/modelPairCompatibility";
import { accountHasModel } from "@src/hooks/models/useModelAccountLookup";
import type { RecentModelEntry } from "@src/store/session/recentModelEntriesAtom";
import { recentEntriesEquivalent } from "@src/store/session/recentModelEntriesAtom";
import { resolveDefaultVariant } from "@src/util/defaultModelVariant";
import { resolveModelVariantFields } from "@src/util/modelVariants";

import type { SpotlightItem } from "../../types";
import {
  MODEL_SECTION,
  buildGroupByModel,
  buildSectionHeader,
  entryMatchesActiveConfig,
  getActiveModelId,
} from "./modelSection";
import {
  buildAllModelItems,
  buildModelSelectionSpotlightItem,
} from "./modelSelectionItems";
import { buildSourceItems } from "./sourceItems";
import type { SourceOption } from "./types";
import type { UnifiedModelPaletteData } from "./useUnifiedModelPaletteData";

interface UseUnifiedModelPaletteItemsParams {
  advancedConfig: AdvancedConfig;
  accounts: KeyVaultAccount[];
  accountLookup: UnifiedModelPaletteData["accountLookup"];
  orgiiModelSet: UnifiedModelPaletteData["orgiiModelSet"];
  orgiiCategoryIds: UnifiedModelPaletteData["orgiiCategoryIds"];
  orgiiPoolEnabled: boolean;
  recentEntries: RecentModelEntry[];
  sourceOptions: SourceOption[];
  selectedModelId: string | null;
  selectedGroupModelIds: string[];
  handleModelSelect: (
    modelId: string,
    modelLabel: string,
    groupModelIds: string[]
  ) => void;
  handleModelPreview?: (
    modelId: string,
    modelLabel: string,
    groupModelIds: string[]
  ) => void;
  handleSourceSelect: (source: SourceOption) => void;
  handleRecentSelect: (entry: RecentModelEntry) => void;
  reselectVariant: (entry: RecentModelEntry, nextModelId: string) => void;
  saveKey: UnifiedModelPaletteData["saveKey"];
  modelAliasVersion: number;
  tCommon: (key: string) => string;
}

export function useUnifiedModelPaletteItems({
  advancedConfig,
  accounts,
  accountLookup,
  orgiiModelSet,
  orgiiCategoryIds,
  orgiiPoolEnabled,
  recentEntries,
  sourceOptions,
  selectedModelId,
  selectedGroupModelIds,
  handleModelSelect,
  handleModelPreview,
  handleSourceSelect,
  handleRecentSelect,
  reselectVariant,
  saveKey,
  modelAliasVersion,
  tCommon,
}: UseUnifiedModelPaletteItemsParams) {
  const compatibleRecentEntries = useMemo(
    () =>
      recentEntries.filter((entry) =>
        isPairCompatible(entry, {
          accounts,
          orgiiPoolEnabled,
          orgiiModelSet,
          orgiiCategoryIds,
        })
      ),
    [recentEntries, accounts, orgiiPoolEnabled, orgiiModelSet, orgiiCategoryIds]
  );

  const persistDefaultVariantForAccount = useCallback(
    (accountId: string, baseModel: string, modelId: string) => {
      const account = accounts.find((entry) => entry.id === accountId);
      if (!account) return;

      const nextDefaults = (account.defaultVariants ?? []).filter(
        (variant) => variant.base_model !== baseModel
      );
      nextDefaults.push({ base_model: baseModel, model: modelId });

      void saveKey({
        id: account.id,
        agent_type: account.modelType,
        default_variants: nextDefaults,
      });
    },
    [accounts, saveKey]
  );

  const groupByModel = useMemo(
    () => buildGroupByModel(accountLookup.keys()),
    [accountLookup]
  );

  const activeModelId = getActiveModelId(advancedConfig);

  const MAX_RECENT_ITEMS = 3;

  const currentModelEntry = useMemo((): RecentModelEntry | null => {
    if (!activeModelId) return null;

    const fromRecents = compatibleRecentEntries.find((entry) =>
      entryMatchesActiveConfig(entry, advancedConfig)
    );
    if (fromRecents) return fromRecents;

    const selectedAccount = advancedConfig.selectedAccountId
      ? accounts.find((entry) => entry.id === advancedConfig.selectedAccountId)
      : undefined;
    const activeModelFamily = groupByModel.get(activeModelId) ?? [
      activeModelId,
    ];
    const inferredAccount =
      selectedAccount ??
      accounts.find((account) => {
        const selectedModelType =
          advancedConfig.selectedSourceModelType ??
          advancedConfig.listingModelType;
        if (selectedModelType && account.modelType !== selectedModelType) {
          return false;
        }
        if (
          advancedConfig.selectedSourceLabel &&
          account.name !== advancedConfig.selectedSourceLabel
        ) {
          return false;
        }
        return activeModelFamily.some((modelId) =>
          accountHasModel(account, modelId)
        );
      });

    return {
      modelId: activeModelId,
      sourceType: advancedConfig.keySource ?? KEY_SOURCE.OWN,
      accountId: inferredAccount?.id ?? advancedConfig.selectedAccountId,
      accountName: advancedConfig.selectedSourceLabel ?? inferredAccount?.name,
      modelType:
        advancedConfig.selectedSourceModelType ??
        advancedConfig.listingModelType ??
        inferredAccount?.modelType ??
        ORGII_ORCHESTRATOR,
      cliAgentType: advancedConfig.cliAgentType,
    };
  }, [
    activeModelId,
    advancedConfig,
    compatibleRecentEntries,
    accounts,
    groupByModel,
  ]);

  const recentEntriesForDisplay = useMemo((): RecentModelEntry[] => {
    const entries: RecentModelEntry[] = [];

    const tryAdd = (entry: RecentModelEntry) => {
      if (
        entries.some((existing) => recentEntriesEquivalent(existing, entry))
      ) {
        return;
      }
      entries.push(entry);
    };

    if (currentModelEntry) {
      tryAdd(currentModelEntry);
    }
    for (const entry of compatibleRecentEntries) {
      tryAdd(entry);
      if (entries.length >= MAX_RECENT_ITEMS) break;
    }
    return entries;
  }, [compatibleRecentEntries, currentModelEntry]);

  const recentItems = useMemo((): SpotlightItem[] => {
    return recentEntriesForDisplay.map((entry, index) => {
      const isCurrentSelection = entryMatchesActiveConfig(
        entry,
        advancedConfig
      );
      return buildModelSelectionSpotlightItem({
        entry,
        section: MODEL_SECTION.RECENT,
        idPrefix: isCurrentSelection ? "recent-current" : `recent-${index}`,
        isCurrentSelection,
        accounts,
        groupByModel,
        onSelect: handleRecentSelect,
        persistDefaultVariantForAccount,
        onReselectVariant: isCurrentSelection ? reselectVariant : undefined,
        modelAliasVersion,
      });
    });
  }, [
    accounts,
    advancedConfig,
    groupByModel,
    handleRecentSelect,
    modelAliasVersion,
    persistDefaultVariantForAccount,
    recentEntriesForDisplay,
    reselectVariant,
  ]);

  const resolveGroupLaunchModel = useCallback(
    (sortedVariants: string[]): string => {
      if (sortedVariants.length === 0) return "";

      const variantInfos = sortedVariants.map((modelId) =>
        resolveModelVariantFields(modelId)
      );
      const baseModel = variantInfos[0]?.base_model ?? sortedVariants[0];
      const variantModelSet = new Set(sortedVariants);

      let persistedModel: string | undefined;
      for (const account of accounts) {
        const match = (account.defaultVariants ?? []).find(
          (variant) =>
            variant.base_model === baseModel &&
            variantModelSet.has(variant.model)
        );
        if (match) {
          persistedModel = match.model;
          break;
        }
      }

      return (
        resolveDefaultVariant(baseModel, variantInfos, persistedModel) ??
        sortedVariants[0]
      );
    },
    [accounts]
  );

  const allModelItems = useMemo(
    (): SpotlightItem[] =>
      buildAllModelItems({
        accountLookup,
        accounts,
        handleModelSelect,
        modelAliasVersion,
        resolveGroupLaunchModel,
      }),
    [
      accountLookup,
      accounts,
      handleModelSelect,
      modelAliasVersion,
      resolveGroupLaunchModel,
    ]
  );

  const sideMenuModelItems = useMemo(
    (): SpotlightItem[] =>
      buildAllModelItems({
        accountLookup,
        accounts,
        handleModelSelect: handleModelPreview ?? handleModelSelect,
        modelAliasVersion,
        resolveGroupLaunchModel,
      }),
    [
      accountLookup,
      accounts,
      handleModelPreview,
      handleModelSelect,
      modelAliasVersion,
      resolveGroupLaunchModel,
    ]
  );

  const sourceItems = useMemo(
    (): SpotlightItem[] =>
      buildSourceItems({
        sourceOptions,
        selectedModelId,
        selectedGroupModelIds,
        handleSourceSelect,
        accounts,
        persistDefaultVariantForAccount,
      }),
    [
      sourceOptions,
      selectedModelId,
      selectedGroupModelIds,
      handleSourceSelect,
      accounts,
      persistDefaultVariantForAccount,
    ]
  );

  const recentHeader = useMemo(
    () =>
      buildSectionHeader(
        MODEL_SECTION.RECENT,
        tCommon("selectors.modelSelector.recentModels")
      ),
    [tCommon]
  );

  const allHeader = useMemo(
    () =>
      buildSectionHeader(
        MODEL_SECTION.ALL,
        tCommon("selectors.modelSelector.allModels")
      ),
    [tCommon]
  );

  const rawItems = useMemo((): SpotlightItem[] => {
    const items: SpotlightItem[] = [];
    if (recentItems.length > 0) {
      items.push(recentHeader);
      items.push(...recentItems);
    }
    items.push(allHeader);
    items.push(...allModelItems);
    return items;
  }, [recentItems, allModelItems, recentHeader, allHeader]);

  const sideMenuRawItems = useMemo((): SpotlightItem[] => {
    const items: SpotlightItem[] = [];
    if (recentItems.length > 0) {
      items.push(recentHeader);
      items.push(...recentItems);
    }
    items.push(allHeader);
    items.push(...sideMenuModelItems);
    return items;
  }, [recentItems, sideMenuModelItems, recentHeader, allHeader]);

  return {
    rawItems,
    sideMenuRawItems,
    sideMenuModelItems,
    recentItems,
    allModelItems,
    recentHeader,
    allHeader,
    sourceItems,
  };
}
