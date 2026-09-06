import { useTranslation } from "react-i18next";

import { useModelAliasRegistryVersion } from "@src/hooks/models/modelAliasRegistry";

import type { UnifiedModelPaletteProps } from "./types";
import { useUnifiedModelPaletteData } from "./useUnifiedModelPaletteData";
import { useUnifiedModelPaletteItems } from "./useUnifiedModelPaletteItems";
import { useUnifiedModelPaletteSelection } from "./useUnifiedModelPaletteSelection";

export { MODEL_SECTION } from "./modelSection";

export function useUnifiedModelPalette({
  isOpen,
  onClose,
  advancedConfig,
  onConfigChange,
  dispatchCategoryOverride,
  cliAgentTypeOverride,
  keyFirst = false,
}: Pick<
  UnifiedModelPaletteProps,
  | "isOpen"
  | "onClose"
  | "advancedConfig"
  | "onConfigChange"
  | "dispatchCategoryOverride"
  | "cliAgentTypeOverride"
> & {
  /**
   * Run the two-column flow key → model instead of model → key. Only the
   * spotlight palette exposes the toggle; the dropdown variant stays
   * model-first.
   */
  keyFirst?: boolean;
}) {
  const { t: tCommon } = useTranslation();
  const modelAliasVersion = useModelAliasRegistryVersion();

  const {
    accounts,
    accountLookup,
    orgiiModelSet,
    orgiiCategoryIds,
    orgiiPoolEnabled,
    dispatchCategory,
    recentEntries,
    recordRecent,
    saveKey,
    accountsLoading,
    accountsError,
    refreshAllModels,
    refreshingAllModels,
  } = useUnifiedModelPaletteData({
    isOpen,
    dispatchCategoryOverride,
    cliAgentTypeOverride,
  });

  const isCliAgent = dispatchCategory === "cli_agent";

  const {
    activeColumn,
    setActiveColumn,
    selectedModelId,
    selectedGroupModelIds,
    selectedSourceIndex,
    setSelectedSourceIndex,
    sourceOptions,
    previewModel,
    handleModelPreview,
    handleModelSelect,
    handleSourceSelect,
    handleRecentSelect,
    reselectVariant,
    handleBack,
    selectedKeyAccountId,
    previewKey,
    handleKeySelect,
    handleKeyModelSelect,
  } = useUnifiedModelPaletteSelection({
    isOpen,
    isCliAgent,
    keyFirst,
    accountLookupSize: accountLookup.size,
    accounts,
    advancedConfig,
    onConfigChange,
    onClose,
    recordRecent,
  });

  const {
    rawItems,
    sideMenuRawItems,
    sideMenuModelItems,
    recentItems,
    allModelItems,
    recentHeader,
    allHeader,
    sourceItems,
    keyItems,
    keyModelItems,
  } = useUnifiedModelPaletteItems({
    advancedConfig,
    accounts,
    accountLookup,
    orgiiModelSet,
    orgiiCategoryIds,
    orgiiPoolEnabled,
    isCliAgent,
    recentEntries,
    sourceOptions,
    selectedModelId,
    selectedGroupModelIds,
    handleModelSelect,
    handleModelPreview,
    handleSourceSelect,
    handleRecentSelect,
    reselectVariant,
    selectedKeyAccountId,
    handleKeySelect,
    handleKeyModelSelect,
    saveKey,
    modelAliasVersion,
    tCommon,
  });

  return {
    activeColumn,
    setActiveColumn,
    selectedModelId,
    selectedSourceIndex,
    setSelectedSourceIndex,
    rawItems,
    sideMenuRawItems,
    sideMenuModelItems,
    recentItems,
    allModelItems,
    recentHeader,
    allHeader,
    sourceItems,
    keyItems,
    keyModelItems,
    selectedKeyAccountId,
    previewKey,
    previewModel,
    handleModelPreview,
    handleBack,
    accountsLoading,
    accountsError,
    refreshAllModels,
    refreshingAllModels,
    tCommon,
  };
}
