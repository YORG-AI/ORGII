import React, { useEffect } from "react";
import { useTranslation } from "react-i18next";

import type {
  McpResource,
  McpServerStatus,
  McpToolDef,
} from "@src/modules/MainApp/AgentOrgs/config/mcp/useMcpServers";
import { InfoRow } from "@src/modules/shared/layouts/blocks/InfoRow";

import {
  InlineCardBody,
  InlineCardColumnStack,
  InlineCardSectionLabel,
  InlineCardShell,
  InlineCardSplit,
} from "../../KeyVault/shared/InlineCardPrimitives";

interface McpInlineExpandedCardProps {
  server: McpServerStatus;
  /**
   * Tools currently held by the shared `useMcpServers` state. These reflect
   * whichever server's tools were fetched last, so we only render the list
   * when the card mounts have triggered a fetch for *this* server and
   * `isToolsForThisServer` is true.
   */
  tools: McpToolDef[];
  resources: McpResource[];
  /** True when `tools` belongs to this server (parent tracks the active fetch). */
  isToolsForThisServer: boolean;
  onFetchTools?: (name: string) => void;
}

const TOOLS_PREVIEW_COUNT = 8;

const McpInlineExpandedCard: React.FC<McpInlineExpandedCardProps> = ({
  server,
  tools,
  resources,
  isToolsForThisServer,
  onFetchTools,
}) => {
  const { t } = useTranslation("integrations");
  const [toolsExpanded, setToolsExpanded] = React.useState(false);

  // Fetch tools for this server when the inline card first mounts (i.e.
  // when the row is expanded). Avoids stale per-server tool lists that
  // were previously fetched for a different server.
  useEffect(() => {
    if (onFetchTools && server.status === "connected") {
      onFetchTools(server.name);
    }
  }, [server.name, server.status, onFetchTools]);

  const displayedTools = isToolsForThisServer ? tools : [];

  const statusLabel =
    server.status === "connected"
      ? t("mcpPreview.running")
      : server.status === "disconnected"
        ? t("mcpPreview.stopped")
        : server.status;

  const visibleTools = toolsExpanded
    ? displayedTools
    : displayedTools.slice(0, TOOLS_PREVIEW_COUNT);
  const hasMoreTools = displayedTools.length > TOOLS_PREVIEW_COUNT;

  return (
    <div className="w-0 min-w-full overflow-hidden">
      <InlineCardShell>
        <InlineCardBody>
          <InlineCardSplit
            left={
              <InlineCardColumnStack>
                <InfoRow label={t("mcpPreview.status")}>
                  <span
                    className={`text-[12px] font-medium ${
                      server.status === "connected"
                        ? "text-success-6"
                        : "text-text-3"
                    }`}
                  >
                    {statusLabel}
                  </span>
                </InfoRow>
                <InfoRow
                  label={t("mcpPreview.transport")}
                  value={server.transportType ?? "—"}
                />
                <InfoRow
                  label={t("mcpPreview.tools")}
                  value={String(displayedTools.length || server.toolCount || 0)}
                />
                <InfoRow
                  label={t("mcpPreview.resources")}
                  value={String(resources.length)}
                />
                {server.error && (
                  <InfoRow label={t("mcpPreview.error")}>
                    <span className="max-w-[240px] truncate text-[12px] text-danger-6">
                      {server.error}
                    </span>
                  </InfoRow>
                )}
              </InlineCardColumnStack>
            }
            right={
              displayedTools.length > 0 ? (
                <InlineCardColumnStack>
                  <InlineCardSectionLabel>
                    {t("mcpPreview.toolsList", {
                      count: displayedTools.length,
                    })}
                  </InlineCardSectionLabel>
                  <div className="flex flex-col gap-1">
                    {visibleTools.map((tool) => (
                      <div key={tool.name} className="flex items-center gap-2">
                        <span className="truncate text-[12px] text-text-1">
                          {tool.name}
                        </span>
                        {tool.description && (
                          <span className="truncate text-[11px] text-text-3">
                            — {tool.description}
                          </span>
                        )}
                      </div>
                    ))}
                    {hasMoreTools && !toolsExpanded && (
                      <button
                        type="button"
                        onClick={() => setToolsExpanded(true)}
                        className="mt-1 text-left text-[11px] text-text-3 hover:text-text-2"
                      >
                        +{displayedTools.length - TOOLS_PREVIEW_COUNT} more
                      </button>
                    )}
                    {toolsExpanded && hasMoreTools && (
                      <button
                        type="button"
                        onClick={() => setToolsExpanded(false)}
                        className="mt-1 text-left text-[11px] text-text-3 hover:text-text-2"
                      >
                        {t("common:actions.collapse")}
                      </button>
                    )}
                  </div>
                </InlineCardColumnStack>
              ) : (
                <InlineCardColumnStack>{null}</InlineCardColumnStack>
              )
            }
          />
        </InlineCardBody>
      </InlineCardShell>
    </div>
  );
};

export default McpInlineExpandedCard;
