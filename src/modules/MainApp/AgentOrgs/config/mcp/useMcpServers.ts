/**
 * Hook for managing MCP server configuration and status.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { rpc } from "@src/api/tauri/rpc";
import type { McpConfigScope } from "@src/api/tauri/rpc/schemas/mcp";
import { useVisiblePolling } from "@src/hooks/async";
import { createLogger } from "@src/hooks/logger";
import { clearToolsCache } from "@src/modules/MainApp/Integrations/BuiltInTools/useUnifiedToolsMetadata";

const log = createLogger("MCP");

export type { McpConfigScope };

export type McpConnectionStatus =
  | "connected"
  | "connecting"
  | "disconnected"
  | "error"
  | "needsAuth"
  | "disabled";

export interface McpServerStatus {
  name: string;
  status: McpConnectionStatus;
  toolCount: number;
  error?: string;
  transportType: string;
  disabled: boolean;
  /** Unix ms when the current MCP session finished its `initialize`.
   * `null`/undefined when the server is not currently connected. */
  connectedAt?: number | null;
  /** Which config file this server comes from.
   * `"global"` → `~/.orgii/mcp-servers.json` (user-level);
   * `"workspace"` → `<workspace>/.orgii/mcp-servers.json`. */
  scope: McpConfigScope;
}

/** Per-server result from a bulk enable/disable/reconnect action.
 * `null` = that server succeeded; string = error message. */
export type McpBulkResult = Record<string, string | null>;

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpServerConfig {
  type: "stdio" | "sse" | "streamableHttp";
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  autoApprove?: string[];
  disabled: boolean;
  timeout: number;
}

export interface McpConfigFile {
  mcpServers: Record<string, McpServerConfig>;
}

export interface McpTestResult {
  success: boolean;
  toolCount: number;
  tools: McpToolDef[];
  error?: string;
  serverName?: string;
}

export interface McpResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  size?: number;
}

