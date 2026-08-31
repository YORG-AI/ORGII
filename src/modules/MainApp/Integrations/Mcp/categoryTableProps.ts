import type { ComponentProps } from "react";

import type { useExtensionsState } from "../hooks/useExtensionsState";
import type { McpTable } from "./Table/McpTable";

export type McpCategoryTableProps = Omit<
  ComponentProps<typeof McpTable>,
  "tools" | "resources"
>;

export function getMcpCategoryTableProps(params: {
  extensions: Pick<
    ReturnType<typeof useExtensionsState>,
    "mcpServers" | "handleExtensionSelect" | "triggerMcpAdd" | "mcp"
  >;
}): McpCategoryTableProps {
  return {
    servers: params.extensions.mcpServers.servers,
    loading: params.extensions.mcpServers.loading,
    onSelect: params.extensions.handleExtensionSelect,
    onAdd: (scope) => params.extensions.triggerMcpAdd(scope),
    onDelete: params.extensions.mcp.onDelete,
    onReconnect: params.extensions.mcp.onReconnect,
    onSetDisabled: params.extensions.mcp.onSetDisabled,
    onBulkSetDisabled: params.extensions.mcp.onBulkSetDisabled,
    onBulkReconnect: params.extensions.mcp.onBulkReconnect,
    onAfterImport: params.extensions.mcp.onRefresh,
  };
}
