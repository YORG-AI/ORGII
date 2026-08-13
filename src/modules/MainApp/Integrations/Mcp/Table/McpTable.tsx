import { MoreHorizontal, Plus, Power, RefreshCw, Trash2 } from "lucide-react";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { McpConfigScope } from "@src/api/tauri/rpc/schemas/mcp";
import Button from "@src/components/Button";
import Checkbox from "@src/components/Checkbox";
import Dropdown from "@src/components/Dropdown";
import InlineAlert from "@src/components/InlineAlert";
import Menu from "@src/components/Menu";
import SettingsTable, {
  SETTINGS_TABLE_COL,
  type SettingsTableColumn,
} from "@src/components/SettingsTable";
import TabPill, { type TabPillItem } from "@src/components/TabPill";
import type { CursorRepo } from "@src/hooks/policies";
import type {
  McpBulkResult,
  McpResource,
  McpServerStatus,
  McpToolDef,
} from "@src/modules/MainApp/AgentOrgs/config/mcp/useMcpServers";
import {
  DETAIL_PANEL_TOKENS,
  ScrollPreservation,
} from "@src/modules/shared/layouts/blocks";

import { selectedRowClassName } from "../../Tables/shared";
import type { DetailMode } from "../../types";
import InlineExternalMcpImport from "./InlineExternalMcpImport";
import McpInlineExpandedCard from "./McpInlineExpandedCard";
import {
  McpEnabledSwitchCell,
  McpServerNameCell,
  McpToolCountCell,
  McpTransportCell,
  McpUptimeCell,
  StatusChip,
} from "./McpTableParts";

const SLOW_CONNECT_THRESHOLD_MS = 10_000;
type McpScopeTab = "all" | "global" | "workspace";

interface McpTableProps {
  servers: McpServerStatus[];
  tools: McpToolDef[];
  resources: McpResource[];
  loading: boolean;
  selectedRowId?: string | null;
  onSelect: (name: string, mode?: DetailMode) => void;
  onAdd: (scope: McpConfigScope) => void;
  onDelete?: (
    name: string,
    scope: McpServerStatus["scope"]
  ) => Promise<boolean> | boolean;
  onReconnect?: (name: string) => Promise<void> | void;
  onFetchTools?: (name: string) => void;
  onSetDisabled?: (name: string, disabled: boolean) => Promise<void> | void;
  onBulkSetDisabled?: (
    names: string[],
    disabled: boolean
  ) => Promise<McpBulkResult>;
  onBulkReconnect?: (names: string[]) => Promise<McpBulkResult>;
  cursorRepos?: CursorRepo[];
  onAfterImport?: () => void | Promise<void>;
  /** Omit outer panel chrome (add-button, self-owned header) when nested under ToolsCategoryView. */
  embedded?: boolean;
}

