import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { ModelTableVariantInfo } from "@src/types/modelTable";
import { formatModelNameFull } from "@src/util/formatModelName";
import {
  groupHasParsedModelVariants,
  resolveModelVariantFields,
} from "@src/util/modelVariants";

import ModelVariantInlineCard from "./ModelVariantInlineCard";
import {
  renderEnabledSwitchCell,
  renderExpandedCatalogModelCell,
  renderExpandedUnifiedModelCell,
} from "./modelTableColumnHelpers";
import type { UseModelGroupExpandableArgs } from "./modelTableColumnTypes";
import type { GroupRow } from "./useModelTableData";

export function groupRowHasParsedVariants(
  row: GroupRow,
  _variantsByModel: Map<string, ModelTableVariantInfo>
): boolean {
  if (row.type === "custom") return false;
  return groupHasParsedModelVariants(row.group.models);
}

export function useModelGroupExpandable(args: UseModelGroupExpandableArgs) {
  const { t } = useTranslation("integrations");
  const {
    enabledSet,
    switchSize,
    onToggleModel,
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
  } = args;

  return useMemo(
    () => ({
      expandedRowRender: (
        row: GroupRow
      ): React.ReactNode | React.ReactNode[][] => {
        const hasParsedVariants = groupHasParsedModelVariants(row.group.models);

        if (row.type !== "custom") {
          const groupVariants = row.group.models.map((model) =>
            resolveModelVariantFields(model, variantsByModel.get(model))
          );
          return (
            <ModelVariantInlineCard
              variants={groupVariants}
              forceModelList={!hasParsedVariants}
              defaultRowLabel={(baseModel) =>
                t("modelsTable.selectedVersionFor", {
                  model: formatModelNameFull(baseModel),
                })
              }
            />
          );
        }

        return row.group.models.map((model) => {
          const toggleCell = renderEnabledSwitchCell(model, {
            t,
            enabledSet,
            switchSize,
            onToggleModel,
          });

          if (!unifiedMode) {
            return [renderExpandedCatalogModelCell(model), toggleCell];
          }

          return [
            renderExpandedUnifiedModelCell(model, {
              t,
              modelAliases,
              iconOptions,
              getIconSelectValue,
              hasIconOverride,
              handleIconChange,
              handleDisplayNameChange,
            }),
            toggleCell,
          ];
        });
      },
      rowExpandable: (row: GroupRow) =>
        row.type !== "custom" &&
        groupRowHasParsedVariants(row, variantsByModel),
      expandedRowKeys: expandedGroupRowKeysInView,
      onExpandedRowsChange: handleExpandedGroupRowsChange,
    }),
    [
      enabledSet,
      expandedGroupRowKeysInView,
      getIconSelectValue,
      handleDisplayNameChange,
      handleExpandedGroupRowsChange,
      handleIconChange,
      hasIconOverride,
      iconOptions,
      modelAliases,
      onToggleModel,
      switchSize,
      t,
      unifiedMode,
      variantsByModel,
    ]
  );
}
