/**
 * BuiltInToolsTable — built-in tools grid for the Integrations Tools area.
 *
 * Table columns: Type | Tool | Status | Agents.
 * Expanded rows render inline cards with description, per-agent settings, and action details.
 */
import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import SettingsTable, {
  SETTINGS_TABLE_CELL,
  SETTINGS_TABLE_COL,
  type SettingsTableColumn,
} from "@src/components/SettingsTable";
import Switch from "@src/components/Switch";
import TabPill from "@src/components/TabPill";
import {
  DETAIL_PANEL_TOKENS,
  ScrollPreservation,
  ToolInlineCompactRows,
  ToolInlineInfoCard,
} from "@src/modules/shared/layouts/blocks";

import { EnabledFractionText } from "../../shared/EnabledFractionText";
import { getBuiltInToolChatIcon } from "../builtInToolIcon";
import { ALL_CATEGORY_KEY } from "../config";
import { type ToolActionEntry, type ToolRow } from "../types";
import type { UseAgentToolMatrixReturn } from "../useAgentToolMatrix";
import type { UseBuiltInToolsReturn } from "../useBuiltInTools";

interface ActionRow {
  name: string;
  summary: string;
}

function parseActionsFromMarkdown(description: string): ActionRow[] | null {
  const actionsMatch = description.match(
    /## Actions\n([\s\S]*?)(?:\n##|\n\n[A-Z]|$)/
  );
  if (!actionsMatch) return null;
  const lines = actionsMatch[1].trim().split("\n");
  const actions: ActionRow[] = [];
  for (const line of lines) {
    const match = line.match(/^-\s+\*\*([\w.]+)\*\*\s*[—–-]\s*(.+)$/);
    if (match) actions.push({ name: match[1], summary: match[2].trim() });
  }
  return actions.length > 0 ? actions : null;
}

