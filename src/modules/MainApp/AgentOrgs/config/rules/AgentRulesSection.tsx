/**
 * Agent Rules Section
 *
 * Toggle list for enabling/disabling rules in the SDE agent.
 * "+ Add Rule" deep-links to the Rules / Memory / Evolution page (Rules
 * tab), which is the canonical home for rule lifecycle management
 * (create / edit / import / delete). Per-agent context only edits the
 * enabled flag.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import SettingsTable, {
  SETTINGS_TABLE_CELL,
  SETTINGS_TABLE_COL,
  type SettingsTableColumn,
} from "@src/components/SettingsTable";
import Switch from "@src/components/Switch";
import { useAppNavigation } from "@src/hooks/navigation/useAppNavigation";

import WorkspaceSettingsToggle from "../shared/WorkspaceSettingsToggle";
import {
  type PolicyInfo,
  type PolicySource,
  useAgentPolicies,
} from "./useAgentRules";

interface AgentRulesSectionProps {
  workspacePath?: string;
  onCountChange?: (count: number) => void;
  config?: Record<string, unknown>;
  update?: (path: string, value: unknown) => void;
}

const AgentRulesSection: React.FC<AgentRulesSectionProps> = ({
  workspacePath,
  onCountChange,
  config,
  update,
}) => {
  const { t } = useTranslation(["settings", "integrations"]);
  const { goToIntegrations } = useAppNavigation();
  const { policies, loading, toggleRule } = useAgentPolicies(workspacePath);
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    onCountChange?.(policies.length);
  }, [policies.length, onCountChange]);

  const sourceLabel = useCallback(
    (source: PolicySource) => {
      if (source === "global") return t("skills.sourceGlobal");
      if (source === "personal") return t("skills.sourcePersonal");
      return t("skills.sourceWorkspace");
    },
    [t]
  );

  const handleAddRule = useCallback(() => {
    goToIntegrations({ category: "rulesMemoryEvolution" });
  }, [goToIntegrations]);

  const filteredPolicies = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return policies;
    return policies.filter((policy) => {
      const source = sourceLabel(policy.source).toLowerCase();
      return (
        policy.name.toLowerCase().includes(query) ||
        source.includes(query) ||
        policy.source.toLowerCase().includes(query)
      );
    });
  }, [policies, searchQuery, sourceLabel]);

  const columns = useMemo<SettingsTableColumn<PolicyInfo>[]>(
    () => [
      {
        key: "name",
        label: t("sdeAgent.rules.ruleColumn"),
        width: SETTINGS_TABLE_COL.fill,
        sorter: (rowA, rowB) => rowA.name.localeCompare(rowB.name),
        renderCell: (row) => (
          <span className={SETTINGS_TABLE_CELL.primary}>{row.name}</span>
        ),
      },
      {
        key: "source",
        label: t("common:common.source"),
        width: SETTINGS_TABLE_COL.valueSm,
        renderCell: (row) => (
          <span className={`${SETTINGS_TABLE_CELL.muted} whitespace-nowrap`}>
            {sourceLabel(row.source)}
          </span>
        ),
      },
      {
        key: "tokens",
        label: t("sdeAgent.rules.tokensColumn"),
        width: "100px",
        align: "right",
        renderCell: (row) => (
          <span className={`${SETTINGS_TABLE_CELL.value} whitespace-nowrap`}>
            ~{row.estimatedTokens.toLocaleString()}
          </span>
        ),
      },
      {
        key: "enabled",
        label: t("agentTools.enabled"),
        width: SETTINGS_TABLE_COL.hug,
        renderCell: (row) => (
          <div className="flex justify-center">
            <Switch
              checked={row.enabled}
              dataTestId={`agent-orgs-rule-switch-${row.source}-${row.name}`}
              onChange={(enabled: boolean) =>
                toggleRule(row.name, enabled, row.source)
              }
            />
          </div>
        ),
      },
    ],
    [t, toggleRule, sourceLabel]
  );

  const isFiltered = searchQuery.trim().length > 0;

  const table = (
    <SettingsTable<PolicyInfo>
      loading={loading}
      columns={columns}
      rows={filteredPolicies}
      getRowKey={(row) => `${row.source}:${row.name}`}
      headerHeight="tall"
      pageSize={50}
      maxHeight="min(420px, calc(100vh - 280px))"
      searchBar={{
        searchValue: searchQuery,
        onSearchChange: setSearchQuery,
        searchPlaceholder: t("integrations:rules.searchPlaceholder"),
        allowSearchClear: true,
      }}
      emptyTitle={
        isFiltered
          ? t("common:placeholders.noMatchingResults")
          : t("sdeAgent.rules.noRules")
      }
      emptySubtitle={isFiltered ? undefined : t("sdeAgent.rules.noRulesDesc")}
      addFooter={{
        label: t("sdeAgent.rules.addRule"),
        onClick: handleAddRule,
        dataTestId: "agent-orgs-add-rule-button",
      }}
    />
  );

  if (!config || !update) {
    return table;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <WorkspaceSettingsToggle
        config={config}
        update={update}
        configKey="loadWorkspaceRules"
        labelKey="workspaceResources.loadWorkspaceRules"
        descriptionKey="workspaceResources.loadWorkspaceRulesDesc"
        dataTestId="agent-orgs-load-workspace-rules-switch"
      />
      {table}
    </div>
  );
};

export default AgentRulesSection;
