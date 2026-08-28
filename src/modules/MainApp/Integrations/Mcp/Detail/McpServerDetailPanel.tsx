/**
 * McpServerDetailPanel — single MCP server detail view.
 *
 * Uses CollapsibleSections for Status / Info / Tools / Resources sections.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import AnyIcon from "@src/components/AnyIcon";
import InlineAlert from "@src/components/InlineAlert";
import { Placeholder } from "@src/components/Placeholder";
import StatusDot from "@src/components/StatusDot";
import { SPINNER_TOKENS } from "@src/config/spinnerTokens";
import {
  ComputerTerminal01Icon,
  Edit01Icon,
  File02Icon,
  HugeiconsIcon,
  Loading03Icon,
} from "@src/icons";
import type {
  McpResource,
  McpServerStatus,
  McpToolDef,
} from "@src/modules/MainApp/AgentOrgs/config/mcp/useMcpServers";
import {
  STATUS_BAR_TOKENS,
  STATUS_ICON,
  STATUS_ICON_SIZE,
} from "@src/modules/MainApp/Integrations/panelTokens";
import {
  CollapsibleSection,
  DETAIL_PANEL_TOKENS,
  DetailPanelContainer,
  InfoCard,
  PanelFooter,
  PanelHeader,
  PanelRefreshButton,
} from "@src/modules/shared/layouts/blocks";

import { DetailHeaderClose } from "../../shared/DetailHeaderClose";

interface McpServerDetailPanelProps {
  server: McpServerStatus;
  tools: McpToolDef[];
  toolsLoading: boolean;
  resources: McpResource[];
  resourcesLoading: boolean;
  onReconnect: (name: string) => Promise<void>;
  onEdit: (name: string) => void;
  onDelete: (
    name: string,
    scope: McpServerStatus["scope"]
  ) => Promise<boolean> | boolean;
  onFetchTools: (name: string) => void;
  onFetchResources: (name: string) => void;
  onBack?: () => void;
  onExpand?: () => void;
}

const McpServerDetailPanel: React.FC<McpServerDetailPanelProps> = ({
  server,
  tools,
  toolsLoading,
  resources,
  resourcesLoading,
  onReconnect,
  onEdit,
  onDelete,
  onFetchTools,
  onFetchResources,
  onBack,
  onExpand,
}) => {
  const { t } = useTranslation("integrations");
  const [reconnecting, setReconnecting] = useState(false);

  const isServerReady = server.status === "connected";

  useEffect(() => {
    if (!isServerReady) return;
    onFetchTools(server.name);
    onFetchResources(server.name);
  }, [server.name, isServerReady, onFetchTools, onFetchResources]);

  const handleReconnect = useCallback(async () => {
    setReconnecting(true);
    try {
      await onReconnect(server.name);
    } finally {
      setReconnecting(false);
    }
  }, [server.name, onReconnect]);

  const isConnected = server.status === "connected";
  const isConnecting = server.status === "connecting";

  const uptimeLabel = useMemo(() => {
    if (!isConnected || !server.connectedAt) return null;
    const elapsedSec = Math.max(
      0,
      Math.floor((Date.now() - server.connectedAt) / 1000)
    );
    if (elapsedSec < 60) return `${elapsedSec}s`;
    const minutes = Math.floor(elapsedSec / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const restMin = minutes % 60;
    return restMin === 0 ? `${hours}h` : `${hours}h ${restMin}m`;
  }, [isConnected, server.connectedAt]);

  const infoRows = useMemo(() => {
    const rows: { label: string; value: React.ReactNode }[] = [
      { label: t("mcp.transport"), value: server.transportType },
      { label: t("mcp.toolsLabel"), value: String(server.toolCount) },
      {
        label: t("mcpPreview.status"),
        value: isConnecting ? (
          <span className="flex items-center gap-1.5">
            <HugeiconsIcon
              icon={Loading03Icon}
              data-icon="loader-2"
              size={SPINNER_TOKENS.small}
              className="animate-spin text-primary-6"
            />
            {t(`mcp.statusLabels.${server.status}`, {
              defaultValue: server.status,
            })}
          </span>
        ) : (
          <StatusDot
            color={
              isConnected
                ? "bg-success-6"
                : server.status === "error"
                  ? "bg-danger-6"
                  : "bg-fill-3"
            }
            size="inline"
            label={t(`mcp.statusLabels.${server.status}`, {
              defaultValue: server.status,
            })}
          />
        ),
      },
    ];
    if (uptimeLabel) {
      rows.push({
        label: t("mcp.uptime"),
        value: uptimeLabel,
      });
    }
    if (server.disabled) {
      rows.push({
        label: t("mcp.statusLabels.disabled"),
        value: t("common:actions.yes"),
      });
    }
    return rows;
  }, [server, isConnected, isConnecting, uptimeLabel, t]);

  return (
    <DetailPanelContainer>
      <PanelHeader
        breadcrumb={{
          parent: t("mcp.tab"),
          current: server.name,
        }}
        actions={
          <>
            <PanelRefreshButton
              onRefresh={handleReconnect}
              loading={reconnecting}
              title={t("mcp.reconnect")}
            />
            <DetailHeaderClose
              onClick={onBack ?? (() => {})}
              onExpand={onExpand}
            />
          </>
        }
      />

      <div className={DETAIL_PANEL_TOKENS.scrollContent}>
        <div className={DETAIL_PANEL_TOKENS.contentWidthWithPadding}>
          <CollapsibleSection title={t("common:common.status")}>
            <div className={STATUS_BAR_TOKENS.container}>
              <span className={STATUS_BAR_TOKENS.label}>
                {isConnecting ? (
                  <HugeiconsIcon
                    icon={Loading03Icon}
                    data-icon="loader-2"
                    size={STATUS_ICON_SIZE}
                    className="animate-spin text-primary-6"
                  />
                ) : (
                  <AnyIcon
                    icon={STATUS_ICON}
                    size={STATUS_ICON_SIZE}
                    className={
                      isConnected
                        ? STATUS_BAR_TOKENS.enabledClass
                        : STATUS_BAR_TOKENS.disabledClass
                    }
                  />
                )}
                <span className={STATUS_BAR_TOKENS.labelText}>
                  {t("common:common.status")}:
                </span>
                <span
                  className={
                    isConnecting
                      ? "text-primary-6"
                      : isConnected
                        ? STATUS_BAR_TOKENS.enabledClass
                        : STATUS_BAR_TOKENS.disabledClass
                  }
                >
                  {t(`mcp.statusLabels.${server.status}`, {
                    defaultValue: server.status,
                  })}
                </span>
              </span>
            </div>
            {server.error && (
              <div className="mt-3">
                <InlineAlert type="danger" title={t("common:status.error")}>
                  {server.error}
                </InlineAlert>
              </div>
            )}
          </CollapsibleSection>

          <CollapsibleSection title={t("mcp.infoSection")}>
            <InfoCard rows={infoRows} />
          </CollapsibleSection>

          <CollapsibleSection
            title={`${t("mcp.toolsLabel")} (${server.toolCount})`}
          >
            {toolsLoading ? (
              <Placeholder variant="loading" />
            ) : tools.length === 0 ? (
              <div className="py-2 text-xs text-text-3">{t("mcp.noTools")}</div>
            ) : (
              <div className="space-y-1">
                {tools.map((tool) => (
                  <div
                    key={tool.name}
                    className="rounded-md bg-fill-1 px-3 py-2"
                  >
                    <div className="flex items-center gap-2 text-sm font-medium text-text-1">
                      <HugeiconsIcon
                        icon={ComputerTerminal01Icon}
                        data-icon="terminal"
                        size={12}
                        className="flex-shrink-0 text-text-3"
                      />
                      {tool.name}
                    </div>
                    {tool.description && (
                      <div className="mt-0.5 pl-5 text-xs text-text-3">
                        {tool.description}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CollapsibleSection>

          <CollapsibleSection
            title={`${t("mcp.resourcesLabel")} (${resources.length})`}
          >
            {resourcesLoading ? (
              <Placeholder variant="loading" />
            ) : resources.length === 0 ? (
              <div className="py-2 text-xs text-text-3">
                {t("mcp.noResources")}
              </div>
            ) : (
              <div className="space-y-1">
                {resources.map((resource) => (
                  <div
                    key={resource.uri}
                    className="rounded-md bg-fill-1 px-3 py-2"
                  >
                    <div className="flex items-center gap-2 text-sm font-medium text-text-1">
                      <HugeiconsIcon
                        icon={File02Icon}
                        data-icon="file-text"
                        size={12}
                        className="flex-shrink-0 text-text-3"
                      />
                      {resource.name}
                    </div>
                    <div className="mt-0.5 pl-5 text-xs text-text-4">
                      {resource.uri}
                    </div>
                    {resource.description && (
                      <div className="mt-0.5 pl-5 text-xs text-text-3">
                        {resource.description}
                      </div>
                    )}
                    {resource.mimeType && (
                      <div className="mt-0.5 pl-5 text-xs text-text-4">
                        {resource.mimeType}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CollapsibleSection>
        </div>
      </div>
      <PanelFooter
        primaryAction={{
          label: t("common:actions.edit"),
          onClick: () => onEdit(server.name),
          icon: <HugeiconsIcon icon={Edit01Icon} data-icon="edit" size={14} />,
          variant: "secondary",
        }}
        secondaryActions={[
          {
            label: t("common:actions.delete"),
            onClick: () => onDelete(server.name, server.scope),
            variant: "danger",
            appearance: "outline",
          },
        ]}
      />
    </DetailPanelContainer>
  );
};

export default McpServerDetailPanel;
