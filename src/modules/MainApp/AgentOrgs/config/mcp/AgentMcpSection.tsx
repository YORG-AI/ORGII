/**
 * Agent MCP Section
 *
 * Per-server enable toggle plus an expandable per-tool checklist for
 * the active SDE / OS agent. Management (add/edit/remove) lives in
 * Extensions > MCP. This section only edits the agent definition's
 * `disabledMcpServers` / `disabledMcpTools` arrays.
 *
 * The hook prop lets us share the section between OS and SDE agents
 * without duplicating the UI — both expose the same `{ config, loaded,
 * update }` shape, and both serialize the disabled arrays at the same
 * top-level path inside the legacy blob.
 */
import { Plus } from "lucide-react";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { rpc } from "@src/api/tauri/rpc";
import Button from "@src/components/Button";
import Message from "@src/components/Message";
import SettingsTable, {
  SETTINGS_TABLE_COL,
  type SettingsTableColumn,
} from "@src/components/SettingsTable";
import Switch from "@src/components/Switch";
import { useAppNavigation } from "@src/hooks/navigation/useAppNavigation";
import {
  McpEnabledSwitchCell,
  McpServerNameCell,
  McpToolCountCell,
  McpTransportCell,
  StatusChip,
} from "@src/modules/MainApp/Integrations/Mcp/Table/McpTableParts";

import { getNestedStringArray } from "../osAgent/utils";
import {
  type McpServerStatus,
  type McpToolDef,
  useMcpServers,
} from "./useMcpServers";

/** Tool-name encoding shared with the Rust bridge — must match
 *  `bridge.rs should_skip_mcp_tool` so the UI's per-tool toggle
 *  actually filters the runtime tool list. */
function encodeToolKey(serverName: string, toolName: string): string {
  return `mcp__${serverName}__${toolName}`;
}

export interface UseAgentConfig {
  config: Record<string, unknown>;
  loaded: boolean;
  update: (path: string, value: unknown) => void;
}

interface AgentMcpSectionProps {
  /**
   * The per-agent config hook. Inject `useOSAgentConfig` for OS or
   * `useSdeAgentConfig` for SDE — both expose the same shape.
   */
  useConfig: () => UseAgentConfig;
  embedded?: boolean;
  onCountChange?: (count: number) => void;
}

