/** Flat-view columns for the Key Vault ModelTable. */
import {
  SETTINGS_TABLE_COL,
  type SettingsTableColumn,
} from "@src/components/SettingsTable";

import {
  renderCatalogModelCell,
  renderEnabledSwitchCell,
  renderUnifiedModelEditCell,
} from "./modelTableColumnHelpers";
import type {
  BuildFlatCatalogColumnsArgs,
  BuildFlatUnifiedColumnsArgs,
} from "./modelTableColumnTypes";
import type { FlatRow } from "./useModelTableData";

export function buildFlatCatalogColumns({
  t,
  enabledSet,
  switchSize,
  onToggleModel,
}: BuildFlatCatalogColumnsArgs): SettingsTableColumn<FlatRow>[] {
  return [
    {
      key: "model",
      label: t("common:labels.model"),
      width: SETTINGS_TABLE_COL.fill,
      sorter: (rowA, rowB) => rowA.model.localeCompare(rowB.model),
      renderCell: (row) => renderCatalogModelCell(row.model),
    },
    {
      key: "enabled",
      label: "",
      width: SETTINGS_TABLE_COL.hug,
      align: "right",
      sorter: (rowA, rowB) =>
        Number(!enabledSet.has(rowA.model)) -
        Number(!enabledSet.has(rowB.model)),
      renderCell: (row) =>
        renderEnabledSwitchCell(row.model, {
          t,
          enabledSet,
          switchSize,
          onToggleModel,
        }),
    },
  ];
}

export function buildFlatUnifiedColumns(
  args: BuildFlatUnifiedColumnsArgs
): SettingsTableColumn<FlatRow>[] {
  const { t, enabledSet, switchSize, onToggleModel } = args;
  return [
    {
      key: "model",
      label: t("common:labels.model"),
      width: SETTINGS_TABLE_COL.fill,
      sorter: (rowA, rowB) => {
        if (rowA.source !== rowB.source) {
          return rowA.source === "catalog" ? -1 : 1;
        }
        return rowA.model.localeCompare(rowB.model);
      },
      renderCell: (row) =>
        renderUnifiedModelEditCell(row.model, row.source, args),
    },
    {
      key: "enabled",
      label: "",
      width: SETTINGS_TABLE_COL.hug,
      align: "right",
      sorter: (rowA, rowB) =>
        Number(!enabledSet.has(rowA.model)) -
        Number(!enabledSet.has(rowB.model)),
      renderCell: (row) =>
        renderEnabledSwitchCell(row.model, {
          t,
          enabledSet,
          switchSize,
          onToggleModel,
        }),
    },
  ];
}
