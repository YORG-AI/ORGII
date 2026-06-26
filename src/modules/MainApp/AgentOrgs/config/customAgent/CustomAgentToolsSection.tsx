/**
 * CustomAgentToolsSection
 *
 * Per-agent tool configuration panel — used by every agent detail view
 * (OS, SDE, Wingman, and custom agents).
 *
 * Runtime source of truth: the agent capability boundary plus explicit
 * allow/deny lists on the agent definition (`tools.systemRestrictToTools`,
 * `tools.userAllowedTools`, `tools.excludedTools`). Capabilities are not
 * edited here; this panel only edits per-tool deltas inside that boundary.
 *
 * Layout: one tool table, tri-state per row:
 *   - "System pinned" — locked on by `tools.systemRestrictToTools`;
 *     not user-editable, but a user `excludedTools` entry still wins.
 *   - Switch ON  — system pin or user added via `userAllowedTools`.
 *   - Switch OFF — user excluded, or system pinned to a different set
 *     and the user has not added this tool.
 *
 * Clicking a row expands inline details with description and commands.
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
  TOOL_CATEGORY_ORDER,
  toolCategoryLabel,
} from "@src/modules/MainApp/Integrations/BuiltInTools/config";
import {
  type RawToolInfo,
  type ToolActionEntry,
} from "@src/modules/MainApp/Integrations/BuiltInTools/types";
import { useUnifiedToolsMetadata } from "@src/modules/MainApp/Integrations/BuiltInTools/useUnifiedToolsMetadata";
import {
  DETAIL_PANEL_TOKENS,
  ScrollPreservation,
  ToolInlineInfoCard,
} from "@src/modules/shared/layouts/blocks";

import { agentToolDisplayName } from "../agentToolName";
import { type ToolEditorState, useAgentToolEditor } from "./useAgentToolEditor";

const ALL_KEY = "__all__";

interface ActionRow {
  name: string;
  summary: string;
}

interface ToolDisplayRow {
  name: string;
  description: string;
  detailDescription: string;
  category: string;
  actions: ActionRow[];
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

function getToolActions(tool: RawToolInfo): ActionRow[] {
  const inlineActions: ToolActionEntry[] = tool.actions ?? [];
  if (inlineActions.length > 0) {
    return inlineActions.map((entry) => ({
      name: entry.name,
      summary: entry.summary,
    }));
  }
  const detailSource = tool.description_detail ?? tool.description;
  const parsedActions = parseActionsFromMarkdown(detailSource);
  if (parsedActions) return parsedActions;
  return [
    {
      name: tool.name,
      summary: cleanDescriptionText(detailSource) || tool.description,
    },
  ];
}

interface CustomAgentToolsSectionProps {
  agentId: string;
  headerElement?: React.ReactNode;
}

const CustomAgentToolsSection: React.FC<CustomAgentToolsSectionProps> = ({
  agentId,
  headerElement,
}) => {
  const { t } = useTranslation("settings");
  const { t: tIntegrations } = useTranslation("integrations");

  const { rawTools, loading: toolsLoading } = useUnifiedToolsMetadata();
  const editor = useAgentToolEditor(agentId);

  const [activeFilter, setActiveFilter] = useState(ALL_KEY);
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedToolNames, setExpandedToolNames] = useState<string[]>([]);

  const allTools = useMemo<ToolDisplayRow[]>(() => {
    // Strict allowlist agents (Wingman, explore, memory workers, etc.)
    // declare `system_restrict_to_tools` —
    // their tool set is the explicit allowlist, not the full table.
    // Showing the full ~50-tool list with everything switched off is
    // pure visual noise: every row except the 1–15 system-pinned ones
    // is unreachable for that agent and is misreported as "you can
    // toggle this on" when in fact `init.rs` will keep them off.
    //
    // When `systemRestrictToTools` is null (OS / SDE / Custom), show
    // only tools supported by the current agent kind and capability.
    // Capability satisfaction comes from the BACKEND-resolved tool
    // states (`agent_def_tool_states`) — no TS re-implementation.
    const systemSet = editor.systemRestrictToTools
      ? new Set(editor.systemRestrictToTools)
      : null;
    const isSpecialistAgent = systemSet !== null;
    return rawTools
      .filter((raw) => {
        if (raw.hidden) return false;
        const supportedByAgentKind =
          !Array.isArray(raw.supported_agents) ||
          raw.supported_agents.includes(editor.agentKind);
        const resolved = editor.resolvedToolState(raw.name);
        const supportedByCapability = resolved
          ? !resolved.capabilityBlocked
          : true;
        if (isSpecialistAgent) {
          if (systemSet!.has(raw.name)) return true;
          if (!supportedByAgentKind || !supportedByCapability) return false;
          if (editor.userAllowedTools.has(raw.name)) return true;
          if (editor.excludedTools.has(raw.name)) return true;
          return false;
        }
        return supportedByAgentKind && supportedByCapability;
      })
      .map((raw) => {
        const detailSource = raw.description_detail ?? raw.description;
        return {
          name: raw.name,
          description: raw.description,
          detailDescription: cleanDescriptionText(detailSource),
          category: raw.category || "general",
          actions: getToolActions(raw),
        };
      })
      .sort((rowA, rowB) => {
        const idxA = TOOL_CATEGORY_ORDER.indexOf(
          rowA.category as (typeof TOOL_CATEGORY_ORDER)[number]
        );
        const idxB = TOOL_CATEGORY_ORDER.indexOf(
          rowB.category as (typeof TOOL_CATEGORY_ORDER)[number]
        );
        const catDiff = (idxA === -1 ? 999 : idxA) - (idxB === -1 ? 999 : idxB);
        if (catDiff !== 0) return catDiff;
        return rowA.name.localeCompare(rowB.name);
      });
  }, [rawTools, editor]);

  const categoryCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const tool of allTools) {
      counts.set(tool.category, (counts.get(tool.category) ?? 0) + 1);
    }
    return counts;
  }, [allTools]);

  const filterTabs = useMemo(() => {
    const knownCats = TOOL_CATEGORY_ORDER.filter((cat) =>
      categoryCounts.has(cat)
    );
    const extraCats = [...categoryCounts.keys()]
      .filter(
        (cat) =>
          !TOOL_CATEGORY_ORDER.includes(
            cat as (typeof TOOL_CATEGORY_ORDER)[number]
          )
      )
      .sort();
    return [
      { key: ALL_KEY, label: `All (${allTools.length})` },
      ...[...knownCats, ...extraCats].map((cat) => ({
        key: cat,
        label: `${toolCategoryLabel(cat)} (${categoryCounts.get(cat)})`,
      })),
    ];
  }, [allTools.length, categoryCounts]);

  const filteredTools = useMemo(() => {
    const lowerQuery = searchQuery.toLowerCase();
    return allTools.filter((tool) => {
      if (activeFilter !== ALL_KEY && tool.category !== activeFilter)
        return false;
      if (
        lowerQuery &&
        !tool.name.toLowerCase().includes(lowerQuery) &&
        !tool.description.toLowerCase().includes(lowerQuery)
      )
        return false;
      return true;
    });
  }, [allTools, activeFilter, searchQuery]);

  const renderToolSwitch = (row: ToolDisplayRow) => {
    const state: ToolEditorState = editor.toolState(row.name);

    if (state === "system_pinned") {
      return (
        <div className="flex justify-center">
          <Switch checked disabled ariaLabel={t("agentTools.systemPinned")} />
        </div>
      );
    }

    const checked = state === "enabled";
    const onChange = (next: boolean) => {
      if (editor.systemRestrictToTools !== null) {
        editor.setUserAllowed(row.name, next);
        if (!next) editor.setExcluded(row.name, false);
      } else {
        editor.setExcluded(row.name, !next);
      }
    };

    return (
      <div className="flex justify-center">
        <Switch
          checked={checked}
          onChange={onChange}
          dataTestId={`agent-orgs-tool-switch-${row.name}`}
        />
      </div>
    );
  };

  const columns = useMemo<SettingsTableColumn<ToolDisplayRow>[]>(
    () => [
      {
        key: "category",
        label: t("agentTools.typeColumn"),
        width: "150px",
        sorter: (rowA, rowB) =>
          toolCategoryLabel(rowA.category).localeCompare(
            toolCategoryLabel(rowB.category)
          ),
        renderCell: (row) => (
          <span className={`${SETTINGS_TABLE_CELL.value} whitespace-nowrap`}>
            {toolCategoryLabel(row.category)}
          </span>
        ),
      },
      {
        key: "name",
        label: t("agentTools.toolColumn"),
        width: SETTINGS_TABLE_COL.fill,
        sorter: (rowA, rowB) =>
          agentToolDisplayName(rowA.name).localeCompare(
            agentToolDisplayName(rowB.name)
          ),
        renderCell: (row) => (
          <span className={SETTINGS_TABLE_CELL.primary}>
            {agentToolDisplayName(row.name)}
          </span>
        ),
      },
      {
        key: "enabled",
        label: t("agentTools.enabled"),
        width: SETTINGS_TABLE_COL.hug,
        renderCell: renderToolSwitch,
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, tIntegrations, editor]
  );

  const configLoading = toolsLoading || !editor.loaded;

  const renderExpandedToolCard = (row: ToolDisplayRow) => (
    <ToolInlineInfoCard
      title={agentToolDisplayName(row.name)}
      actionCountLabel={t("agentTools.actionCount", {
        count: row.actions.length,
      })}
      description={row.detailDescription}
      actions={row.actions}
      commandsTitle={tIntegrations("builtInTools.actionDetailsTab")}
      sectionLayout="tabs"
    />
  );

  const tableContent = (
    <>
      {headerElement}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <ScrollPreservation className={DETAIL_PANEL_TOKENS.scrollContentNoTop}>
          <div className={DETAIL_PANEL_TOKENS.contentWidthWithPaddingNoTop}>
            <SettingsTable<ToolDisplayRow>
              hover
              loading={configLoading}
              searchBar={{
                searchValue: searchQuery,
                onSearchChange: setSearchQuery,
                searchPlaceholder: t("agentTools.searchPlaceholder"),
                allowSearchClear: true,
                tabPills: (
                  <TabPill
                    tabs={filterTabs}
                    activeTab={activeFilter}
                    onChange={setActiveFilter}
                    variant="pill"
                    colorScheme="muted"
                    fillWidth={false}
                    wrap
                    size="small"
                    className="w-full"
                  />
                ),
              }}
              columns={columns}
              rows={filteredTools}
              getRowKey={(row) => row.name}
              rowDataTestId={(row) => `agent-orgs-tool-row-${row.name}`}
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
                searchQuery || activeFilter !== ALL_KEY
                  ? t("common:placeholders.noMatchingResults")
                  : undefined
              }
            />
          </div>
        </ScrollPreservation>
      </div>
    </>
  );

  return tableContent;
};

export default CustomAgentToolsSection;
