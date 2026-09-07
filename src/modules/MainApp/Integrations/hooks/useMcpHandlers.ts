/**
 * MCP-specific handlers extracted from useExtensionsState.
 */
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import type { McpConfigScope } from "@src/api/tauri/rpc/schemas/mcp";
import type {
  McpConfigFile,
  McpResource,
  McpServerConfig,
  McpToolDef,
  useMcpServers,
} from "@src/modules/MainApp/AgentOrgs/config/mcp/useMcpServers";
import { confirmDestructiveAction } from "@src/util/dialogs/confirmDestructiveAction";

export function useMcpHandlers(
  mcpServers: ReturnType<typeof useMcpServers>,
  setExtensionSelectedId: (id: string | null) => void
) {
  const { t } = useTranslation("integrations");
  const [mcpConfig, setMcpConfig] = useState<McpConfigFile>({
    mcpServers: {},
  });
  const [mcpTools, setMcpTools] = useState<McpToolDef[]>([]);
  const [mcpToolsLoading, setMcpToolsLoading] = useState(false);
  const [mcpResources, setMcpResources] = useState<McpResource[]>([]);
  const [mcpResourcesLoading, setMcpResourcesLoading] = useState(false);

  const handleMcpSave = useCallback(
    async (name: string, config: McpServerConfig, scope: McpConfigScope) => {
      // Always base the full-file write on the exact target scope. Reusing the
      // default-scope editor cache here could copy workspace sentinels into a
      // global update (or vice versa), which the backend correctly rejects.
      const scopedConfig = await mcpServers.getConfig(scope);
      const updated: McpConfigFile = {
        mcpServers: { ...scopedConfig.mcpServers, [name]: config },
      };
      await mcpServers.updateConfig(updated, scope);
      setMcpConfig((current) => ({
        mcpServers: { ...current.mcpServers, [name]: config },
      }));
    },
    [mcpServers]
  );

  const handleMcpDelete = useCallback(
    async (name: string, scope: McpConfigScope) => {
      const confirmed = await confirmDestructiveAction({
        title: t("mcp.deleteConfirmTitle", { name }),
        message: t("mcp.deleteConfirmMessage"),
        okLabel: t("common:actions.delete"),
        cancelLabel: t("common:actions.cancel"),
      });
      if (!confirmed) return false;

      // Read only the target-scope file so we never mix global and workspace
      // entries into a single write.
      const scopedConfig = await mcpServers.getConfig(scope);
      const { [name]: _removed, ...rest } = scopedConfig.mcpServers;
      await mcpServers.updateConfig({ mcpServers: rest }, scope);
      setMcpConfig((current) => {
        const { [name]: _removedCurrent, ...currentRest } = current.mcpServers;
        return { mcpServers: currentRest };
      });
      setExtensionSelectedId(null);
      return true;
    },
    [mcpServers, setExtensionSelectedId, t]
  );

  const handleMcpEdit = useCallback(
    (name: string): McpServerConfig | undefined => mcpConfig.mcpServers[name],
    [mcpConfig]
  );

  const mcpListTools = mcpServers.listTools;
  const handleMcpFetchTools = useCallback(
    (name: string) => {
      setMcpToolsLoading(true);
      setMcpTools([]);
      mcpListTools(name)
        .then(setMcpTools)
        .catch(() => setMcpTools([]))
        .finally(() => setMcpToolsLoading(false));
    },
    [mcpListTools]
  );

  const mcpListResources = mcpServers.listResources;
  const handleMcpFetchResources = useCallback(
    (name: string) => {
      setMcpResourcesLoading(true);
      setMcpResources([]);
      mcpListResources(name)
        .then(setMcpResources)
        .catch(() => setMcpResources([]))
        .finally(() => setMcpResourcesLoading(false));
    },
    [mcpListResources]
  );

  return {
    mcpConfig,
    setMcpConfig,
    mcpTools,
    mcpToolsLoading,
    mcpResources,
    mcpResourcesLoading,
    handleMcpSave,
    handleMcpDelete,
    handleMcpEdit,
    handleMcpFetchTools,
    handleMcpFetchResources,
  };
}