function cleanDescriptionText(description: string): string {
  return description.replace(/\n\n## Actions[\s\S]*$/, "").trim();
}

function getToolActions(tool: ToolRow): ActionRow[] {
  const inlineActions: ToolActionEntry[] = tool.actions ?? [];
  if (inlineActions.length > 0) {
    return inlineActions.map((entry) => ({
      name: entry.name,
      summary: entry.summary,
    }));
  }
  const detailSource = tool.descriptionDetail ?? tool.description;
  const parsedActions = parseActionsFromMarkdown(detailSource);
  if (parsedActions) return parsedActions;
  return [
    {
      name: tool.name,
      summary: cleanDescriptionText(detailSource) || tool.description,
    },
  ];
}

function getToolDetailDescription(tool: ToolRow): string {
  return cleanDescriptionText(tool.descriptionDetail ?? tool.description);
}

interface BuiltInToolsTableProps {
  tools: UseBuiltInToolsReturn;
  agentMatrix: UseAgentToolMatrixReturn;
}

export const BuiltInToolsTable: React.FC<BuiltInToolsTableProps> = ({
  tools,
  agentMatrix,
}) => {
  const { t } = useTranslation("integrations");
  const { t: tSettings } = useTranslation("settings");

  const [expandedToolNames, setExpandedToolNames] = useState<string[]>([]);

  const columns = useMemo<SettingsTableColumn<ToolRow>[]>(
    () => [
      {
        key: "category",
        label: t("builtInTools.typeColumn"),
        width: "130px",
        sorter: (rowA, rowB) =>
          tools
            .categoryLabel(rowA.category)
            .localeCompare(tools.categoryLabel(rowB.category)),
        renderCell: (row) => (
          <span className={`${SETTINGS_TABLE_CELL.value} whitespace-nowrap`}>
            {tools.categoryLabel(row.category)}
          </span>
        ),
      },
      {
        key: "name",
        label: t("builtInTools.toolColumn"),
        width: SETTINGS_TABLE_COL.fill,
        sorter: (rowA, rowB) => rowA.name.localeCompare(rowB.name),
        renderCell: (row) => (
          <span className={SETTINGS_TABLE_CELL.primaryIcon}>
            {getBuiltInToolChatIcon(row.name, row.iconId)}
            <span>{row.name}</span>
          </span>
        ),
      },
      {
        key: "agents",
        label: t("builtInTools.agentsColumn"),
        width: "120px",
        sorter: (rowA, rowB) => {
          const agentSortParts = (row: ToolRow) => {
            if (row.internal) {
              return { empty: false as const, enabled: 1, total: 1 };
            }
            const rows = agentMatrix.rowsByTool(row.name);
            if (rows.length === 0) {
              return { empty: true as const, enabled: 0, total: 0 };
            }
            const enabled = rows.filter((entry) => entry.enabled).length;
            return { empty: false as const, enabled, total: rows.length };
          };
          const sortA = agentSortParts(rowA);
          const sortB = agentSortParts(rowB);
          if (sortA.empty && sortB.empty) {
            return rowA.name.localeCompare(rowB.name);
          }
          if (sortA.empty) return 1;
          if (sortB.empty) return -1;
          if (sortA.enabled !== sortB.enabled) {
            return sortA.enabled - sortB.enabled;
          }
          if (sortA.total !== sortB.total) return sortA.total - sortB.total;
          return rowA.name.localeCompare(rowB.name);
        },
        renderCell: (row) => {
          if (row.internal) {
            return (
              <Switch
                size="small"
                checked
                disabled
                ariaLabel={tSettings("agentTools.systemPinned")}
              />
            );
          }
          const rows = agentMatrix.rowsByTool(row.name);
          if (rows.length === 0) {
            return <span className="text-text-4">—</span>;
          }
          const enabledCount = rows.filter((entry) => entry.enabled).length;
          const totalCount = rows.length;
          const allEnabled = enabledCount === totalCount;
          const noneEnabled = enabledCount === 0;
          const dotColor = allEnabled
            ? "bg-success-6"
            : noneEnabled
              ? "bg-text-4"
              : "bg-warning-6";

          return (
            <div className="inline-flex items-center gap-2">
              <span
                className={`inline-block h-2 w-2 shrink-0 rounded-full ${dotColor}`}
                aria-hidden
              />
              <EnabledFractionText enabled={enabledCount} total={totalCount} />
            </div>
          );
        },
      },
    ],
    [t, tSettings, tools, agentMatrix]
  );

  const renderAgentSettings = (row: ToolRow) => {
    const toolName = expandedToolNames[0];

    if (row.internal) {
      return (
        <ToolInlineCompactRows
          rows={[
            {
              key: "system-pinned",
              label: (
                <span className="font-medium text-text-1">
                  {tSettings("agentTools.systemPinned")}
                </span>
              ),
              value: (
                <Switch
                  size="small"
                  checked
                  disabled
                  ariaLabel={tSettings("agentTools.systemPinned")}
                />
              ),
            },
          ]}
        />
      );
    }

    const agentRows = agentMatrix.rowsByTool(row.name);

    return (
      <div className="flex flex-col gap-3">
        {!agentMatrix.loaded ? (
          <ToolInlineCompactRows rows={[]} />
        ) : agentRows.length > 0 ? (
          <ToolInlineCompactRows
            rows={agentRows.map((agentRow) => ({
              key: agentRow.agentId,
              label: (
                <span className="font-medium text-text-1">
                  {agentRow.label}
                </span>
              ),
              value: (
                <Switch
                  size="small"
                  checked={agentRow.enabled}
                  disabled={agentRow.pinned || toolName == null}
                  ariaLabel={
                    agentRow.pinned
                      ? tSettings("agentTools.systemPinned")
                      : undefined
                  }
                  onChange={(next) => {
                    if (toolName == null) return;
                    void agentMatrix.toggle(agentRow.agentId, toolName, next);
                  }}
                />
              ),
            }))}
          />
        ) : (
          <span className="text-xs text-text-3">
            {t("builtInTools.noAgents")}
          </span>
        )}
      </div>
    );
  };

  const renderExpandedToolCard = (row: ToolRow) => {
    const actions = getToolActions(row);
    return (
      <ToolInlineInfoCard
        title={row.name}
        actionCountLabel={tSettings("agentTools.actionCount", {
          count: actions.length,
        })}
        description={getToolDetailDescription(row)}
        actions={actions}
        agentSection={{
          title: t("builtInTools.agentSettingsTab"),
          content: renderAgentSettings(row),
          defaultOpen: true,
        }}
        commandsTitle={t("builtInTools.actionDetailsTab")}
        sectionLayout="tabs"
      />
    );
  };

  const isFiltered =
    tools.searchQuery || tools.activeFilter !== ALL_CATEGORY_KEY;

  return (
    <ScrollPreservation className={DETAIL_PANEL_TOKENS.scrollContentNoTop}>
      <div className={DETAIL_PANEL_TOKENS.contentWidthWithPaddingNoTop}>
        <div className="flex flex-col gap-3">
          <SettingsTable<ToolRow>
            hover
            loading={tools.configLoading}
            searchBar={{
              searchValue: tools.searchQuery,
              onSearchChange: tools.setSearchQuery,
              searchPlaceholder: t("builtInTools.searchPlaceholder"),
              tabPills: (
                <TabPill
                  tabs={tools.filterTabs}
                  activeTab={tools.activeFilter}
                  onChange={tools.setActiveFilter}
                  variant="pill"
                  colorScheme="ghost"
                  fillWidth={false}
                  wrap
                  size="mini"
                  className="w-full"
                />
              ),
            }}
            columns={columns}
            rows={tools.filteredTools}
            getRowKey={(row) => row.name}
            headerHeight="tall"
            pageSize={50}
            maxHeight="min(420px, calc(100vh - 280px))"
            className="table-expanded-no-hover"
            expandable={{
              expandedRowRender: renderExpandedToolCard,
              rowExpandable: () => true,
              expandedRowKeys: expandedToolNames,
              onExpandedRowsChange: (keys) =>
                setExpandedToolNames(keys.slice(-1)),
            }}
            emptyTitle={
              isFiltered
                ? t("common:placeholders.noMatchingResults")
                : t("builtInTools.noTools")
            }
          />
        </div>
      </div>
    </ScrollPreservation>
  );
};
