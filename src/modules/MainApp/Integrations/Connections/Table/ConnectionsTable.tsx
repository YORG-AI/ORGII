import { Trash2 } from "lucide-react";
import React, { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  STORY_SYNC_ADAPTER,
  type SyncConnection,
} from "@src/api/http/integrations";
import Button from "@src/components/Button";
import IntegrationIcon from "@src/components/IntegrationIcon";
import { Placeholder } from "@src/components/Placeholder";
import SettingsTable, {
  SETTINGS_TABLE_CELL,
  SETTINGS_TABLE_COL,
  type SettingsTableColumn,
} from "@src/components/SettingsTable";
import TabPill from "@src/components/TabPill";
import {
  DETAIL_PANEL_TOKENS,
  DetailPanelContainer,
  InternalHeader,
  ScrollPreservation,
} from "@src/modules/shared/layouts/blocks";
import { InfoRow } from "@src/modules/shared/layouts/blocks/InfoRow";

import {
  InlineCardBody,
  InlineCardColumnStack,
  InlineCardShell,
  InlineCardSplit,
} from "../../KeyVault/shared/InlineCardPrimitives";
import { ThirdPartyDisclaimer } from "../../Tables/TrademarkDisclaimer";
import { StatusDot, selectedRowClassName } from "../../Tables/shared";
import type { DetailMode } from "../../types";
import { CHANNEL_TYPES, type ChannelInstance } from "../Channels";
import GatewayAgentCard from "../Channels/GatewayAgentCard";
import { STATUS_DOT_COLOR } from "../Channels/types";

const CONNECTIONS_TAB = {
  CONNECTIONS: "connections",
  GATEWAY: "gateway",
  DISCOVER: "discover",
} as const;

type ConnectionsTab = (typeof CONNECTIONS_TAB)[keyof typeof CONNECTIONS_TAB];

function isConnectionsTab(value: string | null): value is ConnectionsTab {
  return Object.values(CONNECTIONS_TAB).includes(value as ConnectionsTab);
}

interface ConnectionRow {
  id: string;
  name: string;
  typeName: string;
  typeIcon: string;
  statusColor: string;
  statusLabel: string;
  kind: "channel" | "project";
  // Carries the underlying object identity so the row-action handlers
  // (trash icon) can dispatch without re-deriving from the composite id.
  channel?: { type: string; accountId: string };
  project?: { connectionId: string; label: string };
}

function getProjectConnectionTypeKey(connection: SyncConnection): string {
  switch (connection.adapter_id) {
    case STORY_SYNC_ADAPTER.LINEAR:
      return "projectConnections.linear";
    case STORY_SYNC_ADAPTER.GITHUB:
      return "gitConnections.github";
  }
}

function getProjectConnectionIcon(connection: SyncConnection): string {
  switch (connection.adapter_id) {
    case STORY_SYNC_ADAPTER.LINEAR:
      return "linear";
    case STORY_SYNC_ADAPTER.GITHUB:
      return "github";
  }
}

interface ConnectionsTableProps {
  groupedChannels: Map<string, ChannelInstance[]>;
  projectConnections: SyncConnection[];
  loading: boolean;
  selectedRowId?: string | null;
  onSelectChannel: (compositeId: string | null, mode?: DetailMode) => void;
  onAdd: () => void;
  onRemoveChannel?: (channelType: string, accountId: string) => Promise<void>;
  onRemoveProjectConnection?: (
    connectionId: string,
    label: string
  ) => Promise<void>;
}

