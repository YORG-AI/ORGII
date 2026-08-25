import { useAtomValue, useSetAtom } from "jotai";
import { Plus, RefreshCw } from "lucide-react";
import React, { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { ModelType } from "@src/api/types/keys";
import Button from "@src/components/Button";
import ModelIcon from "@src/components/ModelIcon";
import { MODEL_TABLE_SWITCH_SIZE } from "@src/components/ModelTable/types";
import type { SelectOption } from "@src/components/Select";
import SettingsTable, {
  SETTINGS_TABLE_CELL,
  SETTINGS_TABLE_COL,
  type SettingsTableColumn,
  type SettingsTableSelectFilter,
} from "@src/components/SettingsTable";
import StatusDot from "@src/components/StatusDot";
import Switch from "@src/components/Switch";
import Tag from "@src/components/Tag";
import type { AvailableAgent } from "@src/config/cliAgents";
import type { KeyVaultAccount } from "@src/hooks/keyVault";
import { useRefreshSpin } from "@src/hooks/ui";
import { Placeholder } from "@src/modules/shared/layouts/blocks";
import {
  cliAgentVisibilityOverridesAtom,
  isCliAgentEnabled,
  setCliAgentEnabledAtom,
} from "@src/store/session";
import { openAgentConfigInWorkStation } from "@src/util/ui/openAgentConfigInWorkStation";

import CliClientInlineExpandedCard, {
  CLI_CLIENT_INLINE_TAB,
  type CliClientInlineTab,
} from "./CliClientInlineExpandedCard";

const INSTALL_FILTER = {
  ALL: "all",
  INSTALLED: "installed",
  NOT_INSTALLED: "not_installed",
} as const;

type InstallFilter = (typeof INSTALL_FILTER)[keyof typeof INSTALL_FILTER];

const READY_FILTER = {
  ALL: "all",
  READY: "ready",
  NO_SUBSCRIPTIONS: "no_subscriptions",
} as const;

type ReadyFilter = (typeof READY_FILTER)[keyof typeof READY_FILTER];

interface CliClientsTableProps {
  agents: AvailableAgent[];
  accounts?: KeyVaultAccount[];
  loading: boolean;
  error: string | null;
  fetchAgents?: () => Promise<void>;
  onAdd?: () => void;
  cliAgents?: {
    actionMap: Record<string, "installing" | "detecting" | null>;
    handleInstall: (agentName: string, installCmd?: string) => Promise<void>;
    handleUninstall: (
      agentName: string,
      uninstallCmd?: string
    ) => Promise<void>;
  };
}

const CliClientsTable: React.FC<CliClientsTableProps> = ({
  agents,
  accounts = [],
  loading,
  error,
  fetchAgents,
  onAdd,
  cliAgents,
}) => {
  const { t } = useTranslation("settings");
  const { t: tIntegrations } = useTranslation("integrations");
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedAgentKeys, setExpandedAgentKeys] = useState<string[]>([]);
  const [activeInlineTab, setActiveInlineTab] = useState<CliClientInlineTab>(
    CLI_CLIENT_INLINE_TAB.STATUS
  );
  const [installFilter, setInstallFilter] = useState<InstallFilter>(
    INSTALL_FILTER.ALL
  );
  const [readyFilter, setReadyFilter] = useState<ReadyFilter>(READY_FILTER.ALL);
  const cliVisibilityOverrides = useAtomValue(cliAgentVisibilityOverridesAtom);
  const setCliAgentEnabled = useSetAtom(setCliAgentEnabledAtom);
  const { spinClass, handleClick: handleRefreshClick } = useRefreshSpin(
    fetchAgents ?? (() => undefined),
    loading
  );

  const subscriptionsByAgent = useMemo(() => {
    const subscriptionMap = new Map<string, number>();
    for (const agent of agents) {
      const subscriptionCount = accounts.filter(
        (account) => account.modelType === agent.name
      ).length;
      if (subscriptionCount > 0) {
        subscriptionMap.set(agent.name, subscriptionCount);
      }
    }
    return subscriptionMap;
  }, [agents, accounts]);

  const installFilterOptions = useMemo<SelectOption[]>(
    () => [
      {
        value: INSTALL_FILTER.ALL,
        label: tIntegrations("cliTable.filterAllInstall"),
      },
      {
        value: INSTALL_FILTER.INSTALLED,
        label: t("cliConfig.installed"),
      },
      {
        value: INSTALL_FILTER.NOT_INSTALLED,
        label: t("cliConfig.statusNotInstalled"),
      },
    ],
    [t, tIntegrations]
  );

  const readyFilterOptions = useMemo<SelectOption[]>(
    () => [
      {
        value: READY_FILTER.ALL,
        label: tIntegrations("cliTable.filterAllReady"),
      },
      {
        value: READY_FILTER.READY,
        label: tIntegrations("cliTable.filterReady"),
      },
      {
        value: READY_FILTER.NO_SUBSCRIPTIONS,
        label: tIntegrations("cliTable.filterNoSubscriptions"),
      },
    ],
    [tIntegrations]
  );

  const setSingleExpandedAgent = useCallback((agent: AvailableAgent) => {
    setExpandedAgentKeys((currentKeys) =>
      currentKeys.includes(agent.name) ? [] : [agent.name]
    );
  }, []);

  const handleViewAgent = useCallback((agent: AvailableAgent) => {
    openAgentConfigInWorkStation({
      variant: "cli",
      entityId: agent.name,
      displayName: agent.displayName,
      entitySnapshot: agent,
      cliAgentType: agent.name,
    });
  }, []);

  const handleEnabledChange = useCallback(
    (agent: AvailableAgent, enabled: boolean) => {
      setCliAgentEnabled(agent.name, enabled, agent.installed);
    },
    [setCliAgentEnabled]
  );

  const cliSelectFilters = useMemo<SettingsTableSelectFilter[]>(
    () => [
      {
        key: "install",
        value: installFilter,
        defaultValue: INSTALL_FILTER.ALL,
        options: installFilterOptions,
        onChange: (val) => setInstallFilter(val as InstallFilter),
      },
      {
        key: "ready",
        value: readyFilter,
        defaultValue: READY_FILTER.ALL,
        options: readyFilterOptions,
        onChange: (val) => setReadyFilter(val as ReadyFilter),
      },
    ],
    [installFilter, installFilterOptions, readyFilter, readyFilterOptions]
  );

  const columns: SettingsTableColumn<AvailableAgent>[] = useMemo(
    () => [
      {
        key: "agent",
        label: t("cliConfig.tableAgent"),
        width: SETTINGS_TABLE_COL.fill,
        sorter: (agentA, agentB) =>
          agentA.displayName.localeCompare(agentB.displayName),
        renderCell: (agent) => (
          <span
            className={`${SETTINGS_TABLE_CELL.primary} inline-flex items-center gap-2`}
          >
            <ModelIcon agentType={agent.name as ModelType} size={16} />
            <span>{agent.displayName}</span>
            {agent.installed && (
              <Tag size="mini" color="success" pill className="shrink-0">
                {t("cliConfig.installed")}
              </Tag>
            )}
            {agent.supportsGui && (
              <Tag size="mini" color="primary" pill className="shrink-0">
                GUI
              </Tag>
            )}
          </span>
        ),
      },
      {
        key: "subscriptions",
        label: tIntegrations("cliPreview.subscriptions"),
        width: "130px",
        sorter: (agentA, agentB) =>
          (subscriptionsByAgent.get(agentB.name) ?? 0) -
          (subscriptionsByAgent.get(agentA.name) ?? 0),
        renderCell: (agent) => {
          const subscriptionCount = subscriptionsByAgent.get(agent.name) ?? 0;

          if (subscriptionCount === 0) {
            return (
              <StatusDot
                color="bg-fill-3"
                size="inline"
                labelClassName="text-[12px] text-text-3"
                label={t("dependencies.notFound")}
              />
            );
          }

          return (
            <StatusDot
              color="bg-success-6"
              size="inline"
              labelClassName="text-[12px] text-text-2"
              label={tIntegrations("cliPreview.subscriptions")}
              count={subscriptionCount}
            />
          );
        },
      },
      {
        key: "enabled",
        label: (
          <span className="sr-only">
            {tIntegrations("common:labels.status", {
              defaultValue: "Status",
            })}
          </span>
        ),
        width: SETTINGS_TABLE_COL.hug,
        align: "right",
        sorter: (agentA, agentB) => {
          const enabledA =
            agentA.installed &&
            isCliAgentEnabled(
              agentA.name,
              agentA.installed,
              cliVisibilityOverrides
            );
          const enabledB =
            agentB.installed &&
            isCliAgentEnabled(
              agentB.name,
              agentB.installed,
              cliVisibilityOverrides
            );
          return Number(enabledA) - Number(enabledB);
        },
        renderCell: (agent) => {
          const enabled = isCliAgentEnabled(
            agent.name,
            agent.installed,
            cliVisibilityOverrides
          );
          const switchChecked = agent.installed && enabled;
          return (
            <div
              className="flex items-center justify-end gap-2 whitespace-nowrap"
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
            >
              <Switch
                size={MODEL_TABLE_SWITCH_SIZE}
                checked={switchChecked}
                disabled={!agent.installed}
                onCheckedChange={(nextEnabled) =>
                  handleEnabledChange(agent, nextEnabled)
                }
                ariaLabel={tIntegrations("common:labels.enabled", {
                  defaultValue: "Enabled",
                })}
              />
              <Button
                variant="secondary"
                size="small"
                onClick={() => handleViewAgent(agent)}
              >
                {tIntegrations("common:actions.view", { defaultValue: "View" })}
              </Button>
            </div>
          );
        },
      },
    ],
    [
      t,
      tIntegrations,
      subscriptionsByAgent,
      cliVisibilityOverrides,
      handleEnabledChange,
      handleViewAgent,
    ]
  );

  const renderExpandedAgentCard = useCallback(
    (agent: AvailableAgent) => (
      <CliClientInlineExpandedCard
        agent={agent}
        accounts={accounts}
        activeTab={activeInlineTab}
        onActiveTabChange={setActiveInlineTab}
        onRefresh={fetchAgents}
        refreshing={loading}
        onAdd={onAdd}
        cliAgents={cliAgents}
      />
    ),
    [accounts, activeInlineTab, cliAgents, fetchAgents, loading, onAdd]
  );

  const expandable = useMemo(
    () => ({
      rowExpandable: () => true,
      expandedRowRender: renderExpandedAgentCard,
      expandedRowKeys: expandedAgentKeys,
      onExpandedRowsChange: (keys: string[]) => {
        setExpandedAgentKeys(keys.slice(-1));
      },
    }),
    [expandedAgentKeys, renderExpandedAgentCard]
  );

  const filtered = useMemo(() => {
    let rows = agents;

    if (installFilter === INSTALL_FILTER.INSTALLED) {
      rows = rows.filter((agent) => agent.installed);
    } else if (installFilter === INSTALL_FILTER.NOT_INSTALLED) {
      rows = rows.filter((agent) => !agent.installed);
    }

    if (readyFilter === READY_FILTER.READY) {
      rows = rows.filter((agent) => {
        const subscriptions = subscriptionsByAgent.get(agent.name) ?? 0;
        return subscriptions > 0;
      });
    } else if (readyFilter === READY_FILTER.NO_SUBSCRIPTIONS) {
      rows = rows.filter((agent) => {
        const subscriptions = subscriptionsByAgent.get(agent.name) ?? 0;
        return subscriptions === 0;
      });
    }

    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      rows = rows.filter((agent) =>
        agent.displayName.toLowerCase().includes(query)
      );
    }

    return rows;
  }, [agents, searchQuery, installFilter, readyFilter, subscriptionsByAgent]);

  const addButtonLabel = tIntegrations("common:actions.add", {
    defaultValue: "Add",
  });
  const refreshButtonLabel = tIntegrations("common:actions.refresh", {
    defaultValue: "Refresh",
  });

  const headerActions = (
    <div className="flex items-center gap-1">
      <Button
        variant="secondary"
        size="default"
        icon={<RefreshCw size={14} className={spinClass} />}
        iconOnly
        aria-label={refreshButtonLabel}
        title={refreshButtonLabel}
        onClick={handleRefreshClick}
      />
      {onAdd && (
        <Button
          variant="secondary"
          size="default"
          icon={<Plus size={14} />}
          iconOnly
          aria-label={addButtonLabel}
          title={addButtonLabel}
          onClick={onAdd}
        />
      )}
    </div>
  );

  if (error)
    return (
      <Placeholder
        variant="error"
        onRetry={fetchAgents ? () => fetchAgents() : undefined}
      />
    );

  return (
    <SettingsTable
      hover
      loading={loading}
      selectFilters={cliSelectFilters}
      rows={filtered}
      columns={columns}
      getRowKey={(agent) => agent.name}
      onRowClick={setSingleExpandedAgent}
      expandable={expandable}
      headerHeight="tall"
      className="table-expanded-no-hover table-settings-expanded-compact"
      searchBar={{
        searchValue: searchQuery,
        onSearchChange: setSearchQuery,
        searchPlaceholder: t("cliConfig.searchPlaceholder"),
        allowSearchClear: true,
        rightContent: headerActions,
      }}
    />
  );
};

export default CliClientsTable;
