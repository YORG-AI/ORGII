import React, { Suspense, lazy, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { DatabaseIcon } from "@src/assets/databaseIcons";
import Button from "@src/components/Button";
import InlineAlert from "@src/components/InlineAlert";
import SettingsTable, {
  SETTINGS_TABLE_CELL,
  SETTINGS_TABLE_COL,
  type SettingsTableColumn,
} from "@src/components/SettingsTable";
import TabPill from "@src/components/TabPill";
import type { DependencyStatus } from "@src/hooks/dependencies";
import {
  DETAIL_PANEL_TOKENS,
  DetailPanelContainer,
  InternalHeader,
  Placeholder,
  ScrollPreservation,
} from "@src/modules/shared/layouts/blocks";
import { InfoRow } from "@src/modules/shared/layouts/blocks/InfoRow";

import {
  InlineCardBody,
  InlineCardColumnStack,
  InlineCardFooter,
  InlineCardShell,
  InlineCardSplit,
} from "../../KeyVault/shared/InlineCardPrimitives";
import { ThirdPartyDisclaimer } from "../../Tables/TrademarkDisclaimer";
import {
  RowChevron,
  StatusDot,
  selectedRowClassName,
} from "../../Tables/shared";
import {
  DATABASE_PROVIDER_LABEL_KEY,
  DATABASE_STATUS_DOT_COLOR,
} from "../config";
import type { DatabaseIntegrationEntry, DatabaseProbeResult } from "../types";

const DbClientsPage = lazy(() => import("../DbClientsPage"));

interface DatabasesTableProps {
  databases: DatabaseIntegrationEntry[];
  loading: boolean;
  selectedRowId?: string | null;
  onSelect: (id: string | null) => void;
  onAdd: () => void;
  onRefresh?: () => Promise<void>;
  activeTab?: string;
  onActiveTabChange?: (tab: string) => void;
  selectedDbClient?: DependencyStatus | null;
  onSelectDbClient?: (client: DependencyStatus | null) => void;
  onProbe?: () => void;
  onRemove?: () => void;
  probeResult?: DatabaseProbeResult | null;
  probing?: boolean;
}

export const DatabasesTable: React.FC<DatabasesTableProps> = ({
  databases,
  loading,
  selectedRowId,
  onSelect,
  onAdd,
  activeTab: activeTabProp,
  onActiveTabChange,
  selectedDbClient,
  onSelectDbClient,
  onProbe,
  onRemove,
  probeResult,
  probing,
}) => {
  const [expandedKeys, setExpandedKeys] = useState<string[]>([]);
  const { t } = useTranslation("integrations");
  const [searchQuery, setSearchQuery] = useState("");
  const [internalActiveTab, setInternalActiveTab] = useState("databases");

  const activeTab = activeTabProp ?? internalActiveTab;
  const setActiveTab = useCallback(
    (tab: string) => {
      onActiveTabChange?.(tab);
      if (activeTabProp == null) {
        setInternalActiveTab(tab);
      }
    },
    [onActiveTabChange, activeTabProp]
  );

  const tabs = useMemo(
    () => [
      { key: "databases", label: t("databases.title", "Databases") },
      {
        key: "db-clients",
        label: t("settings:dependencies.categoryDatabase"),
      },
    ],
    [t]
  );

  const filteredRows = useMemo(() => {
    if (!searchQuery) return databases;
    const query = searchQuery.toLowerCase();
    return databases.filter(
      (row) =>
        row.name.toLowerCase().includes(query) ||
        row.type.toLowerCase().includes(query) ||
        row.url.toLowerCase().includes(query)
    );
  }, [databases, searchQuery]);

  const handleRowClick = useCallback(
    (row: DatabaseIntegrationEntry) => {
      onSelect(selectedRowId === row.id ? null : row.id);
    },
    [onSelect, selectedRowId]
  );

  const handleRowExpand = useCallback(
    (row: DatabaseIntegrationEntry) => {
      onSelect(row.id);
    },
    [onSelect]
  );

  const columns = useMemo<SettingsTableColumn<DatabaseIntegrationEntry>[]>(
    () => [
      {
        key: "name",
        label: t("common:labels.name"),
        width: SETTINGS_TABLE_COL.fill,
        sorter: (rowA, rowB) => rowA.name.localeCompare(rowB.name),
        renderCell: (row) => (
          <span className={`${SETTINGS_TABLE_CELL.primary} font-bold`}>
            {row.name}
          </span>
        ),
      },
      {
        key: "type",
        label: t("databases.detail.type"),
        width: SETTINGS_TABLE_COL.valueMd,
        sorter: (rowA, rowB) => rowA.type.localeCompare(rowB.type),
        renderCell: (row) => (
          <span
            className={`${SETTINGS_TABLE_CELL.value} inline-flex items-center gap-2`}
          >
            <DatabaseIcon type={row.type} size={16} />
            {row.type.charAt(0).toUpperCase() + row.type.slice(1)}
          </span>
        ),
      },
      {
        key: "status",
        label: t("databases.detail.status"),
        width: SETTINGS_TABLE_COL.valueMd,
        sorter: (rowA, rowB) =>
          rowA.connectionStatus.localeCompare(rowB.connectionStatus),
        renderCell: (row) => (
          <StatusDot
            color={
              DATABASE_STATUS_DOT_COLOR[row.connectionStatus] ?? "bg-fill-3"
            }
            label={row.connectionStatus}
          />
        ),
      },
      {
        key: "actions",
        label: "",
        width: SETTINGS_TABLE_COL.hug,
        align: "right",
        renderCell: (row) => (
          <RowChevron onClick={() => handleRowExpand(row)} />
        ),
      },
    ],
    [t, handleRowExpand]
  );

  return (
    <DetailPanelContainer>
      <InternalHeader
        noPanelHeader
        contentPadding
        className={DETAIL_PANEL_TOKENS.headerWidth}
        tabs={
          <TabPill
            tabs={tabs}
            activeTab={activeTab}
            onChange={setActiveTab}
            variant="simple"
            fillWidth={false}
            size="large"
          />
        }
      />
      <ScrollPreservation className={DETAIL_PANEL_TOKENS.scrollContentNoTop}>
        <div className={DETAIL_PANEL_TOKENS.contentWidthWithPaddingNoTop}>
          <div className="flex flex-col gap-3">
            {activeTab === "db-clients" ? (
              <Suspense
                fallback={
                  <Placeholder variant="loading" placement="detail-panel" />
                }
              >
                <DbClientsPage
                  embedded
                  selectedDbClient={selectedDbClient}
                  onSelectDbClient={onSelectDbClient}
                />
              </Suspense>
            ) : (
              <SettingsTable<DatabaseIntegrationEntry>
                hover
                loading={loading}
                columns={columns}
                rows={filteredRows}
                getRowKey={(row) => row.id}
                onRowClick={handleRowClick}
                rowClassName={selectedRowClassName(
                  (row: DatabaseIntegrationEntry) => row.id,
                  selectedRowId
                )}
                headerHeight="tall"
                searchBar={{
                  searchValue: searchQuery,
                  onSearchChange: setSearchQuery,
                  searchPlaceholder: t("databases.searchPlaceholder"),
                  allowSearchClear: true,
                }}
                emptyTitle={t("databases.noConnections")}
                emptyAction={{
                  label: t("addOptions.addDatabase"),
                  onClick: onAdd,
                }}
                expandable={{
                  expandedRowKeys: expandedKeys,
                  onExpandedRowsChange: (keys) => {
                    // Probe/Remove handlers in the parent close over
                    // `selectedDatabase`. Auto-select the expanded row so
                    // those callbacks always target the row the user is
                    // looking at, without depending on an extra row click.
                    const next = keys.slice(-1);
                    setExpandedKeys(next);
                    onSelect(next[0] ?? null);
                  },
                  expandedRowRender: (row) => {
                    const dotColor =
                      DATABASE_STATUS_DOT_COLOR[row.connectionStatus] ??
                      "bg-fill-3";
                    const statusColor =
                      row.connectionStatus === "connected"
                        ? "text-success-6"
                        : row.connectionStatus === "error"
                          ? "text-danger-6"
                          : "text-text-3";
                    return (
                      <div className="w-0 min-w-full overflow-hidden">
                        <InlineCardShell>
                          <InlineCardBody>
                            <InlineCardSplit
                              left={
                                <InlineCardColumnStack>
                                  <InfoRow label={t("databases.detail.type")}>
                                    <span className="inline-flex items-center gap-2 text-[12px] text-text-1">
                                      <DatabaseIcon type={row.type} size={14} />
                                      {t(DATABASE_PROVIDER_LABEL_KEY[row.type])}
                                    </span>
                                  </InfoRow>
                                  <InfoRow label={t("databases.detail.status")}>
                                    <StatusDot
                                      size="inline"
                                      color={dotColor}
                                      label={row.connectionStatus}
                                      labelClassName={`text-[12px] font-medium ${statusColor}`}
                                    />
                                  </InfoRow>
                                  {row.connectionError && (
                                    <InfoRow label={t("mcpPreview.error")}>
                                      <span className="max-w-[240px] truncate text-[12px] text-danger-6">
                                        {row.connectionError}
                                      </span>
                                    </InfoRow>
                                  )}
                                  <InfoRow
                                    label={t("databases.detail.url")}
                                    layout="vertical"
                                  >
                                    <span className="break-all text-[12px] text-text-1">
                                      {row.url || "—"}
                                    </span>
                                  </InfoRow>
                                </InlineCardColumnStack>
                              }
                              right={
                                probeResult && selectedRowId === row.id ? (
                                  <InlineCardColumnStack>
                                    <InlineAlert
                                      type={
                                        probeResult.ok ? "success" : "danger"
                                      }
                                      title={`${probeResult.ok ? t("databases.detail.probeSuccess") : t("databases.detail.probeFailed")} (${probeResult.elapsed_ms}ms)`}
                                    >
                                      {probeResult.ok &&
                                        probeResult.tableCount !==
                                          undefined && (
                                          <span className="text-[12px]">
                                            {probeResult.tableCount} tables
                                          </span>
                                        )}
                                      {probeResult.error && (
                                        <span className="text-[12px]">
                                          {probeResult.error}
                                        </span>
                                      )}
                                    </InlineAlert>
                                  </InlineCardColumnStack>
                                ) : (
                                  <InlineCardColumnStack>
                                    {null}
                                  </InlineCardColumnStack>
                                )
                              }
                            />
                          </InlineCardBody>
                          {(onProbe || onRemove) && (
                            <InlineCardFooter>
                              {onProbe && (
                                <Button
                                  variant="secondary"
                                  size="small"
                                  onClick={() => {
                                    onSelect(row.id);
                                    onProbe();
                                  }}
                                  loading={probing && selectedRowId === row.id}
                                >
                                  {t("databases.detail.testConnection")}
                                </Button>
                              )}
                              {onRemove && (
                                <Button
                                  variant="danger"
                                  appearance="outline"
                                  size="small"
                                  onClick={() => {
                                    onSelect(row.id);
                                    onRemove();
                                  }}
                                >
                                  {t("common:actions.remove")}
                                </Button>
                              )}
                            </InlineCardFooter>
                          )}
                        </InlineCardShell>
                      </div>
                    );
                  },
                }}
              />
            )}
            <ThirdPartyDisclaimer />
          </div>
        </div>
      </ScrollPreservation>
    </DetailPanelContainer>
  );
};
