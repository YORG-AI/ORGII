import { ChevronDown } from "lucide-react";
import React from "react";

import ModelPropertiesDropdown from "@src/components/ModelPropertiesDropdown";
import {
  SETTINGS_TABLE_COL,
  type SettingsTableColumn,
} from "@src/components/SettingsTable";
import Switch from "@src/components/Switch";
import { resolveDefaultVariant } from "@src/util/defaultModelVariant";
import { formatModelNameFull } from "@src/util/formatModelName";
import {
  formatVariantDisplayLabel,
  groupHasParsedModelVariants,
  resolveModelVariantFields,
} from "@src/util/modelVariants";
import { buildVariantEditOptions } from "@src/util/variantEditOptions";

import { MODEL_TABLE_INPUT_VALUE_INTERACTIVE_TOKEN } from "./config";
import {
  getGroupEnabledState,
  renderCustomGroupEditCell,
  renderEnabledSwitchCell,
  renderGroupSummaryCell,
} from "./modelTableColumnHelpers";
import type { BuildGroupColumnsArgs } from "./modelTableColumnTypes";
import type { GroupRow } from "./useModelTableData";

export function buildGroupColumns(
  args: BuildGroupColumnsArgs
): SettingsTableColumn<GroupRow>[] {
  const {
    t,
    enabledSet,
    switchSize,
    onToggleModel,
    handleGroupToggle,
    showPreferredVersion,
  } = args;

  const columns: SettingsTableColumn<GroupRow>[] = [
    {
      key: "group",
      label: t("common:labels.model"),
      width: SETTINGS_TABLE_COL.fill,
      sorter: (rowA, rowB) => {
        if (rowA.type !== rowB.type) {
          return rowA.type === "custom" ? 1 : -1;
        }
        return rowA.groupLabel.localeCompare(rowB.groupLabel);
      },
      renderCell: (row) => {
        if (row.type === "custom") {
          return renderCustomGroupEditCell(row.group.models[0], args);
        }
        return renderGroupSummaryCell(row, t);
      },
    },
  ];

  if (showPreferredVersion) {
    columns.push(buildPreferredVersionColumn(args));
  }

  columns.push({
    key: "enabled",
    label: "",
    width: SETTINGS_TABLE_COL.hug,
    align: "right",
    sorter: (rowA, rowB) =>
      getGroupEnabledState(rowA, enabledSet).ratio -
      getGroupEnabledState(rowB, enabledSet).ratio,
    renderCell: (row) => {
      if (row.type === "custom") {
        return renderEnabledSwitchCell(row.group.models[0], {
          t,
          enabledSet,
          switchSize,
          onToggleModel,
        });
      }
      const { allEnabled, mixed } = getGroupEnabledState(row, enabledSet);
      return (
        <div className="flex justify-end">
          <Switch
            size={switchSize}
            checked={allEnabled}
            mixed={mixed}
            type={mixed ? "warning" : "primary"}
            onCheckedChange={() => handleGroupToggle(row.group)}
          />
        </div>
      );
    },
  });

  return columns;
}

function buildPreferredVersionColumn(
  args: BuildGroupColumnsArgs
): SettingsTableColumn<GroupRow> {
  return {
    key: "preferred",
    label: args.t("modelsTable.preferredVersion"),
    width: SETTINGS_TABLE_COL.valueLg,
    align: "left",
    renderCell: (row) => renderPreferredVersionCell(row, args),
  };
}

function renderPreferredVersionCell(
  row: GroupRow,
  args: BuildGroupColumnsArgs
): React.ReactNode {
  if (row.type === "custom") {
    return <span className="block text-text-3">—</span>;
  }
  const variantInfos = row.group.models.map((model) =>
    resolveModelVariantFields(model, args.variantsByModel.get(model))
  );
  const hasParsed = groupHasParsedModelVariants(row.group.models);
  if (!hasParsed) {
    return <span className="block text-text-3">—</span>;
  }
  const canonicalBaseModel = variantInfos
    .map((variant) => variant.base_model)
    .reduce((shortest, candidate) =>
      candidate.length < shortest.length ? candidate : shortest
    );
  const persisted =
    resolveDefaultVariant(
      canonicalBaseModel,
      variantInfos,
      args.defaultVariantByBaseModel?.get(canonicalBaseModel)
    ) ?? variantInfos[0].model;
  const variantOptions = buildVariantEditOptions(
    variantInfos.map((variant) => variant.model)
  );
  const triggerLabel =
    formatVariantDisplayLabel(persisted) ?? formatModelNameFull(persisted);
  return (
    <div className="flex items-center justify-start">
      <ModelPropertiesDropdown
        variantOptions={variantOptions}
        value={persisted}
        onApply={(modelId) =>
          args.onChangeDefaultVariant?.(canonicalBaseModel, modelId)
        }
        renderTrigger={({ ref, onClick, ariaExpanded }) => (
          <button
            ref={ref}
            type="button"
            onClick={onClick}
            aria-expanded={ariaExpanded}
            aria-label="Edit preferred version"
            className={MODEL_TABLE_INPUT_VALUE_INTERACTIVE_TOKEN}
          >
            <span className="truncate">{triggerLabel}</span>
            <ChevronDown size={12} className="text-text-3" />
          </button>
        )}
      />
    </div>
  );
}
