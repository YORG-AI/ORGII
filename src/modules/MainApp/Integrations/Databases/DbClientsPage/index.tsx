/**
 * DB Clients Page
 *
 * Shows database CLI tools (mysql, psql, sqlite3, etc.) detected on the system.
 * Embedded inside the Databases integrations section.
 * Row selection opens a preview panel when embedded.
 */
import React from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import { useRefreshSpin } from "@src/hooks/ui";
import { HugeiconsIcon, Refresh04Icon } from "@src/icons";
import {
  type DependencyStatus,
  useSystemDependencies,
} from "@src/modules/MainApp/Integrations/hooks/useSystemDependencies";
import {
  PANEL_HEADER_TOKENS,
  PanelHeader,
} from "@src/modules/shared/layouts/blocks";

import DbClientsTable from "./Table/DbClientsTable";

interface DbClientsPageProps {
  embedded?: boolean;
  onBack?: () => void;
  selectedDbClient?: DependencyStatus | null;
  onSelectDbClient?: (client: DependencyStatus | null) => void;
}

const DbClientsPage: React.FC<DbClientsPageProps> = ({
  embedded = false,
  onBack,
  selectedDbClient,
  onSelectDbClient,
}) => {
  const { t } = useTranslation("settings");

  const { isLoading, isRefreshing, refresh, byCategory } =
    useSystemDependencies();

  const dbClients = byCategory(["database"]);

  const { spinClass: refreshSpinClass, handleClick: handleRefreshClick } =
    useRefreshSpin(refresh, isRefreshing);

  const tableContent = (
    <DbClientsTable
      clients={dbClients}
      loading={isLoading}
      selectedClientId={selectedDbClient?.binary ?? null}
      onSelectClient={onSelectDbClient}
    />
  );

  if (embedded) {
    return tableContent;
  }

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <PanelHeader
        onBack={onBack}
        breadcrumb={{
          parent: t("integrations:categories.databases"),
          current: t("dependencies.categoryDatabase"),
        }}
        actions={
          <Button
            {...PANEL_HEADER_TOKENS.actionButton}
            onClick={handleRefreshClick}
            disabled={isRefreshing}
            icon={
              <HugeiconsIcon
                icon={Refresh04Icon}
                data-icon="refresh-cw"
                size={PANEL_HEADER_TOKENS.buttonIconSize}
                strokeWidth={PANEL_HEADER_TOKENS.iconStrokeWidth}
                className={refreshSpinClass}
              />
            }
            title="Refresh"
          />
        }
      />
      <div className="scrollbar-overlay min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[1000px] flex-col gap-4 px-6 py-6">
          {tableContent}
        </div>
      </div>
    </div>
  );
};

export default DbClientsPage;