const AgentMcpSection: React.FC<AgentMcpSectionProps> = ({
  useConfig,
  embedded = false,
  onCountChange,
}) => {
  const { t } = useTranslation("settings");
  const { t: tIntegrations } = useTranslation("integrations");
  const { goToIntegrations } = useAppNavigation();
  const { config, loaded: configLoaded, update } = useConfig();
  const { servers, loading } = useMcpServers();
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedKeys, setExpandedKeys] = useState<string[]>([]);
  const [toolsByServer, setToolsByServer] = useState<
    Record<string, McpToolDef[]>
  >({});
  const [toolsLoading, setToolsLoading] = useState<Record<string, boolean>>({});
  const fetchInFlight = useRef<Set<string>>(new Set());

  useEffect(() => {
    onCountChange?.(servers.length);
  }, [servers.length, onCountChange]);

  const disabledServers = useMemo(
    () => new Set(getNestedStringArray(config, "disabledMcpServers")),
    [config]
  );
  const disabledTools = useMemo(
    () => new Set(getNestedStringArray(config, "disabledMcpTools")),
    [config]
  );

  // Orphan cleanup: trim disabled-server entries that no longer exist on disk.
  useEffect(() => {
    if (!configLoaded || loading || servers.length === 0) return;
    const serverNames = new Set(servers.map((s) => s.name));
    const currentDisabled = getNestedStringArray(config, "disabledMcpServers");
    const trimmed = currentDisabled.filter((name) => serverNames.has(name));
    if (trimmed.length !== currentDisabled.length) {
      update("disabledMcpServers", trimmed);
    }
  }, [configLoaded, loading, servers, config, update]);

  const toggleServer = useCallback(
    (serverName: string) => {
      const current = getNestedStringArray(config, "disabledMcpServers");
      const next = current.includes(serverName)
        ? current.filter((name) => name !== serverName)
        : [...current, serverName];
      update("disabledMcpServers", next);
    },
    [config, update]
  );

  const toggleTool = useCallback(
    (serverName: string, toolName: string) => {
      const key = encodeToolKey(serverName, toolName);
      const current = getNestedStringArray(config, "disabledMcpTools");
      const next = current.includes(key)
        ? current.filter((name) => name !== key)
        : [...current, key];
      update("disabledMcpTools", next);
    },
    [config, update]
  );

  const ensureToolsLoaded = useCallback(
    async (serverName: string) => {
      if (toolsByServer[serverName]) return;
      if (fetchInFlight.current.has(serverName)) return;
      fetchInFlight.current.add(serverName);
      setToolsLoading((prev) => ({ ...prev, [serverName]: true }));
      try {
        const tools = await rpc.mcp.listServerTools({ serverName });
        setToolsByServer((prev) => ({ ...prev, [serverName]: tools }));
      } catch {
        Message.error(t("sdeAgent.mcp.toolsFailed", { server: serverName }));
        setToolsByServer((prev) => ({ ...prev, [serverName]: [] }));
      } finally {
        fetchInFlight.current.delete(serverName);
        setToolsLoading((prev) => ({ ...prev, [serverName]: false }));
      }
    },
    [t, toolsByServer]
  );

  const filteredServers = useMemo(() => {
    if (!searchQuery) return servers;
    const query = searchQuery.toLowerCase();
    return servers.filter(
      (server) =>
        server.name.toLowerCase().includes(query) ||
        server.transportType.toLowerCase().includes(query)
    );
  }, [servers, searchQuery]);

  const handleExpandedRowsChange = useCallback(
    (keys: string[]) => {
      setExpandedKeys(keys);
      // Lazy-load tools for newly expanded rows.
      keys.forEach((name) => {
        const server = servers.find((s) => s.name === name);
        if (server && server.status === "connected") {
          ensureToolsLoaded(name);
        }
      });
    },
    [servers, ensureToolsLoaded]
  );

  const renderToolRow = useCallback(
    (server: McpServerStatus) => {
      const tools = toolsByServer[server.name];
      const isLoading = toolsLoading[server.name];
      const serverDisabled = disabledServers.has(server.name);

      if (server.status !== "connected") {
        return (
          <div className="px-4 py-3 text-xs text-text-3">
            {t("sdeAgent.mcp.toolsRequireConnection")}
          </div>
        );
      }

      if (isLoading || !tools) {
        return (
          <div className="px-4 py-3 text-xs text-text-3">
            {t("common:status.loading")}
          </div>
        );
      }

      if (tools.length === 0) {
        return (
          <div className="px-4 py-3 text-xs text-text-3">
            {t("sdeAgent.mcp.noTools")}
          </div>
        );
      }

      return (
        <div className="flex flex-col gap-1 px-4 py-2">
          {tools.map((tool) => {
            const key = encodeToolKey(server.name, tool.name);
            const isToolDisabled = disabledTools.has(key);
            const effectivelyDisabled = serverDisabled || isToolDisabled;
            return (
              <div
                key={tool.name}
                className="flex items-start gap-3 rounded-md px-2 py-2 hover:bg-fill-2"
                data-testid={`agent-orgs-mcp-tool-row-${server.name}-${tool.name}`}
              >
                <div className="flex flex-1 flex-col gap-0.5">
                  <span className="text-xs text-text-1">{tool.name}</span>
                  {tool.description && (
                    <span className="text-[11px] text-text-3">
                      {tool.description}
                    </span>
                  )}
                </div>
                <Switch
                  size="small"
                  checked={!effectivelyDisabled}
                  disabled={serverDisabled}
                  dataTestId={`agent-orgs-mcp-tool-switch-${server.name}-${tool.name}`}
                  onChange={() => toggleTool(server.name, tool.name)}
                />
              </div>
            );
          })}
        </div>
      );
    },
    [t, toolsByServer, toolsLoading, disabledServers, disabledTools, toggleTool]
  );

  const columns = useMemo<SettingsTableColumn<McpServerStatus>[]>(
    () => [
      {
        key: "name",
        label: t("common:labels.name"),
        width: SETTINGS_TABLE_COL.fill,
        sorter: (rowA, rowB) => rowA.name.localeCompare(rowB.name),
        renderCell: (row) => <McpServerNameCell server={row} />,
      },
      {
        key: "transport",
        label: tIntegrations("tableHeaders.transport"),
        width: SETTINGS_TABLE_COL.valueLg,
        sorter: (rowA, rowB) =>
          rowA.transportType.localeCompare(rowB.transportType),
        renderCell: (row) => <McpTransportCell server={row} />,
      },
      {
        key: "tools",
        label: tIntegrations("tableHeaders.tools"),
        width: SETTINGS_TABLE_COL.valueLg,
        sorter: (rowA, rowB) => rowA.toolCount - rowB.toolCount,
        renderCell: (row) => <McpToolCountCell server={row} />,
      },
      {
        key: "status",
        label: t("common:labels.status"),
        width: SETTINGS_TABLE_COL.valueLg,
        sorter: (rowA, rowB) => rowA.status.localeCompare(rowB.status),
        renderCell: (row) => <StatusChip status={row.status} />,
      },
      {
        key: "enabled",
        label: t("agentTools.enabled"),
        width: SETTINGS_TABLE_COL.hug,
        renderCell: (row) => (
          <McpEnabledSwitchCell
            checked={!disabledServers.has(row.name)}
            dataTestId={`agent-orgs-mcp-server-switch-${row.name}`}
            onChange={() => toggleServer(row.name)}
          />
        ),
      },
    ],
    [t, tIntegrations, disabledServers, toggleServer]
  );

  const configLoading = loading || !configLoaded;
  const isFiltered = searchQuery.length > 0;

  const handleAddServer = useCallback(() => {
    goToIntegrations({ category: "externalSkillsets", skillsetTab: "mcp" });
  }, [goToIntegrations]);

  const addServerButton = (
    <Button
      variant="secondary"
      size="default"
      icon={<Plus size={14} />}
      onClick={handleAddServer}
      data-testid="agent-orgs-add-mcp-button"
    >
      {t("sdeAgent.mcp.addServer")}
    </Button>
  );

  return (
    <SettingsTable<McpServerStatus>
      loading={configLoading}
      columns={columns}
      rows={filteredServers}
      getRowKey={(row) => row.name}
      rowDataTestId={(row) => `agent-orgs-mcp-server-row-${row.name}`}
      headerHeight={embedded ? "compact" : "tall"}
      pageSize={50}
      maxHeight={embedded ? undefined : "min(420px, calc(100vh - 280px))"}
      searchBar={{
        searchValue: searchQuery,
        onSearchChange: setSearchQuery,
        searchPlaceholder: t("sdeAgent.mcp.searchPlaceholder"),
        allowSearchClear: true,
        rightContent: addServerButton,
      }}
      expandable={{
        expandedRowRender: renderToolRow,
        expandedRowKeys: expandedKeys,
        onExpandedRowsChange: handleExpandedRowsChange,
      }}
      emptyTitle={
        isFiltered
          ? t("common:placeholders.noMatchingResults")
          : t("sdeAgent.mcp.noServers")
      }
      emptySubtitle={isFiltered ? undefined : t("sdeAgent.mcp.noServersDesc")}
    />
  );
};

export default AgentMcpSection;
