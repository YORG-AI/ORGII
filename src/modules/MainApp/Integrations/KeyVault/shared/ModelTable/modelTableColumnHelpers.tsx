import React from "react";

import Button from "@src/components/Button";
import Input from "@src/components/Input";
import ModelIcon from "@src/components/ModelIcon";
import Select from "@src/components/Select";
import { SETTINGS_TABLE_CELL } from "@src/components/SettingsTable";
import Switch from "@src/components/Switch";
import { MODEL_TABLE_CONTROL_SIZE } from "@src/config/modelTable";
import {
  BoxIcon,
  CornerDownRightIcon,
  Delete02Icon,
  HugeiconsIcon,
} from "@src/icons";
import type { ModelTableModelAlias } from "@src/types/modelTable";
import { formatModelNameFull } from "@src/util/formatModelName";

import GroupRowEraTag from "./GroupRowEraTag";
import type {
  ModelTableColumnSharedArgs,
  ModelTableUnifiedColumnArgs,
} from "./modelTableColumnTypes";
import {
  CustomModelDisplayNameInput,
  CustomModelNameInput,
} from "./unifiedCustomFlatExtras";
import type { GroupRow } from "./useModelTableData";

export function getModelAlias(
  modelAliases: ModelTableModelAlias[] | undefined,
  model: string
): ModelTableModelAlias | undefined {
  return (modelAliases ?? []).find((entry) => entry.alias === model);
}

export function renderModelIconSelect(
  model: string,
  args: Pick<
    ModelTableUnifiedColumnArgs,
    | "iconOptions"
    | "getIconSelectValue"
    | "hasIconOverride"
    | "handleIconChange"
  >
): React.ReactNode {
  return (
    <Select
      value={args.getIconSelectValue(model)}
      onChange={(value) => args.handleIconChange(model, String(value))}
      options={args.iconOptions}
      showSearch
      allowClear={args.hasIconOverride(model)}
      size={MODEL_TABLE_CONTROL_SIZE}
      placeholder={
        <HugeiconsIcon
          icon={BoxIcon}
          data-icon="box"
          size={14}
          className="text-text-3"
        />
      }
      dropdownWidthMode="min-match"
      dropdownMinWidth={180}
      className="w-20 shrink-0"
    />
  );
}

export function renderEnabledSwitchCell(
  model: string,
  args: ModelTableColumnSharedArgs
): React.ReactNode {
  return (
    <div className="flex justify-end">
      <Switch
        size={args.switchSize}
        checked={args.enabledSet.has(model)}
        onCheckedChange={() => args.onToggleModel(model)}
      />
    </div>
  );
}

export function renderCatalogModelCell(model: string): React.ReactNode {
  return (
    <div className="flex items-center gap-2">
      <ModelIcon modelName={model} size="small" />
      <span className={SETTINGS_TABLE_CELL.primary}>
        {formatModelNameFull(model)}
      </span>
    </div>
  );
}

export function renderUnifiedModelEditCell(
  model: string,
  source: "catalog" | "custom",
  args: ModelTableUnifiedColumnArgs & Pick<ModelTableColumnSharedArgs, "t">
): React.ReactNode {
  return (
    <div className="flex w-full min-w-0 items-center gap-2">
      {renderModelIconSelect(model, args)}
      {source === "catalog" ? (
        <Input
          value={model}
          readOnly
          size={MODEL_TABLE_CONTROL_SIZE}
          className="min-w-0 flex-1"
        />
      ) : (
        <CustomModelNameInput
          modelName={model}
          onCommit={args.handleModelNameChange}
          onCommittedBlur={args.handleModelNameBlur}
          placeholder={args.t("keyVault.customModels.modelNamePlaceholder")}
          className="min-w-0 flex-1"
        />
      )}
      <CustomModelDisplayNameInput
        modelName={model}
        value={getModelAlias(args.modelAliases, model)?.displayName ?? ""}
        onCommit={args.handleDisplayNameChange}
        placeholder={args.t("keyVault.customModels.displayNamePlaceholder")}
        className="min-w-0 flex-1"
      />
      {source !== "catalog"
        ? renderRemoveButton(model, args.handleRemove)
        : null}
    </div>
  );
}

