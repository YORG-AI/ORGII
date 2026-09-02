/**
 * AgentsTable — Unified list of every available agent definition.
 *
 * Combines built-in agents (OS / SDE / Wingman …) and the user's custom
 * agents into a single `SettingsTable` rendered inside the Agent Teams
 * page. Rows are clickable / have an explicit "View" button that opens
 * the existing multi-tab detail view inside a WorkStation `agent-config`
 * tab (mirroring the skill-preview pattern).
 *
 * No second-level sidebar: this table replaces the agent navigation that
 * previously lived under "Agent Teams → Agents" in `SettingsSidebar`.
 */
import React, { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import AnyIcon from "@src/components/AnyIcon";
import Button from "@src/components/Button";
import SettingsTable, {
  SETTINGS_TABLE_CELL,
  SETTINGS_TABLE_COL,
  type SettingsTableColumn,
  type SettingsTableSelectFilter,
} from "@src/components/SettingsTable";
import { resolveAgentIcon } from "@src/config/agentIcons";
import { Add01Icon, Delete02Icon, HugeiconsIcon } from "@src/icons";
import type {
  AgentConfigTabData,
  AgentConfigTabVariant,
} from "@src/store/workstation/tabs";
import { confirmDestructiveAction } from "@src/util/dialogs/confirmDestructiveAction";
import { getRustAgentType } from "@src/util/session/sessionDispatch";
import { openAgentConfigInWorkStation } from "@src/util/ui/openAgentConfigInWorkStation";

import type { AgentDefinition } from "../types";

interface AgentsTableProps {
  builtInAgents: AgentDefinition[];
  customAgents: AgentDefinition[];
  loading: boolean;
  onAddAgent: () => void;
  onDeleteAgent: (agentId: string) => void | Promise<void>;
}

type AgentRow = AgentDefinition & {
  __category: "builtin" | "custom";
  __variant: AgentConfigTabVariant;
};

const CATEGORY_FILTER_ID = "category";
const AGENTS_TABLE_COL_WIDTH = {
  category: SETTINGS_TABLE_COL.valueMd,
  actions: "132px",
} as const;

function toTabData(agent: AgentRow): AgentConfigTabData {
  return {
    variant: agent.__variant,
    entityId: agent.id,
    displayName: agent.name,
  };
}

const AgentsTable: React.FC<AgentsTableProps> = ({
  builtInAgents,
  customAgents,
  loading,
  onAddAgent,
  onDeleteAgent,
}) => {
  const { t } = useTranslation("integrations");
  const [searchQuery, setSearchQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const rows = useMemo<AgentRow[]>(() => {
    const builtins: AgentRow[] = builtInAgents.map((agent) => {
      const variant = getRustAgentType(agent.id);
      const tabVariant: AgentConfigTabVariant =
        variant === "os"
          ? "builtin-os"
          : variant === "sde"
            ? "builtin-sde"
            : variant === "wingman"
              ? "wingman"
              : "custom";
      return { ...agent, __category: "builtin", __variant: tabVariant };
    });
    const customs: AgentRow[] = customAgents.map((agent) => ({
      ...agent,
      __category: "custom",
      __variant: "custom",
    }));
    return [...builtins, ...customs];
  }, [builtInAgents, customAgents]);

  const filteredRows = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return rows.filter((row) => {
      if (categoryFilter !== "all" && row.__category !== categoryFilter)
        return false;
      if (query.length === 0) return true;
      return (
        row.name.toLowerCase().includes(query) ||
        (row.description?.toLowerCase().includes(query) ?? false)
      );
    });
  }, [rows, searchQuery, categoryFilter]);

  const handleView = useCallback((row: AgentRow) => {
    openAgentConfigInWorkStation(toTabData(row));
  }, []);

  const handleDeleteRow = useCallback(
    async (row: AgentRow) => {
      const confirmed = await confirmDestructiveAction({
        title: t("agentOrgs.deleteAgentTitle", {
          defaultValue: "Delete agent?",
        }),
        message: t("agentOrgs.deleteAgentMessage", {
          name: row.name,
          defaultValue: `"${row.name}" will be permanently removed. This cannot be undone.`,
        }),
      });
      if (!confirmed) return;
      await onDeleteAgent(row.id);
    },
    [onDeleteAgent, t]
  );

  const columns = useMemo<SettingsTableColumn<AgentRow>[]>(
    () => [
      {
        key: "name",
        label: t("common:labels.name", { defaultValue: "Name" }),
        width: SETTINGS_TABLE_COL.fill,
        sorter: (rowA, rowB) => rowA.name.localeCompare(rowB.name),
        renderCell: (row) => {
          const icon = resolveAgentIcon(row.iconId);
          return (
            <span
              className={`${SETTINGS_TABLE_CELL.primary} inline-flex items-center gap-2 font-bold`}
            >
              <AnyIcon icon={icon} size={14} strokeWidth={2} />
              {row.name}
            </span>
          );
        },
      },
      {
        key: "category",
        label: t("agentOrgs.agentDetail.type", { defaultValue: "Type" }),
        width: AGENTS_TABLE_COL_WIDTH.category,
        sorter: (rowA, rowB) => rowA.__category.localeCompare(rowB.__category),
        renderCell: (row) => (
          <span className={SETTINGS_TABLE_CELL.value}>
            {row.__category === "builtin"
              ? t("agentOrgs.agentDetail.builtIn", { defaultValue: "Built-in" })
              : t("agentOrgs.agentDetail.custom", { defaultValue: "Custom" })}
          </span>
        ),
      },
      {
        key: "description",
        label: t("common:labels.description", { defaultValue: "Description" }),
        width: SETTINGS_TABLE_COL.fill,
        renderCell: (row) => (
          <span
            className={`${SETTINGS_TABLE_CELL.muted} block w-0 max-w-full min-w-full truncate`}
            title={row.description ?? undefined}
          >
            {row.description ?? ""}
          </span>
        ),
      },
      {
        key: "actions",
        label: (
          <span className="sr-only">
            {t("common:labels.actions", { defaultValue: "Actions" })}
          </span>
        ),
        width: AGENTS_TABLE_COL_WIDTH.actions,
        align: "right",
        renderCell: (row) => (
          <div
            className="flex items-center justify-end gap-2 whitespace-nowrap"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <Button
              variant="secondary"
              size="small"
              onClick={() => handleView(row)}
            >
              {t("common:actions.view", { defaultValue: "View" })}
            </Button>
            {row.__category === "custom" ? (
              <Button
                variant="danger"
                appearance="outline"
                size="small"
                icon={
                  <HugeiconsIcon
                    icon={Delete02Icon}
                    data-icon="trash-2"
                    size={14}
                  />
                }
                iconOnly
                onClick={() => void handleDeleteRow(row)}
                aria-label={t("common:actions.delete", {
                  defaultValue: "Delete",
                })}
                title={t("common:actions.delete", { defaultValue: "Delete" })}
              />
            ) : null}
          </div>
        ),
      },
    ],
    [handleDeleteRow, handleView, t]
  );

  const selectFilters = useMemo<SettingsTableSelectFilter[]>(
    () => [
      {
        key: CATEGORY_FILTER_ID,
        value: categoryFilter,
        defaultValue: "all",
        onChange: (value) => setCategoryFilter(String(value)),
        options: [
          {
            value: "all",
            label: t("common:labels.all", { defaultValue: "All" }),
          },
          {
            value: "builtin",
            label: t("agentOrgs.agentDetail.builtIn", {
              defaultValue: "Built-in",
            }),
          },
          {
            value: "custom",
            label: t("agentOrgs.agentDetail.custom", {
              defaultValue: "Custom",
            }),
          },
        ],
      },
    ],
    [categoryFilter, t]
  );

  const addAgentLabel = t("agentOrgs.addAgent", { defaultValue: "Add Agent" });
  const addButton = (
    <Button
      variant="secondary"
      size="default"
      icon={<HugeiconsIcon icon={Add01Icon} data-icon="plus" size={14} />}
      iconOnly
      aria-label={addAgentLabel}
      title={addAgentLabel}
      data-testid="agent-orgs-add-agent-button"
      onClick={onAddAgent}
    />
  );

  return (
    <SettingsTable<AgentRow>
      hover
      loading={loading}
      selectFilters={selectFilters}
      columns={columns}
      rows={filteredRows}
      getRowKey={(row) => row.id}
      rowDataTestId={(row) => `agent-orgs-agent-row-${row.id}`}
      onRowClick={handleView}
      headerHeight="tall"
      className="table-layout-fixed"
      searchBar={{
        searchValue: searchQuery,
        onSearchChange: setSearchQuery,
        searchPlaceholder: t("agentOrgs.searchAgents", {
          defaultValue: "Search agents…",
        }),
        allowSearchClear: true,
        rightContent: addButton,
      }}
      emptyTitle={t("agentOrgs.noAgents", { defaultValue: "No agents yet" })}
      emptyAction={{
        label: addAgentLabel,
        onClick: onAddAgent,
      }}
    />
  );
};

export default AgentsTable;
