/**
 * Table column configs for CLI preview panel (CLI accounts and API keys tables).
 */
import type { TFunction } from "i18next";

import { formatAgentType } from "@src/assets/providers";
import ModelIcon from "@src/components/ModelIcon";
import {
  SETTINGS_TABLE_CELL,
  SETTINGS_TABLE_COL,
  type SettingsTableColumn,
} from "@src/components/SettingsTable";
import type { KeyVaultAccount } from "@src/hooks/keyVault";

export function formatAddedDate(date?: Date): string {
  if (!date) return "—";
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function buildAddedColumn(t: TFunction): SettingsTableColumn<KeyVaultAccount> {
  return {
    key: "added",
    label: t("tableHeaders.added"),
    width: "110px",
    align: "right",
    sorter: (rowA, rowB) =>
      (rowA.connectedAt?.getTime() ?? 0) - (rowB.connectedAt?.getTime() ?? 0),
    renderCell: (acc) => (
      <span className={SETTINGS_TABLE_CELL.value}>
        {formatAddedDate(acc.connectedAt)}
      </span>
    ),
  };
}

export function buildAccountColumns(
  t: TFunction
): SettingsTableColumn<KeyVaultAccount>[] {
  return [
    {
      key: "provider",
      label: t("common:labels.provider"),
      width: SETTINGS_TABLE_COL.valueMd,
      renderCell: (acc) => (
        <div className="flex items-center gap-2">
          <ModelIcon
            agentType={acc.modelType}
            size={16}
            className="flex-shrink-0"
          />
          <span className={SETTINGS_TABLE_CELL.value}>
            {formatAgentType(acc.modelType)}
          </span>
        </div>
      ),
    },
    {
      key: "name",
      label: t("common:labels.name"),
      width: SETTINGS_TABLE_COL.fill,
      sorter: (rowA, rowB) => rowA.name.localeCompare(rowB.name),
      renderCell: (acc) => (
        <span className={`${SETTINGS_TABLE_CELL.primary} truncate`}>
          {acc.name}
        </span>
      ),
    },
    buildAddedColumn(t),
  ];
}

export function buildApiKeyColumns(
  t: TFunction
): SettingsTableColumn<KeyVaultAccount>[] {
  return [
    {
      key: "provider",
      label: t("common:labels.provider"),
      width: SETTINGS_TABLE_COL.valueMd,
      renderCell: (acc) => (
        <div className="flex items-center gap-2">
          <ModelIcon agentType={acc.modelType} size="small" />
          <span className={SETTINGS_TABLE_CELL.value}>
            {formatAgentType(acc.modelType)}
          </span>
        </div>
      ),
    },
    {
      key: "name",
      label: t("common:labels.name"),
      width: SETTINGS_TABLE_COL.fill,
      sorter: (rowA, rowB) => rowA.name.localeCompare(rowB.name),
      renderCell: (acc) => (
        <span className={`${SETTINGS_TABLE_CELL.primary} truncate`}>
          {acc.name}
        </span>
      ),
    },
    buildAddedColumn(t),
  ];
}