export function renderCustomGroupEditCell(
  model: string,
  args: ModelTableUnifiedColumnArgs & Pick<ModelTableColumnSharedArgs, "t">
): React.ReactNode {
  return (
    <div className="flex w-full min-w-0 items-center gap-2">
      {renderModelIconSelect(model, args)}
      <CustomModelNameInput
        modelName={model}
        onCommit={args.handleModelNameChange}
        onCommittedBlur={args.handleModelNameBlur}
        placeholder={args.t("keyVault.customModels.modelNamePlaceholder")}
        className="min-w-0 flex-1"
      />
      <CustomModelDisplayNameInput
        modelName={model}
        value={getModelAlias(args.modelAliases, model)?.displayName ?? ""}
        onCommit={args.handleDisplayNameChange}
        placeholder={args.t("keyVault.customModels.displayNamePlaceholder")}
        className="min-w-0 flex-1"
      />
      {renderRemoveButton(model, args.handleRemove)}
    </div>
  );
}

export function renderGroupSummaryCell(
  row: GroupRow,
  t: ModelTableColumnSharedArgs["t"]
): React.ReactNode {
  const versionCount = row.group.models.length;
  return (
    <div className="flex w-full min-w-0 items-center gap-2">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <ModelIcon modelName={row.group.models[0]} size="small" />
        <span className={`${SETTINGS_TABLE_CELL.primary} truncate font-medium`}>
          {row.groupLabel}
        </span>
        <span className="shrink-0 text-[12px] text-text-3">
          · {t("modelsTable.variantCount", { count: versionCount })}
        </span>
      </div>
      <GroupRowEraTag era={row.type === "current" ? "current" : "older"} />
    </div>
  );
}

export function renderExpandedCatalogModelCell(model: string): React.ReactNode {
  return (
    <div key={`model-${model}`} className="flex min-w-0 items-center gap-1">
      <HugeiconsIcon
        icon={CornerDownRightIcon}
        data-icon="corner-down-right"
        size={12}
        className="shrink-0 text-text-4"
      />
      <ModelIcon modelName={model} size="small" />
      <span className={SETTINGS_TABLE_CELL.primary}>
        {formatModelNameFull(model)}
      </span>
    </div>
  );
}

export function renderExpandedUnifiedModelCell(
  model: string,
  args: Omit<
    ModelTableUnifiedColumnArgs,
    "handleModelNameChange" | "handleModelNameBlur" | "handleRemove"
  > &
    Pick<ModelTableColumnSharedArgs, "t">
): React.ReactNode {
  return (
    <div
      key={`model-${model}`}
      className="flex w-full min-w-0 items-center gap-2"
    >
      <HugeiconsIcon
        icon={CornerDownRightIcon}
        data-icon="corner-down-right"
        size={12}
        className="shrink-0 text-text-4"
      />
      {renderModelIconSelect(model, args)}
      <Input
        value={model}
        readOnly
        size={MODEL_TABLE_CONTROL_SIZE}
        className="min-w-0 flex-1"
      />
      <CustomModelDisplayNameInput
        modelName={model}
        value={getModelAlias(args.modelAliases, model)?.displayName ?? ""}
        onCommit={args.handleDisplayNameChange}
        placeholder={args.t("keyVault.customModels.displayNamePlaceholder")}
        className="min-w-0 flex-1"
      />
    </div>
  );
}

export function getGroupEnabledState(row: GroupRow, enabledSet: Set<string>) {
  const totalCount = row.group.models.length;
  const enabledCount = row.group.models.filter((model) =>
    enabledSet.has(model)
  ).length;
  const allEnabled = enabledCount === totalCount;
  return {
    allEnabled,
    mixed: enabledCount > 0 && !allEnabled,
    ratio: enabledCount / (totalCount || 1),
  };
}

function renderRemoveButton(
  model: string,
  handleRemove: (model: string) => void
): React.ReactNode {
  return (
    <Button
      variant="secondary"
      size="default"
      icon={
        <HugeiconsIcon
          icon={Delete02Icon}
          data-icon="trash-2"
          size={14}
          className="text-danger-6"
        />
      }
      iconOnly
      className="shrink-0"
      onClick={() => handleRemove(model)}
    />
  );
}
