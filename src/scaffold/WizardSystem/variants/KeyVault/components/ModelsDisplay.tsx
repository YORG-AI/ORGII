/**
 * ModelsDisplay Component (Wizard)
 *
 * Thin wrapper around the shared ModelTable for use in the KeyVaultWizard.
 * The table owns its own bg-fill-2 card and search/filter bar, so the
 * wrapper deliberately does not render an extra header — the grouping +
 * scope filter + status filter inside the table already convey the same
 * information. When `onCustomModelsChange` is set, catalog rows and
 * user-added custom rows share one unified flat table.
 */
import React, { useMemo } from "react";

import ModelTable from "@src/modules/MainApp/Integrations/KeyVault/shared/ModelTable";
import type {
  ModelTableModelAlias,
  ModelTableVariantInfo,
} from "@src/types/modelTable";

export interface ModelsDisplayProps {
  models: string[];
  enabledModels: string[];
  onEnabledModelsChange?: (enabledModels: string[]) => void;
  className?: string;
  customModels?: string[];
  modelAliases?: ModelTableModelAlias[];
  modelVariants?: ModelTableVariantInfo[];
  onCustomModelsChange?: (models: string[]) => void;
  onModelAliasesChange?: (aliases: ModelTableModelAlias[]) => void;
  onTestModel?: (
    model: string
  ) => Promise<{ available: boolean; message: string }>;
  defaultVariants?: ReadonlyArray<{ base_model: string; model: string }>;
  onChangeDefaultVariant?: (baseModel: string, model: string) => void;
}

const ModelsDisplay: React.FC<ModelsDisplayProps> = ({
  models,
  enabledModels,
  onEnabledModelsChange,
  className = "",
  customModels,
  modelAliases,
  modelVariants,
  onCustomModelsChange,
  onModelAliasesChange,
  onTestModel,
  defaultVariants,
  onChangeDefaultVariant,
}) => {
  const enabledSet = useMemo(() => new Set(enabledModels), [enabledModels]);
  const unifiedMode = onCustomModelsChange != null;

  if (!unifiedMode && models.length === 0) return null;

  const handleToggle = (model: string) => {
    if (!onEnabledModelsChange) return;
    const nextEnabled = new Set(enabledModels);
    if (enabledSet.has(model)) {
      nextEnabled.delete(model);
    } else {
      nextEnabled.add(model);
    }
    onEnabledModelsChange([...nextEnabled]);
  };

  return (
    <div className={className}>
      <ModelTable
        models={models}
        enabledModels={enabledModels}
        onToggleModel={handleToggle}
        onEnabledModelsChange={onEnabledModelsChange}
        defaultView="group"
        customModels={unifiedMode ? customModels : undefined}
        modelAliases={unifiedMode ? modelAliases : undefined}
        modelVariants={modelVariants}
        onCustomModelsChange={onCustomModelsChange}
        onModelAliasesChange={onModelAliasesChange}
        onTestModel={unifiedMode ? onTestModel : undefined}
        defaultVariants={defaultVariants}
        onChangeDefaultVariant={onChangeDefaultVariant}
      />
    </div>
  );
};

export default ModelsDisplay;
