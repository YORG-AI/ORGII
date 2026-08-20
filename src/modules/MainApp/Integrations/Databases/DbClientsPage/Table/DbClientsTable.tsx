/**
 * DB Clients Table
 *
 * Shows installation status for database CLI tools (mysql, psql, sqlite, etc.).
 * Follows the same pattern as LintToolsTable / DependenciesTable.
 */
import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { DbClientIcon } from "@src/assets/databaseIcons";
import SettingsTable, {
  SETTINGS_TABLE_CELL,
  SETTINGS_TABLE_COL,
  type SettingsTableColumn,
} from "@src/components/SettingsTable";
import type { DependencyStatus } from "@src/modules/MainApp/Integrations/hooks/useSystemDependencies";
import { Placeholder } from "@src/modules/shared/layouts/blocks";

import { StatusDot, selectedRowClassName } from "../../../Tables/shared";

interface DbClientsTableProps {
  clients: DependencyStatus[];
  loading: boolean;
  selectedClientId?: string | null;
  onSelectClient?: (client: DependencyStatus | null) => void;
}

const DbClientsTable: React.FC<DbClientsTableProps> = ({
  clients,
  loading,
  selectedClientId,
  onSelectClient,
}) => {
  const { t } = useTranslation("settings");
  const { t: tCommon } = useTranslation();
  const [searchQuery, setSearchQuery] = useState("");

  const filteredClients = useMemo(() => {
    const query = searchQuery.toLowerCase().trim();
    return clients
      .filter((dep) => {
        if (!query) return true;
        return (
          dep.name.toLowerCase().includes(query) ||
          dep.binary.toLowerCase().includes(query)
        );
      })
      .sort((depA, depB) => {
        if (depA.installed !== depB.installed) {
          return depA.installed ? -1 : 1;
        }
        return depA.name.localeCompare(depB.name);
      });
  }, [clients, searchQuery]);

  const columns = useMemo<SettingsTableColumn<DependencyStatus>[]>(
    () => [
      {
        key: "name",
        label: t("dependencies.tableName"),
        width: SETTINGS_TABLE_COL.fill,
        sorter: (depA, depB) => depA.name.localeCompare(depB.name),
        renderCell: (dep) => (
          <span className={`${SETTINGS_TABLE_CELL.primary} font-bold`}>
            {dep.name}
          </span>
        ),
      },
      {
        key: "binary",
        label: t("dependencies.tableClient"),
        width: SETTINGS_TABLE_COL.valueLg,
        renderCell: (dep) => (
          <span
            className={`${SETTINGS_TABLE_CELL.value} inline-flex items-center gap-2 whitespace-nowrap`}
          >
            <DbClientIcon binary={dep.binary} size={16} />
            {dep.binary}
          </span>
        ),
      },
      {
        key: "version",
        label: t("dependencies.tableVersion"),
        width: SETTINGS_TABLE_COL.valueLg,
        renderCell: (dep) =>
          dep.installed && dep.version ? (
            <span className={`${SETTINGS_TABLE_CELL.muted} whitespace-nowrap`}>
              {dep.version}
            </span>
          ) : null,
      },
      {
        key: "status",
        label: t("dependencies.tableStatus"),
        width: SETTINGS_TABLE_COL.valueLg,
        sorter: (depA, depB) => Number(depB.installed) - Number(depA.installed),
        renderCell: (dep) => (
          <StatusDot
            color={dep.installed ? "bg-success-6" : "bg-fill-3"}
            label={
              dep.installed
                ? t("dependencies.installed")
                : t("dependencies.notFound")
            }
          />
        ),
      },
    ],
    [t]
  );

  if (loading) {
    return (
      <div className="flex min-h-[200px] items-center justify-center rounded-lg bg-fill-2">
        <Placeholder variant="loading" />
      </div>
    );
  }

  return (
    <SettingsTable<DependencyStatus>
      hover
      columns={columns}
      rows={filteredClients}
      getRowKey={(dep) => dep.binary}
      onRowClick={
        onSelectClient
          ? (dep) => {
              onSelectClient(selectedClientId === dep.binary ? null : dep);
            }
          : undefined
      }
      rowClassName={selectedRowClassName(
        (dep: DependencyStatus) => dep.binary,
        selectedClientId
      )}
      headerHeight="tall"
      searchBar={{
        searchValue: searchQuery,
        onSearchChange: setSearchQuery,
        searchPlaceholder: tCommon("common.searchPlaceholder"),
        allowSearchClear: true,
      }}
      emptyTitle={t("dependencies.noDbClientsFound")}
    />
  );
};

export default DbClientsTable;
