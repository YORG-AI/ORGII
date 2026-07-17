/**
 * Host for the Rules / Memory / Evolution page (internal category key
 * `rulesMemoryEvolution`; URL slug `rules-memory-and-evolution`).
 *
 * Renders three page-level tabs:
 *  - `rules`     — markdown policy list (this component's main content)
 *  - `memory`    — embedded {@link WorkspaceMemoryBrowser}
 *  - `evolution` — empty placeholder, agent-evolution surface lands here
 */
import { Pencil, Plus, Trash2 } from "lucide-react";
import React, { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import { MODEL_TABLE_SWITCH_SIZE } from "@src/components/ModelTable/types";
import SettingsTable, {
  SETTINGS_TABLE_CELL,
  SETTINGS_TABLE_COL,
  type SettingsTableColumn,
} from "@src/components/SettingsTable";
import Switch from "@src/components/Switch";
import TabPill, { type TabPillItem } from "@src/components/TabPill";
import type { CursorRepo, PolicyInfo } from "@src/hooks/policies";
import {
  DETAIL_PANEL_TOKENS,
  DetailPanelContainer,
  InlineInfoCard,
  InternalHeader,
  ScrollPreservation,
} from "@src/modules/shared/layouts/blocks";
import { InfoRow } from "@src/modules/shared/layouts/blocks/InfoRow";
import { openFileInWorkStation } from "@src/util/ui/openFileInWorkStation";

import {
  InlineCardColumnStack,
  InlineCardSplit,
} from "../../KeyVault/shared/InlineCardPrimitives";
import type { DetailMode } from "../../types";
import AgentEvolutionPanel from "../Evolution/AgentEvolutionPanel";
import WorkspaceMemoryBrowser from "../Memory/WorkspaceMemoryBrowser";
import InlineExternalRulesImport from "./InlineExternalRulesImport";

type RulesMemoryEvolutionPageTab = "rules" | "memory" | "evolution";
type RuleScopeFilterKey = "all" | "user" | `workspace:${string}`;

interface RulesMemoryEvolutionTableProps {
  markdownRules: PolicyInfo[];
  loading: boolean;
  selectedRowId?: string | null;
  onSelectMarkdownRule: (name: string | null, mode?: DetailMode) => void;
  onDeleteMarkdownRule?: (rule: PolicyInfo) => void;
  onToggleMarkdownRule?: (rule: PolicyInfo, enabled: boolean) => void;
  onAdd: () => void;
  cursorRepos?: CursorRepo[];
  onAfterImport?: () => void | Promise<void>;
}

function getRuleKey(rule: PolicyInfo): string {
  return `${rule.source}:${rule.name}`;
}

export const RulesMemoryEvolutionTable: React.FC<
  RulesMemoryEvolutionTableProps
> = ({
  markdownRules,
  loading,
  selectedRowId,
  onSelectMarkdownRule,
  onDeleteMarkdownRule,
  onToggleMarkdownRule,
  onAdd,
  cursorRepos,
  onAfterImport,
}) => {
  const { t } = useTranslation("integrations");
  const { t: tSettings } = useTranslation("settings");
  const openRuleInEditor = useCallback((rule: PolicyInfo) => {
    if (!rule.path) return;
    openFileInWorkStation(rule.path, { defaultPreviewMode: true });
  }, []);
  const [activeTab, setActiveTab] =
    useState<RulesMemoryEvolutionPageTab>("rules");
  const [searchQuery, setSearchQuery] = useState("");
  const [scopeFilter, setScopeFilter] = useState<RuleScopeFilterKey>("all");
  const [expandedRuleKeys, setExpandedRuleKeys] = useState<string[]>([]);

  const resolveRuleWorkspacePath = useCallback(
    (rule: PolicyInfo): string | null => {
      if (rule.source !== "workspace") return null;
      return rule.repoPath ?? rule.scopeRepoPaths?.[0] ?? null;
    },
    []
  );

  const scopeTabs = useMemo<TabPillItem[]>(() => {
    const workspaceTabs = (cursorRepos ?? []).map((repo) => ({
      key: `workspace:${repo.path}`,
      label: repo.name.length > 20 ? `${repo.name.slice(0, 20)}…` : repo.name,
    }));

    return [
      { key: "all", label: t("common:actions.all") },
      { key: "user", label: t("scopeLabels.user") },
      ...workspaceTabs,
    ];
  }, [cursorRepos, t]);

  const filteredRules = useMemo(() => {
    const query = searchQuery.toLowerCase();
    return markdownRules.filter((rule) => {
      const workspacePath = resolveRuleWorkspacePath(rule);
      const matchesScope =
        scopeFilter === "all" ||
        (scopeFilter === "user" && !workspacePath) ||
        (workspacePath != null && scopeFilter === `workspace:${workspacePath}`);
      if (!matchesScope) return false;
      if (!query) return true;
      return rule.name.toLowerCase().includes(query);
    });
  }, [markdownRules, resolveRuleWorkspacePath, scopeFilter, searchQuery]);

  const getSourceLabel = useCallback(
    (rule: PolicyInfo): string => {
      if (rule.source === "workspace") return t("agentOrgs.ruleSourceRepo");
      if (rule.source === "personal") return t("agentOrgs.ruleSourcePersonal");
      return t("agentOrgs.ruleSourceUser");
    },
    [t]
  );

  const getAgentsLabel = useCallback(
    (rule: PolicyInfo): string => {
      if (rule.agents.length === 0) return t("common:actions.all");
      return rule.agents.join(", ");
    },
    [t]
  );

  const getScopeLabel = useCallback(
    (rule: PolicyInfo): string => {
      if (!rule.scopeRepoPaths || rule.scopeRepoPaths.length === 0) {
        if (rule.source === "workspace") {
          return rule.repoName ?? rule.repoPath ?? t("agentOrgs.allRepos");
        }
        return t("mcp.userScopeLabel");
      }
      return rule.scopeRepoPaths
        .map((path) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path)
        .join(", ");
    },
    [t]
  );

  const setSingleExpandedRule = (rule: PolicyInfo) => {
    const ruleKey = getRuleKey(rule);
    const shouldOpen = !expandedRuleKeys.includes(ruleKey);
    setExpandedRuleKeys(shouldOpen ? [ruleKey] : []);
  };

  const renderExpandedRuleCard = (rule: PolicyInfo) => (
    <InlineInfoCard>
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex min-w-0 items-center gap-1.5 text-xs">
          <span className="truncate font-medium text-text-1">{rule.name}</span>
          <span className="shrink-0 text-text-4">·</span>
          <span className="shrink-0 text-text-2">
            {`${rule.estimatedTokens} ${tSettings("sharedAgentConfig.tokensSuffix")}`}
          </span>
        </div>
        <InlineCardSplit
          equalColumns
          left={
            <InlineCardColumnStack>
              <InfoRow
                label={t("common:labels.source")}
                value={getSourceLabel(rule)}
              />
              <InfoRow
                label={t("common:labels.status")}
                value={
                  rule.enabled ? t("status.enabled") : t("status.disabled")
                }
              />
            </InlineCardColumnStack>
          }
          right={
            <InlineCardColumnStack>
              <InfoRow
                label={t("agentOrgs.applicableAgents")}
                value={getAgentsLabel(rule)}
              />
              <InfoRow
                label={t("agentOrgs.scope")}
                value={getScopeLabel(rule)}
              />
            </InlineCardColumnStack>
          }
        />
      </div>
    </InlineInfoCard>
  );

  const rulesColumns = useMemo<SettingsTableColumn<PolicyInfo>[]>(
    () => [
      {
        key: "name",
        label: t("common:labels.name"),
        width: SETTINGS_TABLE_COL.fill,
        sorter: (rowA, rowB) => rowA.name.localeCompare(rowB.name),
        renderCell: (rule) => (
          <span className={`${SETTINGS_TABLE_CELL.primary} font-bold`}>
            {rule.name}
          </span>
        ),
      },
      {
        key: "agents",
        label: t("agentOrgs.applicableAgents"),
        width: SETTINGS_TABLE_COL.valueLg,
        sorter: (rowA, rowB) =>
          getAgentsLabel(rowA).localeCompare(getAgentsLabel(rowB)),
        renderCell: (rule) => (
          <span className={`${SETTINGS_TABLE_CELL.muted} block truncate`}>
            {getAgentsLabel(rule)}
          </span>
        ),
      },
      {
        key: "workspace",
        label: t("agentOrgs.applicableWorkspace"),
        width: SETTINGS_TABLE_COL.valueLg,
        sorter: (rowA, rowB) =>
          getScopeLabel(rowA).localeCompare(getScopeLabel(rowB)),
        renderCell: (rule) => (
          <span className={`${SETTINGS_TABLE_CELL.muted} block truncate`}>
            {getScopeLabel(rule)}
          </span>
        ),
      },
      {
        key: "actions",
        label: t("common:common.actions"),
        width: "120px",
        align: "right",
        renderCell: (rule) => (
          <div className="flex items-center justify-end gap-2 whitespace-nowrap">
            <Switch
              size={MODEL_TABLE_SWITCH_SIZE}
              checked={rule.enabled}
              onChange={(enabled) => onToggleMarkdownRule?.(rule, enabled)}
            />
            <Button
              variant="secondary"
              size="small"
              icon={<Pencil size={14} />}
              iconOnly
              onClick={() => openRuleInEditor(rule)}
              aria-label={t("common:actions.edit")}
              title={t("common:actions.edit")}
            />
            {onDeleteMarkdownRule ? (
              <Button
                variant="danger"
                appearance="outline"
                size="small"
                icon={<Trash2 size={14} />}
                iconOnly
                onClick={() => onDeleteMarkdownRule(rule)}
                aria-label={t("common:actions.remove")}
                title={t("common:actions.remove")}
              />
            ) : null}
          </div>
        ),
      },
    ],
    [
      getAgentsLabel,
      getScopeLabel,
      onDeleteMarkdownRule,
      openRuleInEditor,
      onToggleMarkdownRule,
      t,
    ]
  );

  const tabs = useMemo<TabPillItem[]>(
    () => [
      { key: "rules", label: t("rulesTabs.rules", "Rules") },
      { key: "memory", label: t("rulesTabs.memory", "Memory") },
      { key: "evolution", label: t("rulesTabs.evolution", "Evolution") },
    ],
    [t]
  );

  const addRuleButton = (
    <Button
      variant="secondary"
      size="default"
      icon={<Plus size={14} />}
      onClick={onAdd}
    >
      {t("addOptions.addRule")}
    </Button>
  );

  return (
    <DetailPanelContainer>
      <InternalHeader
        noPanelHeader
        contentPadding
        className={DETAIL_PANEL_TOKENS.headerWidth}
        tabs={
          <TabPill
            tabs={tabs}
            activeTab={activeTab}
            onChange={(key) => setActiveTab(key as RulesMemoryEvolutionPageTab)}
            variant="simple"
            fillWidth={false}
            size="large"
          />
        }
      />
      {activeTab === "memory" ? (
        <ScrollPreservation className={DETAIL_PANEL_TOKENS.scrollContentNoTop}>
          <div className={DETAIL_PANEL_TOKENS.contentWidthWithPaddingNoTop}>
            <WorkspaceMemoryBrowser />
          </div>
        </ScrollPreservation>
      ) : activeTab === "evolution" ? (
        <ScrollPreservation className={DETAIL_PANEL_TOKENS.scrollContentNoTop}>
          <div className={DETAIL_PANEL_TOKENS.contentWidthWithPaddingNoTop}>
            <AgentEvolutionPanel />
          </div>
        </ScrollPreservation>
      ) : (
        <ScrollPreservation className={DETAIL_PANEL_TOKENS.scrollContentNoTop}>
          <div className={DETAIL_PANEL_TOKENS.contentWidthWithPaddingNoTop}>
            <div className="flex flex-col gap-3">
              <>
                <SettingsTable<PolicyInfo>
                  hover
                  loading={loading}
                  columns={rulesColumns}
                  rows={filteredRules}
                  getRowKey={getRuleKey}
                  onRowClick={(rule) => {
                    const ruleKey = getRuleKey(rule);
                    onSelectMarkdownRule(
                      selectedRowId === ruleKey ? null : rule.name
                    );
                    setSingleExpandedRule(rule);
                  }}
                  headerHeight="tall"
                  className="table-expanded-no-hover table-policy-fixed-layout"
                  searchBar={{
                    searchValue: searchQuery,
                    onSearchChange: setSearchQuery,
                    searchPlaceholder: t("rules.searchPlaceholder"),
                    allowSearchClear: true,
                    rightContent: addRuleButton,
                    tabPills: (
                      <TabPill
                        tabs={scopeTabs}
                        activeTab={scopeFilter}
                        onChange={(key) =>
                          setScopeFilter(key as RuleScopeFilterKey)
                        }
                        variant="pill"
                        colorScheme="ghost"
                        fillWidth={false}
                        size="mini"
                      />
                    ),
                  }}
                  expandable={{
                    expandedRowRender: renderExpandedRuleCard,
                    rowExpandable: () => true,
                    expandedRowKeys: expandedRuleKeys,
                    onExpandedRowsChange: (keys) => {
                      setExpandedRuleKeys(keys.slice(-1));
                    },
                  }}
                  emptyTitle={t("rules.noRules")}
                  emptyAction={{
                    label: t("addOptions.addRule"),
                    onClick: onAdd,
                  }}
                />
                <InlineExternalRulesImport
                  cursorRepos={cursorRepos}
                  onAfterImport={onAfterImport}
                />
              </>
            </div>
          </div>
        </ScrollPreservation>
      )}
    </DetailPanelContainer>
  );
};
