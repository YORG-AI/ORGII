import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  STORY_SYNC_ADAPTER,
  STORY_SYNC_AUTH_METHOD,
  type SyncConnection,
  syncConnectionsApi,
} from "@src/api/http/integrations/syncConnections";
import Button from "@src/components/Button";
import IntegrationIcon from "@src/components/IntegrationIcon";
import SettingsTable, {
  SETTINGS_TABLE_CELL,
  SETTINGS_TABLE_COL,
  type SettingsTableColumn,
} from "@src/components/SettingsTable";
import TabPill from "@src/components/TabPill";
import { createLogger } from "@src/hooks/logger";
import { Delete02Icon, HugeiconsIcon } from "@src/icons";
import {
  DETAIL_PANEL_TOKENS,
  DetailPanelContainer,
  InlineInfoCard,
  InternalHeader,
  ScrollPreservation,
} from "@src/modules/shared/layouts/blocks";
import { InfoRow } from "@src/modules/shared/layouts/blocks/InfoRow";
import { confirmDestructiveAction } from "@src/util/dialogs/confirmDestructiveAction";

import {
  InlineCardColumnStack,
  InlineCardSplit,
} from "../../KeyVault/shared/InlineCardPrimitives";
import { ThirdPartyDisclaimer } from "../../Tables/TrademarkDisclaimer";
import { StatusDot } from "../../Tables/shared";
import type { DetailMode } from "../../types";
import GitPreferencesSection from "./GitPreferencesSection";
import GitProfilesTab from "./GitProfilesTab";

const logger = createLogger("GitTable");

interface GitRow {
  id: string;
  account: string;
  provider: string;
  access: string;
  statusColor: string;
  statusLabel: string;
  authMethod: SyncConnection["auth_method"];
  accountEmail?: string;
}

interface GitTableProps {
  loading?: boolean;
  selectedRowId?: string | null;
  onSelectProvider?: (id: string | null, mode?: DetailMode) => void;
}

function describeAuthMethod(
  authMethod: SyncConnection["auth_method"],
  t: (key: string) => string
): string {
  switch (authMethod) {
    case STORY_SYNC_AUTH_METHOD.PAT:
      return t("git.localAuthToken");
    case STORY_SYNC_AUTH_METHOD.SSH:
      return t("git.localAuthSsh");
    case STORY_SYNC_AUTH_METHOD.OAUTH:
      return t("git.githubApp");
    case STORY_SYNC_AUTH_METHOD.SCAN:
      return t("git.localProvider");
    default:
      return authMethod;
  }
}

