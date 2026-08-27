import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { SelectOption } from "@src/components/Select";
import type { SettingsTableColumn } from "@src/components/SettingsTable";
import type {
  ModelTableModelAlias,
  ModelTableVariantInfo,
} from "@src/types/modelTable";
import type { ModelGroup } from "@src/util/modelGrouping";

import {
  buildFlatCatalogColumns,
  buildFlatUnifiedColumns,
} from "./modelTableFlatColumns";
import { buildGroupColumns } from "./modelTableGroupColumns";
import type { FlatRow, GroupRow } from "./useModelTableData";

export {
  groupRowHasParsedVariants,
  useModelGroupExpandable,
} from "./modelGroupExpandable";

interface UseModelTableColumnsArgs {
  enabledSet: Set<string>;
  switchSize: "small" | "default";
  onToggleModel: (model: string) => void;
  handleGroupToggle: (group: ModelGroup) => void;
  unifiedMode: boolean;
  modelAliases: ModelTableModelAlias[] | undefined;
  variantsByModel: Map<string, ModelTableVariantInfo>;
  iconOptions: SelectOption[];
  getIconSelectValue: (model: string) => string | undefined;
  hasIconOverride: (model: string) => boolean;
  handleIconChange: (model: string, icon: string) => void;
  handleModelNameChange: (oldModel: string, newModel: string) => void;
  handleModelNameBlur: (model: string) => void;
  handleDisplayNameChange: (model: string, displayName: string) => void;
  handleRemove: (model: string) => void;
  defaultVariantByBaseModel?: Map<string, string>;
  onChangeDefaultVariant?: (baseModel: string, model: string) => void;
}

export interface UseModelTableColumnsReturn {
  flatColumns: SettingsTableColumn<FlatRow>[];
  groupColumns: SettingsTableColumn<GroupRow>[];
}

export function useModelTableColumns(
  args: UseModelTableColumnsArgs
): UseModelTableColumnsReturn {
  const { t } = useTranslation("integrations");
  const {
    enabledSet,
    switchSize,
    onToggleModel,
    handleGroupToggle,
    unifiedMode,
    modelAliases,
    variantsByModel,
    iconOptions,
    getIconSelectValue,
    hasIconOverride,
    handleIconChange,
    handleModelNameChange,
    handleModelNameBlur,
    handleDisplayNameChange,
    handleRemove,
    defaultVariantByBaseModel,
    onChangeDefaultVariant,
  } = args;

  const flatColumnsCatalogOnly = useMemo<SettingsTableColumn<FlatRow>[]>(
    () =>
      buildFlatCatalogColumns({
        t,
        enabledSet,
        switchSize,
        onToggleModel,
      }),
    [t, enabledSet, onToggleModel, switchSize]
  );

  const unifiedColumnArgs = useMemo(
    () => ({
      t,
      modelAliases,
      iconOptions,
      getIconSelectValue,
      hasIconOverride,
      handleIconChange,
      handleModelNameChange,
      handleModelNameBlur,
      handleDisplayNameChange,
      handleRemove,
    }),
    [
      t,
      modelAliases,
      iconOptions,
      getIconSelectValue,
      hasIconOverride,
      handleIconChange,
      handleModelNameChange,
      handleModelNameBlur,
      handleDisplayNameChange,
      handleRemove,
    ]
  );

  const flatColumnsUnified = useMemo<SettingsTableColumn<FlatRow>[]>(
    () =>
      buildFlatUnifiedColumns({
        ...unifiedColumnArgs,
        enabledSet,
        switchSize,
        onToggleModel,
      }),
    [unifiedColumnArgs, enabledSet, onToggleModel, switchSize]
  );

  const showPreferredVersion = onChangeDefaultVariant !== undefined;

  const groupColumns = useMemo<SettingsTableColumn<GroupRow>[]>(
    () =>
      buildGroupColumns({
        ...unifiedColumnArgs,
        enabledSet,
        switchSize,
        onToggleModel,
        handleGroupToggle,
        showPreferredVersion,
        variantsByModel,
        defaultVariantByBaseModel,
        onChangeDefaultVariant,
      }),
    [
      unifiedColumnArgs,
      enabledSet,
      handleGroupToggle,
      onToggleModel,
      switchSize,
      showPreferredVersion,
      variantsByModel,
      defaultVariantByBaseModel,
      onChangeDefaultVariant,
    ]
  );

  const flatColumns = unifiedMode ? flatColumnsUnified : flatColumnsCatalogOnly;

  return { flatColumns, groupColumns };
}
