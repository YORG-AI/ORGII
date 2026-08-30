/**
 * ModelTable — Reusable model list with flat/group view toggle.
 *
 * Flat view: one row per model, with icon + name + switch.
 * Group view: collapsible rows per model family, with master switch and
 * individual toggles.
 *
 * Key Vault wizard: pass `onCustomModelsChange` (+ related props) to merge
 * user-added rows into the same flat table (flat-only; catalog rows first,
 * then custom).
 *
 * Used by:
 *   - AccountDetailsPanel (integrations detail, toggle persisted via saveKey)
 *   - KeyVaultWizard (unified catalog + custom models)
 *
 * Composition:
 *   - `useModelTableData`           → search / filter / view-mode state.
 *   - `useUnifiedCustomFlatHandlers`→ custom row add / edit / remove handlers.
 *   - `useModelTableColumns`        → flat + group `SettingsTableColumn` defs.
 *   - `useModelGroupExpandable`     → expandable per-row cells in group view.
 */
import React, { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import InlineAlert from "@src/components/InlineAlert";
import { getIconProviderFromModelName } from "@src/components/ModelIcon/config";
import SettingsTable from "@src/components/SettingsTable";
import { MODEL_TABLE_SWITCH_SIZE } from "@src/config/modelTable";
import {
  HugeiconsIcon,
  ListIcon as List,
  ListChevronsDownUpIcon as ListChevronsDownUp,
  ListChevronsDownUpIcon as ListChevronsUpDown,
  Add01Icon as Plus,
  TablePropertiesIcon as TableProperties,
} from "@src/icons";
import type {
  ModelTableModelAlias,
  ModelTableVariantInfo,
  ModelTableViewMode,
} from "@src/types/modelTable";
import type { ModelGroup } from "@src/util/modelGrouping";

import { useUnifiedCustomFlatHandlers } from "./unifiedCustomFlatExtras";
import {
  groupRowHasParsedVariants,
  useModelGroupExpandable,
  useModelTableColumns,
} from "./useModelTableColumns";
import {
  type FlatRow,
  type GroupRow,
  useModelTableData,
} from "./useModelTableData";

// ── Types ─────────────────────────────────────────────────────────────────────

export type { ModelTableModelAlias, ModelTableVariantInfo, ModelTableViewMode };

export interface ModelTableProps {
  models: string[];
  enabledModels: string[] | Set<string>;
  onToggleModel: (model: string) => void;
  /** Batch toggle for group view — called with full updated enabled list */
  onEnabledModelsChange?: (enabledModels: string[]) => void;
  /** Show search bar. Default: true */
  searchable?: boolean;
  /** Initial view mode. Default: "flat" */
  defaultView?: ModelTableViewMode;
  /** Hide the flat/group toggle button. Default: false */
  hideViewToggle?: boolean;
  /** Switch size. Use "small" for preview panels. Default: "default" */
  switchSize?: "small" | "default";
  /**
   * Extra action nodes rendered in the search bar's right-side action group,
   * to the left of the built-in view toggle / bulk expand buttons. Use
   * iconOnly secondary `<Button>` instances for visual consistency.
   */
  extraSearchBarActions?: React.ReactNode;
  /** When set, enables unified table with editable custom rows (wizard). */
  customModels?: string[];
  modelAliases?: ModelTableModelAlias[];
  modelVariants?: ModelTableVariantInfo[];
  onCustomModelsChange?: (models: string[]) => void;
  onModelAliasesChange?: (aliases: ModelTableModelAlias[]) => void;
  onTestModel?: (
    model: string
  ) => Promise<{ available: boolean; message: string }>;
  /** Persisted preferred variant per base model (group view only). When
   *  `onChangeDefaultVariant` is also set, the group table renders a
   *  "Preferred version" column with a variant-picker pill. */
  defaultVariants?: ReadonlyArray<{ base_model: string; model: string }>;
  onChangeDefaultVariant?: (baseModel: string, model: string) => void;
}

function noopModels(_models: string[]) {
  void _models;
}

function noopAliases(_aliases: ModelTableModelAlias[]) {
  void _aliases;
}

// ── Component ─────────────────────────────────────────────────────────────────

const ModelTable: React.FC<ModelTableProps> = ({
  models,
  enabledModels: enabledModelsProp,
  onToggleModel,
  onEnabledModelsChange,
  searchable = true,
  defaultView = "flat",
  hideViewToggle = false,
  switchSize = MODEL_TABLE_SWITCH_SIZE,
  extraSearchBarActions,
  customModels,
  modelAliases,
  modelVariants,
  onCustomModelsChange,
  onModelAliasesChange,
  onTestModel,
  defaultVariants,
  onChangeDefaultVariant,
}) => {
  const { t } = useTranslation("integrations");
  const unifiedMode = onCustomModelsChange != null;

  const [optimisticEnabledModels, setOptimisticEnabledModels] = useState<{
    propRef: string[] | Set<string>;
    models: string[];
  } | null>(null);

  const effectiveEnabledModels =
    optimisticEnabledModels?.propRef === enabledModelsProp
      ? optimisticEnabledModels.models
      : enabledModelsProp;

  const {
    viewMode,
    setViewMode,
    searchQuery,
    setSearchQuery,
    selectFilters,
    enabledSet,
    enabledArray,
    visibleFlatRows,
    visibleGroupRows,
    expandedGroupRowKeysInView,
    handleExpandedGroupRowsChange,
    emptyStateIsFiltered,
  } = useModelTableData({
    models,
    enabledModelsProp: effectiveEnabledModels,
    defaultView,
    customModels: unifiedMode ? (customModels ?? []) : [],
    modelAliases: unifiedMode ? (modelAliases ?? []) : [],
    modelVariants: modelVariants ?? [],
  });

  const commitEnabledModelsChange = useCallback(
    (modelsNext: string[]) => {
      setOptimisticEnabledModels({
        propRef: enabledModelsProp,
        models: modelsNext,
      });
      onEnabledModelsChange?.(modelsNext);
    },
    [enabledModelsProp, onEnabledModelsChange]
  );

  const handleToggleModelImmediate = useCallback(
    (model: string) => {
      const current = new Set(enabledArray);
      if (current.has(model)) {
        current.delete(model);
      } else {
        current.add(model);
      }
      const modelsNext = [...current];
      setOptimisticEnabledModels({
        propRef: enabledModelsProp,
        models: modelsNext,
      });
      onToggleModel(model);
    },
    [enabledArray, enabledModelsProp, onToggleModel]
  );

  const unifiedCustom = useUnifiedCustomFlatHandlers({
    customModels: unifiedMode ? (customModels ?? []) : [],
    onCustomModelsChange: onCustomModelsChange ?? noopModels,
    modelAliases: unifiedMode ? (modelAliases ?? []) : [],
    onModelAliasesChange: onModelAliasesChange ?? noopAliases,
    enabledModels: enabledArray,
    onEnabledModelsChange: commitEnabledModelsChange,
    onTestModel: unifiedMode ? onTestModel : undefined,
    visibleFlatRows,
  });

  const {
    testError,
    setTestError,
    iconOptions,
    handleAddModel,
    handleRemove,
    handleIconChange,
    handleModelNameChange,
    handleModelNameBlur,
    handleDisplayNameChange,
  } = unifiedCustom;

  const variantsByModel = useMemo(
    () =>
      new Map((modelVariants ?? []).map((variant) => [variant.model, variant])),
    [modelVariants]
  );

  const defaultVariantByBaseModel = useMemo(
    () =>
      new Map(
        (defaultVariants ?? []).map((entry) => [entry.base_model, entry.model])
      ),
    [defaultVariants]
  );

  const hasIconOverride = useCallback(
    (model: string): boolean =>
      Boolean(
        (modelAliases ?? []).find((entry) => entry.alias === model)?.icon
      ),
    [modelAliases]
  );

  const getIconSelectValue = useCallback(
    (model: string): string | undefined => {
      const override = (modelAliases ?? []).find(
        (entry) => entry.alias === model
      )?.icon;
      if (override) return override;

      const inferred = getIconProviderFromModelName(model);
      return inferred === "unknown" ? undefined : inferred;
    },
    [modelAliases]
  );

  const handleGroupToggle = useCallback(
    (group: ModelGroup) => {
      const groupEnabledCount = group.models.filter((model) =>
        enabledSet.has(model)
      ).length;
      const shouldEnable = groupEnabledCount < group.models.length;

      if (shouldEnable) {
        const newEnabled = new Set(enabledArray);
        for (const model of group.models) newEnabled.add(model);
        commitEnabledModelsChange([...newEnabled]);
      } else {
        const groupSet = new Set(group.models);
        commitEnabledModelsChange(enabledArray.filter((m) => !groupSet.has(m)));
      }
    },
    [enabledSet, enabledArray, commitEnabledModelsChange]
  );

  const { flatColumns, groupColumns } = useModelTableColumns({
    enabledSet,
    switchSize,
    onToggleModel: handleToggleModelImmediate,
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
  });

  const groupExpandable = useModelGroupExpandable({
    enabledSet,
    switchSize,
    onToggleModel: handleToggleModelImmediate,
    unifiedMode,
    modelAliases,
    variantsByModel,
    iconOptions,
    getIconSelectValue,
    hasIconOverride,
    handleIconChange,
    handleDisplayNameChange,
    expandedGroupRowKeysInView,
    handleExpandedGroupRowsChange,
  });

  // ── Toolbar buttons ───────────────────────────────────────────────────────

  const viewToggle = useMemo(() => {
    if (hideViewToggle) return null;
    return (
      <Button
        variant="secondary"
        iconOnly
        onClick={() =>
          setViewMode((prev) => (prev === "flat" ? "group" : "flat"))
        }
        icon={
          viewMode === "flat" ? (
            <HugeiconsIcon
              icon={TableProperties}
              data-icon="table-properties"
              size={14}
            />
          ) : (
            <HugeiconsIcon icon={List} data-icon="list" size={14} />
          )
        }
        title={
          viewMode === "flat"
            ? t("modelsTable.groupView")
            : t("modelsTable.flatView")
        }
      />
    );
  }, [hideViewToggle, viewMode, setViewMode, t]);

  const expandableGroupRowKeys = useMemo(
    () =>
      visibleGroupRows
        .filter((row) => groupRowHasParsedVariants(row, variantsByModel))
        .map((row) => row.key),
    [visibleGroupRows, variantsByModel]
  );

  const groupBulkExpandBarButton = useMemo(() => {
    if (expandableGroupRowKeys.length === 0) return null;
    const someGroupExpanded = expandableGroupRowKeys.some((key) =>
      expandedGroupRowKeysInView.includes(key)
    );
    return (
      <Button
        variant="secondary"
        iconOnly
        onClick={() => {
          if (someGroupExpanded) {
            handleExpandedGroupRowsChange([]);
          } else {
            handleExpandedGroupRowsChange([...expandableGroupRowKeys]);
          }
        }}
        icon={
          someGroupExpanded ? (
            <HugeiconsIcon
              icon={ListChevronsDownUp}
              data-icon="list-chevrons-down-up"
              size={16}
            />
          ) : (
            <HugeiconsIcon
              icon={ListChevronsUpDown}
              data-icon="list-chevrons-up-down"
              size={16}
            />
          )
        }
        title={
          someGroupExpanded
            ? t("modelsTable.collapseAllRows")
            : t("modelsTable.expandAllRows")
        }
      />
    );
  }, [
    expandableGroupRowKeys,
    expandedGroupRowKeysInView,
    handleExpandedGroupRowsChange,
    t,
  ]);

  const flatSearchBarRightContent = useMemo(() => {
    if (!extraSearchBarActions && !viewToggle) return undefined;
    return (
      <div className="flex items-center gap-1.5">
        {extraSearchBarActions}
        {viewToggle}
      </div>
    );
  }, [extraSearchBarActions, viewToggle]);

  const groupSearchBarRightContent = useMemo(() => {
    if (!extraSearchBarActions && !groupBulkExpandBarButton && !viewToggle) {
      return undefined;
    }
    return (
      <div className="flex items-center gap-1.5">
        {extraSearchBarActions}
        {viewToggle}
        {groupBulkExpandBarButton}
      </div>
    );
  }, [extraSearchBarActions, groupBulkExpandBarButton, viewToggle]);

  // ── Render ────────────────────────────────────────────────────────────────

  const emptyTitle = emptyStateIsFiltered
    ? t("modelsTable.noMatchingModels")
    : t("modelsTable.noModels");

  const isFlat = viewMode === "flat";

  const unifiedFooter = unifiedMode ? (
    <div className="flex flex-col gap-2 px-4 py-2">
      {testError && (
        <InlineAlert type="danger" onClose={() => setTestError(null)}>
          {testError}
        </InlineAlert>
      )}
      <div className="flex items-center">
        <Button
          variant="tertiary"
          size="default"
          icon={<HugeiconsIcon icon={Plus} data-icon="plus" size={14} />}
          onClick={handleAddModel}
          className="text-text-3 hover:text-text-1"
        >
          {t("keyVault.customModels.addModel")}
        </Button>
      </div>
    </div>
  ) : undefined;

  if (isFlat) {
    return (
      <SettingsTable<FlatRow>
        searchBar={
          searchable
            ? {
                searchValue: searchQuery,
                searchPlaceholder: t("modelsTable.searchPlaceholder"),
                onSearchChange: setSearchQuery,
                allowSearchClear: true,
                rightContent: flatSearchBarRightContent,
              }
            : undefined
        }
        selectFilters={selectFilters}
        columns={flatColumns}
        rows={visibleFlatRows}
        getRowKey={(row) =>
          row.source === "custom"
            ? `custom:${row.rowId ?? row.model}`
            : row.model
        }
        hover
        headerHeight="tall"
        dense={unifiedMode}
        emptyTitle={
          unifiedMode && visibleFlatRows.length === 0 && !emptyStateIsFiltered
            ? t("keyVault.customModels.emptyHint")
            : emptyTitle
        }
        footer={unifiedFooter}
      />
    );
  }

  return (
    <SettingsTable<GroupRow>
      searchBar={
        searchable
          ? {
              searchValue: searchQuery,
              searchPlaceholder: t("modelsTable.searchPlaceholder"),
              onSearchChange: setSearchQuery,
              allowSearchClear: true,
              rightContent: groupSearchBarRightContent,
            }
          : undefined
      }
      selectFilters={selectFilters}
      columns={groupColumns}
      rows={visibleGroupRows}
      getRowKey={(row) => row.key}
      expandable={groupExpandable}
      hover
      headerHeight="tall"
      emptyTitle={emptyTitle}
      footer={unifiedFooter}
      className="table-expanded-no-hover table-settings-expanded-compact"
    />
  );
};

export default ModelTable;