export const GitTable: React.FC<GitTableProps> = ({
  loading: externalLoading = false,
  selectedRowId: _selectedRowId,
  onSelectProvider: _onSelectProvider,
}) => {
  const { t } = useTranslation("integrations");
  const { t: tCommon } = useTranslation("common");
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedKeys, setExpandedKeys] = useState<string[]>([]);
  const [removingRowId, setRemovingRowId] = useState<string | null>(null);
  const [connections, setConnections] = useState<SyncConnection[]>([]);
  const [internalLoading, setInternalLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("connections");

  const refresh = useCallback(async () => {
    setInternalLoading(true);
    try {
      const allConnections = await syncConnectionsApi.list();
      setConnections(
        allConnections.filter(
          (connection) => connection.adapter_id === STORY_SYNC_ADAPTER.GITHUB
        )
      );
    } catch (error) {
      logger.warn("Failed to load Git connections:", error);
    } finally {
      setInternalLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const rows = useMemo<GitRow[]>(() => {
    const allRows: GitRow[] = connections.map((connection) => ({
      id: connection.id,
      account: connection.label || connection.account_email || "GitHub",
      provider: "GitHub",
      access: describeAuthMethod(connection.auth_method, t),
      statusColor: "bg-success-6",
      statusLabel: t("status.connected"),
      authMethod: connection.auth_method,
      accountEmail: connection.account_email,
    }));

    const query = searchQuery.trim().toLowerCase();
    if (!query) return allRows;
    return allRows.filter(
      (row) =>
        row.account.toLowerCase().includes(query) ||
        row.provider.toLowerCase().includes(query) ||
        row.access.toLowerCase().includes(query)
    );
  }, [connections, searchQuery, t]);

  const handleRemoveRow = useCallback(
    async (row: GitRow) => {
      const confirmed = await confirmDestructiveAction({
        title: t("git.disconnectTitle"),
        message: t("git.disconnectMsg"),
        okLabel: tCommon("actions.delete"),
        cancelLabel: tCommon("actions.cancel"),
      });
      if (!confirmed) return;

      setRemovingRowId(row.id);
      try {
        await syncConnectionsApi.delete(row.id);
        await refresh();
        setExpandedKeys((current) => current.filter((key) => key !== row.id));
      } catch (error) {
        logger.warn("Failed to delete Git connection:", error);
      } finally {
        setRemovingRowId(null);
      }
    },
    [refresh, t, tCommon]
  );

  const columns = useMemo<SettingsTableColumn<GitRow>[]>(
    () => [
      {
        key: "account",
        label: tCommon("labels.name"),
        width: SETTINGS_TABLE_COL.fill,
        sorter: (rowA, rowB) => rowA.account.localeCompare(rowB.account),
        renderCell: (row) => (
          <span
            className={`${SETTINGS_TABLE_CELL.primary} inline-flex items-center gap-2 font-bold`}
          >
            <IntegrationIcon type="github" size={16} />
            <span>{row.account}</span>
          </span>
        ),
      },
      {
        key: "provider",
        label: t("gitPreview.provider"),
        width: SETTINGS_TABLE_COL.valueMd,
        sorter: (rowA, rowB) => rowA.provider.localeCompare(rowB.provider),
        renderCell: (row) => (
          <span className={SETTINGS_TABLE_CELL.value}>{row.provider}</span>
        ),
      },
      {
        key: "access",
        label: t("gitPreview.connections"),
        width: SETTINGS_TABLE_COL.valueMd,
        sorter: (rowA, rowB) => rowA.access.localeCompare(rowB.access),
        renderCell: (row) => (
          <span className={SETTINGS_TABLE_CELL.value}>{row.access}</span>
        ),
      },
      {
        key: "status",
        label: tCommon("labels.status"),
        width: SETTINGS_TABLE_COL.valueSm,
        sorter: (rowA, rowB) =>
          rowA.statusLabel.localeCompare(rowB.statusLabel),
        renderCell: (row) => (
          <StatusDot color={row.statusColor} label={row.statusLabel} />
        ),
      },
      {
        key: "actions",
        label: "",
        width: SETTINGS_TABLE_COL.hug,
        align: "right",
        renderCell: (row) => (
          <div className="flex h-full items-center justify-end gap-2">
            <Button
              variant="secondary"
              size="small"
              icon={
                <HugeiconsIcon
                  icon={Delete02Icon}
                  data-icon="trash-2"
                  size={14}
                  className="text-danger-6"
                />
              }
              iconOnly
              loading={removingRowId === row.id}
              disabled={removingRowId === row.id}
              aria-label={tCommon("actions.remove")}
              title={tCommon("actions.remove")}
              onClick={(event) => {
                event.stopPropagation();
                void handleRemoveRow(row);
              }}
            />
          </div>
        ),
      },
    ],
    [handleRemoveRow, removingRowId, t, tCommon]
  );

  const tabs = useMemo(
    () => [
      { key: "connections", label: t("git.connections") },
      { key: "profiles", label: t("gitProfiles.tab") },
    ],
    [t]
  );

  const connectedEmails = useMemo(
    () => [
      ...new Set(
        connections
          .map((connection) => connection.account_email?.trim())
          .filter((email): email is string => !!email)
      ),
    ],
    [connections]
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
          {activeTab === "connections" ? (
            <div className="flex flex-col gap-3">
              <SettingsTable<GitRow>
                hover
                loading={externalLoading || internalLoading}
                columns={columns}
                rows={rows}
                getRowKey={(row) => row.id}
                headerHeight="tall"
                searchBar={{
                  searchValue: searchQuery,
                  onSearchChange: setSearchQuery,
                  searchPlaceholder: t("git.searchPlaceholder"),
                }}
                emptyTitle={t("git.noProvidersFound")}
                expandable={{
                  expandedRowKeys: expandedKeys,
                  onExpandedRowsChange: (keys) =>
                    setExpandedKeys(keys.slice(-1)),
                  expandedRowRender: (row) => (
                    <InlineInfoCard>
                      <div className="flex min-w-0 flex-col gap-3">
                        <InlineCardSplit
                          equalColumns
                          left={
                            <InlineCardColumnStack>
                              <InfoRow
                                label={t("gitPreview.provider")}
                                value={row.provider}
                              />
                              <InfoRow
                                label={t("gitPreview.connections")}
                                value={row.access}
                              />
                              {row.accountEmail && (
                                <InfoRow
                                  label={tCommon("labels.email")}
                                  value={row.accountEmail}
                                />
                              )}
                              <InfoRow label={tCommon("labels.status")}>
                                <StatusDot
                                  size="inline"
                                  color={row.statusColor}
                                  label={row.statusLabel}
                                />
                              </InfoRow>
                            </InlineCardColumnStack>
                          }
                          right={
                            <InlineCardColumnStack>
                              {null}
                            </InlineCardColumnStack>
                          }
                        />
                      </div>
                    </InlineInfoCard>
                  ),
                }}
              />

              <GitPreferencesSection />
              <ThirdPartyDisclaimer />
            </div>
          ) : (
            <GitProfilesTab connectedEmails={connectedEmails} />
          )}
        </div>
      </ScrollPreservation>
    </DetailPanelContainer>
  );
};