export const ConnectionsTable: React.FC<ConnectionsTableProps> = ({
  groupedChannels,
  projectConnections,
  loading,
  selectedRowId,
  onSelectChannel,
  onAdd,
  onRemoveChannel,
  onRemoveProjectConnection,
}) => {
  const { t } = useTranslation("integrations");
  const { t: tCommon } = useTranslation("common");
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedKeys, setExpandedKeys] = useState<string[]>([]);
  const [removingRowId, setRemovingRowId] = useState<string | null>(null);

  const handleRemoveRow = useCallback(
    async (row: ConnectionRow) => {
      setRemovingRowId(row.id);
      try {
        if (row.kind === "channel" && row.channel) {
          await onRemoveChannel?.(row.channel.type, row.channel.accountId);
        } else if (row.kind === "project" && row.project) {
          await onRemoveProjectConnection?.(
            row.project.connectionId,
            row.project.label
          );
        }
        setExpandedKeys((current) => current.filter((key) => key !== row.id));
      } finally {
        setRemovingRowId(null);
      }
    },
    [onRemoveChannel, onRemoveProjectConnection]
  );

  const rows = useMemo<ConnectionRow[]>(() => {
    const result: ConnectionRow[] = [];

    for (const channelType of CHANNEL_TYPES) {
      const instances = groupedChannels.get(channelType.type);
      if (!instances) continue;
      for (const instance of instances) {
        const statusColor =
          STATUS_DOT_COLOR[instance.connectionStatus] ?? "bg-fill-3";
        result.push({
          id: `${instance.type}:${instance.accountId}`,
          name: instance.accountId,
          typeName: t(channelType.labelKey),
          typeIcon: instance.type,
          statusColor,
          statusLabel: instance.connectionStatus,
          kind: "channel",
          channel: { type: instance.type, accountId: instance.accountId },
        });
      }
    }

    for (const connection of projectConnections) {
      result.push({
        id: `project:${connection.id}`,
        name: connection.label,
        typeName: t(getProjectConnectionTypeKey(connection)),
        typeIcon: getProjectConnectionIcon(connection),
        statusColor: "bg-success-6",
        statusLabel: t("status.connected"),
        kind: "project",
        project: { connectionId: connection.id, label: connection.label },
      });
    }

    if (!searchQuery) return result;
    const query = searchQuery.toLowerCase();
    return result.filter(
      (row) =>
        row.name.toLowerCase().includes(query) ||
        row.typeName.toLowerCase().includes(query)
    );
  }, [groupedChannels, searchQuery, projectConnections, t]);

  const handleRowClick = useCallback(
    (row: ConnectionRow, mode?: DetailMode) => {
      if (row.kind === "project") return;
      if (!mode && selectedRowId === row.id) {
        onSelectChannel(null);
        return;
      }
      onSelectChannel(row.id, mode);
    },
    [onSelectChannel, selectedRowId]
  );

  const connectionsTabs = useMemo(
    () => [
      {
        key: CONNECTIONS_TAB.CONNECTIONS,
        label: t("connectionsTabs.connections"),
      },
      {
        key: CONNECTIONS_TAB.GATEWAY,
        label: t("connectionsTabs.gateway"),
      },
      { key: CONNECTIONS_TAB.DISCOVER, label: t("connectionsTabs.discover") },
    ],
    [t]
  );

  const [connectionsActiveTab, setConnectionsActiveTabState] =
    useState<ConnectionsTab>(CONNECTIONS_TAB.CONNECTIONS);

  const setConnectionsActiveTab = useCallback((tab: string) => {
    setConnectionsActiveTabState(
      isConnectionsTab(tab) ? tab : CONNECTIONS_TAB.CONNECTIONS
    );
  }, []);

  const columns = useMemo<SettingsTableColumn<ConnectionRow>[]>(
    () => [
      {
        key: "name",
        label: t("common:labels.name"),
        width: SETTINGS_TABLE_COL.fill,
        sorter: (rowA, rowB) => rowA.name.localeCompare(rowB.name),
        renderCell: (row) => (
          <span
            className={`${SETTINGS_TABLE_CELL.primary} inline-flex items-center gap-2 font-bold`}
          >
            <IntegrationIcon type={row.typeIcon} size={16} />
            <span>{row.name}</span>
          </span>
        ),
      },
      {
        key: "type",
        label: t("tableHeaders.type"),
        width: SETTINGS_TABLE_COL.valueMd,
        sorter: (rowA, rowB) => rowA.typeName.localeCompare(rowB.typeName),
        renderCell: (row) => (
          <span className={SETTINGS_TABLE_CELL.value}>{row.typeName}</span>
        ),
      },
      {
        key: "status",
        label: t("common:labels.status"),
        width: SETTINGS_TABLE_COL.valueSm,
        sorter: (rowA, rowB) =>
          rowA.statusLabel.localeCompare(rowB.statusLabel),
        renderCell: (row) => (
          <StatusDot color={row.statusColor} label={row.statusLabel} />
        ),
      },
      {
        key: "actions",
        label: <span className="sr-only">{tCommon("actions.remove")}</span>,
        width: "64px",
        align: "right",
        renderCell: (row) => (
          <div className="flex h-full min-w-[44px] items-center justify-end gap-2">
            <Button
              variant="secondary"
              size="small"
              icon={<Trash2 size={14} className="text-danger-6" />}
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
    [t, tCommon, handleRemoveRow, removingRowId]
  );

  return (
    <DetailPanelContainer>
      <InternalHeader
        noPanelHeader
        contentPadding
        className={DETAIL_PANEL_TOKENS.headerWidth}
        tabs={
          <TabPill
            tabs={connectionsTabs}
            activeTab={connectionsActiveTab}
            onChange={setConnectionsActiveTab}
            variant="simple"
            fillWidth={false}
            size="large"
          />
        }
      />
      <ScrollPreservation className={DETAIL_PANEL_TOKENS.scrollContentNoTop}>
        <div className={DETAIL_PANEL_TOKENS.contentWidthWithPaddingNoTop}>
          <div className="flex flex-col gap-3">
            {connectionsActiveTab === CONNECTIONS_TAB.GATEWAY ? (
              <GatewayAgentCard />
            ) : connectionsActiveTab === CONNECTIONS_TAB.DISCOVER ? (
              <Placeholder
                variant="empty"
                placement="detail-panel"
                title={t("connectionsTabs.comingSoon")}
              />
            ) : (
              <SettingsTable<ConnectionRow>
                hover
                loading={loading}
                columns={columns}
                rows={rows}
                getRowKey={(row) => row.id}
                onRowClick={(row) => handleRowClick(row)}
                rowClassName={selectedRowClassName(
                  (row: ConnectionRow) => row.id,
                  selectedRowId
                )}
                headerHeight="tall"
                searchBar={{
                  searchValue: searchQuery,
                  onSearchChange: setSearchQuery,
                  searchPlaceholder: t("integrations.searchPlaceholder"),
                }}
                emptyTitle={t("integrations.noConnections")}
                emptyAction={{
                  label: t("addOptions.addConnection"),
                  onClick: onAdd,
                }}
                expandable={{
                  expandedRowKeys: expandedKeys,
                  onExpandedRowsChange: (keys) =>
                    setExpandedKeys(keys.slice(-1)),
                  expandedRowRender: (row) => (
                    <div className="w-0 min-w-full overflow-hidden">
                      <InlineCardShell>
                        <InlineCardBody>
                          <InlineCardSplit
                            left={
                              <InlineCardColumnStack>
                                <InfoRow
                                  label={t("tableHeaders.type")}
                                  value={row.typeName}
                                />
                                <InfoRow label={t("common:labels.status")}>
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
                        </InlineCardBody>
                      </InlineCardShell>
                    </div>
                  ),
                }}
              />
            )}
            {connectionsActiveTab === CONNECTIONS_TAB.CONNECTIONS && (
              <ThirdPartyDisclaimer />
            )}
          </div>
        </div>
      </ScrollPreservation>
    </DetailPanelContainer>
  );
};