export interface McpResourceTemplate {
  uriTemplate: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface McpResourceContent {
  type: "text" | "blob";
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

interface UseMcpServersOptions {
  workspacePath?: string;
  /** When false, skips the initial server-list fetch and polling (no Tauri IPC on mount). */
  enabled?: boolean;
}

export function useMcpServers(options: UseMcpServersOptions = {}) {
  const { workspacePath, enabled = true } = options;
  const [servers, setServers] = useState<McpServerStatus[]>([]);
  // Start false so remounts triggered by `enabled` flips on navigation
  // don't paint a spinner before the IPC even starts. The fetch below
  // raises `loading=true` for the actual IPC window; the Placeholder
  // loading variant is debounced to hide sub-250ms loads.
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Only the latest overlapping `refresh` may clear `loading` (avoids stale `setLoading(false)` while a newer list is in flight). */
  const refreshSeqRef = useRef(0);
  // Last observed tool-count signature across all servers. When this
  // changes, the unified tools list (built-in + custom + MCP) in
  // `useUnifiedToolsMetadata` is stale; invalidate its module cache
  // so the next mount (e.g. opening the Agent Tools tab) picks up the
  // newly-connected MCP tools. Stringified so equality comparison is
  // cheap and stable across re-renders.
  const lastToolSignatureRef = useRef<string>("");

  const listServers = useCallback(() => {
    return rpc.mcp.listServers({ workspacePath });
  }, [workspacePath]);

  const updateToolSignature = useCallback((result: McpServerStatus[]) => {
    const signature = result
      .map((s) => `${s.name}:${s.status}:${s.toolCount}:${s.disabled ? 1 : 0}`)
      .sort()
      .join("|");
    if (signature !== lastToolSignatureRef.current) {
      lastToolSignatureRef.current = signature;
      clearToolsCache();
    }
  }, []);

  const refresh = useCallback(async () => {
    const seq = ++refreshSeqRef.current;
    setLoading(true);
    try {
      const result = await listServers();
      if (seq !== refreshSeqRef.current) return;
      setServers(result);
      setError(null);
      updateToolSignature(result);
    } catch (err) {
      if (seq === refreshSeqRef.current) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (seq === refreshSeqRef.current) {
        setLoading(false);
      }
    }
  }, [listServers, updateToolSignature]);

  useEffect(() => {
    if (!enabled) return;
    refresh();
  }, [refresh, enabled]);

  const hasConnecting = servers.some((s) => s.status === "connecting");

  const pollConnectingServers = useCallback(
    async (signal: AbortSignal) => {
      try {
        const result = await listServers();
        if (signal.aborted) return false;
        setServers(result);
        updateToolSignature(result);
        return result.some((server) => server.status === "connecting");
      } catch {
        return true;
      }
    },
    [listServers, updateToolSignature]
  );

  useVisiblePolling({
    enabled: enabled && hasConnecting,
    intervalMs: 2000,
    poll: pollConnectingServers,
  });

  const getConfig = useCallback(
    async (scope?: McpConfigScope) => {
      return rpc.mcp.getConfig({ workspacePath, scope });
    },
    [workspacePath]
  );

  const refreshAfterConfigDelete = useCallback(
    async (deletedServers: Array<{ name: string; scope: McpConfigScope }>) => {
      if (deletedServers.length === 0) {
        await refresh();
        return;
      }

      const retryDelaysMs = [100, 300, 700];
      for (const delayMs of retryDelaysMs) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        const result = await listServers();
        const hasDeletedServer = deletedServers.some((deletedServer) =>
          result.some(
            (server) =>
              server.name === deletedServer.name &&
              server.scope === deletedServer.scope
          )
        );
        if (!hasDeletedServer) {
          setServers(result);
          updateToolSignature(result);
          return;
        }
      }
    },
    [listServers, refresh, updateToolSignature]
  );

  const updateConfig = useCallback(
    async (config: McpConfigFile, scope?: McpConfigScope) => {
      let previousServers: McpServerStatus[] | null = null;
      let deletedServers: Array<{ name: string; scope: McpConfigScope }> = [];
      if (scope) {
        const nextNames = new Set(Object.keys(config.mcpServers));
        setServers((current) => {
          previousServers = current;
          deletedServers = current
            .filter(
              (server) => server.scope === scope && !nextNames.has(server.name)
            )
            .map((server) => ({ name: server.name, scope: server.scope }));
          return current.filter(
            (server) => server.scope !== scope || nextNames.has(server.name)
          );
        });
      }

      try {
        await rpc.mcp.updateServers({ workspacePath, config, scope });
        await refreshAfterConfigDelete(deletedServers);
      } catch (error) {
        if (previousServers) {
          setServers(previousServers);
        }
        throw error;
      }
    },
    [workspacePath, refreshAfterConfigDelete]
  );

  const testServer = useCallback(
    async (name: string, config: McpServerConfig) => {
      return rpc.mcp.testServer({
        serverName: name,
        config,
      });
    },
    []
  );

  const reconnect = useCallback(
    async (name: string) => {
      try {
        await rpc.mcp.reconnectServer({ serverName: name });
      } finally {
        await refresh();
      }
    },
    [refresh]
  );

  const setDisabled = useCallback(
    async (name: string, disabled: boolean) => {
      // Optimistic UI update — flip the toggle immediately. The
      // following refresh re-syncs the row from the backend, which
      // either confirms the change or reverts it (on rejection the
      // thrown error propagates so the caller can surface a toast).
      setServers((prev) =>
        prev.map((s) =>
          s.name === name
            ? {
                ...s,
                disabled,
                status: disabled ? "disabled" : "connecting",
              }
            : s
        )
      );
      try {
        await rpc.mcp.setServerDisabled({
          serverName: name,
          disabled,
          workspacePath,
        });
      } finally {
        await refresh();
      }
    },
    [workspacePath, refresh]
  );

  const bulkSetDisabled = useCallback(
    async (names: string[], disabled: boolean): Promise<McpBulkResult> => {
      setServers((prev) =>
        prev.map((s) =>
          names.includes(s.name)
            ? {
                ...s,
                disabled,
                status: disabled ? "disabled" : "connecting",
              }
            : s
        )
      );
      try {
        const result = await rpc.mcp.bulkSetDisabled({
          serverNames: names,
          disabled,
          workspacePath,
        });
        await refresh();
        return result;
      } catch (err) {
        log.error("[MCP] Failed to bulk set disabled:", err);
        await refresh();
        throw err;
      }
    },
    [workspacePath, refresh]
  );

  const bulkReconnect = useCallback(
    async (names: string[]): Promise<McpBulkResult> => {
      setServers((prev) =>
        prev.map((s) =>
          names.includes(s.name) && !s.disabled
            ? { ...s, status: "connecting" }
            : s
        )
      );
      try {
        const result = await rpc.mcp.bulkReconnect({ serverNames: names });
        await refresh();
        return result;
      } catch (err) {
        log.error("[MCP] Failed to bulk reconnect:", err);
        await refresh();
        throw err;
      }
    },
    [refresh]
  );

  const listTools = useCallback(async (name: string) => {
    return rpc.mcp.listServerTools({
      serverName: name,
    });
  }, []);

  const listResources = useCallback(async (name: string) => {
    return rpc.mcp.listResources({
      serverName: name,
    });
  }, []);

  const readResource = useCallback(async (name: string, uri: string) => {
    return rpc.mcp.readResource({
      serverName: name,
      uri,
    });
  }, []);

  const listResourceTemplates = useCallback(async (name: string) => {
    return rpc.mcp.listResourceTemplates({
      serverName: name,
    });
  }, []);

  return {
    servers,
    loading,
    error,
    refresh,
    getConfig,
    updateConfig,
    testServer,
    reconnect,
    setDisabled,
    bulkSetDisabled,
    bulkReconnect,
    listTools,
    listResources,
    readResource,
    listResourceTemplates,
  };
}
