import type { TFunction } from "i18next";

import type { SelectOption } from "@src/components/Select";
import type {
  ModelTableModelAlias,
  ModelTableVariantInfo,
} from "@src/types/modelTable";
import type { ModelGroup } from "@src/util/modelGrouping";

import type { FlatRow, GroupRow } from "./useModelTableData";

export type ModelTableSwitchSize = "small" | "default";

export interface ModelTableColumnSharedArgs {
  t: TFunction;
  enabledSet: Set<string>;
  switchSize: ModelTableSwitchSize;
  onToggleModel: (model: string) => void;
}

export interface ModelTableUnifiedColumnArgs {
  modelAliases: ModelTableModelAlias[] | undefined;
  iconOptions: SelectOption[];
  getIconSelectValue: (model: string) => string | undefined;
  hasIconOverride: (model: string) => boolean;
  handleIconChange: (model: string, icon: string) => void;
  handleModelNameChange: (oldModel: string, newModel: string) => void;
  handleModelNameBlur: (model: string) => void;
  handleDisplayNameChange: (model: string, displayName: string) => void;
  handleRemove: (model: string) => void;
}

export interface BuildFlatCatalogColumnsArgs extends ModelTableColumnSharedArgs {}

export interface BuildFlatUnifiedColumnsArgs
  extends ModelTableColumnSharedArgs, ModelTableUnifiedColumnArgs {}

export interface BuildGroupColumnsArgs
  extends ModelTableColumnSharedArgs, ModelTableUnifiedColumnArgs {
  handleGroupToggle: (group: ModelGroup) => void;
  showPreferredVersion: boolean;
  variantsByModel: Map<string, ModelTableVariantInfo>;
  defaultVariantByBaseModel?: Map<string, string>;
  onChangeDefaultVariant?: (baseModel: string, model: string) => void;
}

export interface UseModelGroupExpandableArgs
  extends
    Omit<ModelTableColumnSharedArgs, "t">,
    Omit<
      ModelTableUnifiedColumnArgs,
      "handleModelNameChange" | "handleModelNameBlur" | "handleRemove"
    > {
  unifiedMode: boolean;
  variantsByModel: Map<string, ModelTableVariantInfo>;
  expandedGroupRowKeysInView: string[];
  handleExpandedGroupRowsChange: (keys: string[]) => void;
}

export type FlatColumnRow = FlatRow;
export type GroupColumnRow = GroupRow;
