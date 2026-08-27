/**
 * McpDetailView — resolver that finds the selected MCP server and
 * renders McpServerDetailPanel, or shows a loading/empty placeholder.
 */
import React from "react";
import { useTranslation } from "react-i18next";

import McpIcon from "@src/assets/channelIcons/mcp.svg";
import { Placeholder } from "@src/components/Placeholder";

import type { McpDetailState } from "../types";
import McpServerDetailPanel from "./McpServerDetailPanel";

interface McpDetailViewProps {
  selectedId: string | null;
  mcp: McpDetailState;
  onBack?: () => void;
  onExpand?: () => void;
}

export const McpDetailView: React.FC<McpDetailViewProps> = ({
  selectedId,
  mcp,
  onBack,
  onExpand,
}) => {
  const { t } = useTranslation("integrations");

  if (mcp.loading && mcp.servers.length === 0) {
    return <Placeholder variant="loading" placement="detail-panel" />;
  }

  const selectedServer = mcp.servers.find(
    (server) => server.name === selectedId
  );
  if (selectedServer) {
    return (
      <McpServerDetailPanel
        server={selectedServer}
        tools={mcp.tools}
        toolsLoading={mcp.toolsLoading}
        resources={mcp.resources}
        resourcesLoading={mcp.resourcesLoading}
        onReconnect={mcp.onReconnect}
        onEdit={mcp.onEdit}
        onDelete={mcp.onDelete}
        onFetchTools={mcp.onFetchTools}
        onFetchResources={mcp.onFetchResources}
        onBack={onBack}
        onExpand={onExpand}
      />
    );
  }

  if (mcp.servers.length === 0) {
    return (
      <Placeholder
        variant="empty"
        placement="detail-panel"
        icon={<McpIcon className="h-8 w-8" />}
        title={t("mcp.noServers")}
        subtitle={t("mcp.noServersDesc")}
      />
    );
  }

  return (
    <Placeholder
      variant="empty"
      placement="detail-panel"
      icon={<McpIcon className="h-8 w-8" />}
      title={t("common:placeholders.selectToViewConfig", {
        type: t("common:placeholderTypes.mcpServer"),
      })}
      subtitle={t("common:placeholders.selectToViewConfigSubtitle")}
    />
  );
};