export const McpTable: React.FC<McpTableProps> = ({
  servers,
  tools,
  resources,
  loading,
  selectedRowId,
  onSelect,
  onAdd,
  onDelete,
  onReconnect,
  onFetchTools,
  onSetDisabled,
  onBulkSetDisabled,
  onBulkReconnect,
  cursorRepos,
  onAfterImport,
  embedded = false,
}) => {
  const { t } = useTranslation("integrations");
  const [searchQuery, setSearchQuery] = useState("");
  const [activeScopeTab, setActiveScopeTab] = useState<McpScopeTab>("all");
  const [checkedNames, setCheckedNames] = useState<Set<string>>(new Set());
  const [expandedKeys, setExpandedKeys] = useState<string[]>([]);
  const [deletingNames, setDeletingNames] = useState<Set<string>>(new Set());
  // Track which server the shared `tools` array belongs to so we only
  // render the tools list under the row that originally requested it.
  const [toolsOwnerName, setToolsOwnerName] = useState<string | null>(null);

  const handleFetchTools = React.useCallback(
    (name: string) => {
      setToolsOwnerName(name);
      onFetchTools?.(name);
    },
    [onFetchTools]
  );

  const connectingServers = useMemo(
    () => servers.filter((server) => server.status === "connecting"),
    [servers]
  );
  const connectingCount = connectingServers.length;

  const [slowConnect, setSlowConnect] = useState(false);
  useEffect(() => {
    if (connectingCount === 0) {
      const clearTimer = setTimeout(() => setSlowConnect(false), 0);
      return () => clearTimeout(clearTimer);
    }
    const timer = setTimeout(
      () => setSlowConnect(true),
      SLOW_CONNECT_THRESHOLD_MS
    );
    return () => clearTimeout(timer);
  }, [connectingCount]);

  // Tick once per second while any server shows uptime, so the "2m"
  // column refreshes. Skipping the tick when nothing is connected keeps
  // the render cost at zero for cold/idle state.
  const hasConnected = useMemo(
    () => servers.some((s) => s.status === "connected" && s.connectedAt),
    [servers]
  );
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!hasConnected) return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [hasConnected]);

  const filtered = useMemo(() => {
    const visibleServers = servers.filter(
      (server) => !deletingNames.has(server.name)
    );
    if (!searchQuery) return visibleServers;
    const query = searchQuery.toLowerCase();
    return visibleServers.filter(
      (server) =>
        server.name.toLowerCase().includes(query) ||
        server.transportType.toLowerCase().includes(query)
    );
  }, [deletingNames, servers, searchQuery]);

  const scopedRows = useMemo(
    () =>
      activeScopeTab === "all"
        ? filtered
        : filtered.filter((server) => server.scope === activeScopeTab),
    [activeScopeTab, filtered]
  );

  const scopeTabs = useMemo<TabPillItem[]>(
    () => [
      {
        key: "all",
        label: t("common:actions.all"),
      },
      {
        key: "global",
        label: t("mcp.userScopeLabel"),
      },
      {
        key: "workspace",
        label: t("mcp.workspaceScopeLabel"),
      },
    ],
    [t]
  );

  const handleScopeTabChange = useCallback((key: string) => {
    if (key === "all" || key === "global" || key === "workspace") {
      setActiveScopeTab(key);
      setCheckedNames(new Set());
      setExpandedKeys([]);
    }
  }, []);

  const toggleChecked = useCallback((name: string) => {
    setCheckedNames((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  // Derive the effective checked set lazily during render instead of
  // reconciling in an effect. This avoids the react-hooks/
  // set-state-in-effect rule (cascading renders) and also keeps the UI
  // state a pure function of props + local `checkedNames`: a row that
  // was deleted server-side simply drops out of `effectiveChecked`
  // without a cleanup pass. Memory growth is bounded — the user can
  // hit "Clear" to reset, and `checkedNames` only ever holds names the
  // user explicitly clicked.
  const effectiveChecked = useMemo(() => {
    if (checkedNames.size === 0) return new Set<string>();
    const present = new Set(servers.map((s) => s.name));
    const next = new Set<string>();
    for (const name of checkedNames) {
      if (present.has(name)) next.add(name);
    }
    return next;
  }, [servers, checkedNames]);

  const allFilteredChecked =
    scopedRows.length > 0 &&
    scopedRows.every((s) => effectiveChecked.has(s.name));
  const someFilteredChecked = scopedRows.some((s) =>
    effectiveChecked.has(s.name)
  );

  const toggleAllFiltered = useCallback(() => {
    setCheckedNames((prev) => {
      if (allFilteredChecked) {
        const next = new Set(prev);
        for (const s of scopedRows) next.delete(s.name);
        return next;
      }
      const next = new Set(prev);
      for (const s of scopedRows) next.add(s.name);
      return next;
    });
  }, [allFilteredChecked, scopedRows]);

  const selectedNames = useMemo(
    () => Array.from(effectiveChecked),
    [effectiveChecked]
  );

  const selectedServers = useMemo(
    () => servers.filter((s) => effectiveChecked.has(s.name)),
    [servers, effectiveChecked]
  );

  const handleBulkEnable = useCallback(async () => {
    if (!onBulkSetDisabled || selectedNames.length === 0) return;
    await onBulkSetDisabled(selectedNames, false);
  }, [onBulkSetDisabled, selectedNames]);

  const handleBulkDisable = useCallback(async () => {
    if (!onBulkSetDisabled || selectedNames.length === 0) return;
    await onBulkSetDisabled(selectedNames, true);
  }, [onBulkSetDisabled, selectedNames]);

  const handleBulkReconnect = useCallback(async () => {
    if (!onBulkReconnect || selectedNames.length === 0) return;
    // Skip disabled rows client-side too so the visible set matches
    // what the backend will actually act on. Backend is the source of
    // truth; this just keeps the count in the toast accurate.
    const actionable = selectedServers
      .filter((s) => !s.disabled)
      .map((s) => s.name);
    if (actionable.length === 0) return;
    await onBulkReconnect(actionable);
  }, [onBulkReconnect, selectedServers, selectedNames]);

  const handleDeleteServer = useCallback(
    async (server: McpServerStatus) => {
      if (!onDelete) return;
      setDeletingNames((current) => new Set(current).add(server.name));
      try {
        const deleted = await onDelete(server.name, server.scope);
        if (!deleted) return;
        setExpandedKeys((current) =>
          current.filter((key) => key !== server.name)
        );
        setCheckedNames((current) => {
          const next = new Set(current);
          next.delete(server.name);
          return next;
        });
      } finally {
        setDeletingNames((current) => {
          const next = new Set(current);
          next.delete(server.name);
          return next;
        });
      }
    },
    [onDelete]
  );

  const columns = useMemo<SettingsTableColumn<McpServerStatus>[]>(() => {
    return [
      {
        key: "check",
        label: (
          <Checkbox
            // SettingsTable has no native multi-select, so we render a
            // controlled Checkbox in the header cell and drive it from
            // local state. `someFilteredChecked && !allFilteredChecked`
            // shows the tri-state visually.
            checked={allFilteredChecked}
            onChange={toggleAllFiltered}
            indeterminate={someFilteredChecked && !allFilteredChecked}
            size="small"
          />
        ) as unknown as string,
        width: SETTINGS_TABLE_COL.hug,
        renderCell: (server) => (
          <div onClick={(e) => e.stopPropagation()} role="presentation">
            <Checkbox
              checked={effectiveChecked.has(server.name)}
              onChange={() => toggleChecked(server.name)}
              size="small"
            />
          </div>
        ),
      },
      {
        key: "name",
        label: t("common:labels.name"),
        width: SETTINGS_TABLE_COL.fill,
        sorter: (rowA, rowB) => rowA.name.localeCompare(rowB.name),
        renderCell: (server) => <McpServerNameCell server={server} />,
      },
      {
        key: "transport",
        label: t("tableHeaders.transport"),
        width: SETTINGS_TABLE_COL.valueLg,
        sorter: (rowA, rowB) =>
          rowA.transportType.localeCompare(rowB.transportType),
        renderCell: (server) => <McpTransportCell server={server} />,
      },
      {
        key: "tools",
        label: t("tableHeaders.tools"),
        width: SETTINGS_TABLE_COL.valueLg,
        sorter: (rowA, rowB) => rowA.toolCount - rowB.toolCount,
        renderCell: (server) => <McpToolCountCell server={server} />,
      },
      {
        key: "uptime",
        label: t("mcp.uptime"),
        width: SETTINGS_TABLE_COL.valueLg,
        sorter: (rowA, rowB) =>
          (rowA.connectedAt ?? 0) - (rowB.connectedAt ?? 0),
        renderCell: (server) => <McpUptimeCell server={server} nowMs={nowMs} />,
      },
      {
        key: "status",
        label: t("common:labels.status"),
        width: SETTINGS_TABLE_COL.valueLg,
        sorter: (rowA, rowB) => rowA.status.localeCompare(rowB.status),
        renderCell: (server) => <StatusChip status={server.status} />,
      },
      {
        key: "toggle",
        label: t("agentTools.enabled"),
        width: SETTINGS_TABLE_COL.hug,
        renderCell: (server) => (
          <McpEnabledSwitchCell
            checked={!server.disabled}
            onChange={(checked) => onSetDisabled?.(server.name, !checked)}
          />
        ),
      },
      {
        key: "actions",
        label: "",
        width: SETTINGS_TABLE_COL.hug,
        align: "right",
        renderCell: (server) => {
          const deleting = deletingNames.has(server.name);
          return (
            <div
              className="flex h-full items-center justify-end gap-2"
              onClick={(e) => e.stopPropagation()}
              role="presentation"
            >
              <Button
                variant="secondary"
                size="small"
                onClick={() => onSelect(server.name, "preview")}
              >
                {t("common:actions.view")}
              </Button>
              {onDelete ? (
                <Button
                  variant="secondary"
                  size="small"
                  icon={<Trash2 size={14} className="text-danger-6" />}
                  iconOnly
                  loading={deleting}
                  disabled={deleting}
                  aria-label={t("common:actions.remove")}
                  title={t("common:actions.remove")}
                  onClick={() => {
                    void handleDeleteServer(server);
                  }}
                />
              ) : null}
              {onReconnect ? (
                <Dropdown
                  trigger="click"
                  position="bottom-end"
                  droplist={
                    <Menu>
                      <Menu.Item
                        key="restart"
                        disabled={server.disabled}
                        onClick={() => onReconnect(server.name)}
                      >
                        <span className="inline-flex items-center gap-2">
                          <RefreshCw size={12} />
                          {t("mcp.restart")}
                        </span>
                      </Menu.Item>
                    </Menu>
                  }
                >
                  <button
                    className="rounded p-1 text-text-3 transition-colors hover:bg-fill-3 hover:text-text-1"
                    aria-label={t("common:actions.more")}
                  >
                    <MoreHorizontal size={14} />
                  </button>
                </Dropdown>
              ) : null}
            </div>
          );
        },
      },
    ];
  }, [
    t,
    allFilteredChecked,
    someFilteredChecked,
    toggleAllFiltered,
    effectiveChecked,
    toggleChecked,
    deletingNames,
    handleDeleteServer,
    onDelete,
    onReconnect,
    onSelect,
    onSetDisabled,
    nowMs,
  ]);

  const addMcpButton = (
    <Button
      variant="secondary"
      size="default"
      icon={<Plus size={14} />}
      onClick={() =>
        onAdd(activeScopeTab === "workspace" ? "workspace" : "global")
      }
    >
      {t("addOptions.addMcp")}
    </Button>
  );

  const connectingBanner = connectingCount > 0 && (
    <InlineAlert
      type="info"
      title={
        slowConnect
          ? t("mcp.connectingSlow")
          : t("mcp.connectingTitle", { count: connectingCount })
      }
    >
      {slowConnect ? t("mcp.connectingSlowBody") : null}
    </InlineAlert>
  );

  const bulkActionBar = selectedNames.length > 0 && (
    <div className="flex items-center justify-between rounded-md border border-border-2 bg-fill-1 px-3 py-2">
      <div className="text-[12px] text-text-2">
        {t("mcp.bulkSelected", { count: selectedNames.length })}
      </div>
      <div className="flex items-center gap-2">
        {onBulkReconnect && (
          <Button
            size="small"
            variant="tertiary"
            icon={<RefreshCw size={12} />}
            onClick={handleBulkReconnect}
          >
            {t("mcp.bulkRestart")}
          </Button>
        )}
        {onBulkSetDisabled && (
          <>
            <Button
              size="small"
              variant="tertiary"
              icon={<Power size={12} />}
              onClick={handleBulkEnable}
            >
              {t("mcp.bulkEnable")}
            </Button>
            <Button
              size="small"
              variant="tertiary"
              icon={<Power size={12} />}
              onClick={handleBulkDisable}
            >
              {t("mcp.bulkDisable")}
            </Button>
          </>
        )}
        <Button
          size="small"
          variant="tertiary"
          onClick={() => setCheckedNames(new Set())}
        >
          {t("common:actions.clear")}
        </Button>
      </div>
    </div>
  );

  const expandableConfig = useMemo(
    () => ({
      expandedRowKeys: expandedKeys,
      onExpandedRowsChange: (keys: string[]) => setExpandedKeys(keys.slice(-1)),
      expandedRowRender: (server: McpServerStatus) => (
        <McpInlineExpandedCard
          server={server}
          tools={tools}
          resources={resources}
          isToolsForThisServer={toolsOwnerName === server.name}
          onFetchTools={handleFetchTools}
        />
      ),
    }),
    [expandedKeys, tools, resources, toolsOwnerName, handleFetchTools]
  );

  const rowClassNameFn = selectedRowClassName(
    (srv: McpServerStatus) => srv.name,
    selectedRowId
  );

  const installedPanel = (
    <ScrollPreservation className={DETAIL_PANEL_TOKENS.scrollContentNoTop}>
      <div className={DETAIL_PANEL_TOKENS.contentWidthWithPaddingNoTop}>
        <div className="flex flex-col gap-3">
          {connectingBanner}
          {bulkActionBar}
          <SettingsTable<McpServerStatus>
            hover
            loading={loading}
            columns={columns}
            rows={scopedRows}
            getRowKey={(server) => server.name}
            onRowClick={(server) => onSelect(server.name)}
            rowClassName={rowClassNameFn}
            headerHeight="tall"
            searchBar={{
              searchValue: searchQuery,
              onSearchChange: setSearchQuery,
              searchPlaceholder: t("mcp.searchPlaceholder"),
              allowSearchClear: true,
              rightContent: addMcpButton,
              tabPills: (
                <TabPill
                  tabs={scopeTabs}
                  activeTab={activeScopeTab}
                  onChange={handleScopeTabChange}
                  variant="pill"
                  appearance="ghost"
                  fillWidth={false}
                  size="mini"
                />
              ),
            }}
            emptyTitle={
              activeScopeTab === "workspace"
                ? t("mcp.noWorkspaceServers")
                : t("mcp.noUserServers")
            }
            emptyAction={{
              label: t("addOptions.addMcp"),
              onClick: () =>
                onAdd(activeScopeTab === "workspace" ? "workspace" : "global"),
            }}
            expandable={expandableConfig}
          />
          <InlineExternalMcpImport
            cursorRepos={cursorRepos}
            onAfterImport={onAfterImport}
          />
        </div>
      </div>
    </ScrollPreservation>
  );

  if (embedded) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {installedPanel}
        </div>
      </div>
    );
  }

  return installedPanel;
};
