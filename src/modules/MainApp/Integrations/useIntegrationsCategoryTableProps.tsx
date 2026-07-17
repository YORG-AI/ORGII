import { type Dispatch, type SetStateAction, useMemo } from "react";

import type { DependencyStatus } from "@src/hooks/dependencies";

import type { useCliAgents } from "./KeyVault/CliClients/hooks/useCliAgents";
import type { useKeyVaultPage } from "./KeyVault/hooks/useKeyVaultPage";
import type { CategoryTableContentProps } from "./Tables";
import type { useChannelState } from "./hooks/useChannelState";
import type { useConnectionsState } from "./hooks/useConnectionsState";
import type { useDatabasesState } from "./hooks/useDatabasesState";
import type { useExtensionsState } from "./hooks/useExtensionsState";
import type { useRoutinesState } from "./hooks/useRoutinesState";
import type { useRulesMemoryEvolutionState } from "./hooks/useRulesMemoryEvolutionState";
import type { AddAction, DetailMode, IntegrationCategory } from "./types";

export interface UseIntegrationsCategoryTablePropsParams {
  category: IntegrationCategory;
  accountsHook: ReturnType<typeof useKeyVaultPage>;
  handleAccountSelect: (id: string | null, mode?: DetailMode) => void;
  extensions: ReturnType<typeof useExtensionsState>;
  channelState: ReturnType<typeof useChannelState>;
  connections: ReturnType<typeof useConnectionsState>;
  databasesState: ReturnType<typeof useDatabasesState>;
  databasesActiveTab: string;
  handleDatabasesTabChange: (tab: string) => void;
  selectedDbClient: DependencyStatus | null;
  setSelectedDbClient: Dispatch<SetStateAction<DependencyStatus | null>>;
  policies: ReturnType<typeof useRulesMemoryEvolutionState>;
  routines: ReturnType<typeof useRoutinesState>;
  cliAgents: ReturnType<typeof useCliAgents>;
  handleAddAction: (action: AddAction) => void;
  modelsActiveTab?: string;
  handleModelsTabChange: (tab: string) => void;
}

export interface UseIntegrationsCategoryTablePropsResult {
  tableProps: CategoryTableContentProps;
}

export function useIntegrationsCategoryTableProps(
  params: UseIntegrationsCategoryTablePropsParams
): UseIntegrationsCategoryTablePropsResult {
  const {
    category,
    accountsHook,
    handleAccountSelect,
    extensions,
    channelState,
    connections,
    databasesState,
    databasesActiveTab,
    handleDatabasesTabChange,
    selectedDbClient,
    setSelectedDbClient,
    policies,
    routines,
    cliAgents,
    handleAddAction,
    modelsActiveTab,
    handleModelsTabChange,
  } = params;

  // eslint-disable-next-line react-hooks/preserve-manual-memoization
  const tableProps = useMemo<CategoryTableContentProps>(
    () => ({
      category,
      accounts: accountsHook.filteredAccounts,
      accountsLoading: accountsHook.loading,
      onSelectAccount: handleAccountSelect,
      onRefreshAccounts: accountsHook.refresh,
      onRefreshAccountUsage: accountsHook.handleRefreshAccountUsage,
      onEditAccountSave: accountsHook.handleEditAccountSave,
      onDisconnectAccount: accountsHook.handleDisconnect,
      onRevalidateAccount: accountsHook.handleRefreshAccount,
      refreshingAccountId: accountsHook.refreshingAccountId,
      onRefreshModels: accountsHook.handleRefreshAllModels,
      refreshingAllModels: accountsHook.refreshingAllModels,
      modelsActiveTab: modelsActiveTab ?? extensions.modelsActiveTab,
      onModelsTabChange: handleModelsTabChange,
      onToggleModel: extensions.handleToggleModel,
      groupedChannels: channelState.groupedChannels,
      projectConnections: channelState.projectConnections,
      connectionsLoading:
        !channelState.loaded || channelState.projectConnectionsLoading,
      onSelectGitProvider: connections.handleGitProviderSelect,
      onSelectChannel: connections.handleChannelClick,
      onRemoveChannel: channelState.handleRemoveChannelRow,
      onRemoveProjectConnection: channelState.handleRemoveProjectConnection,
      databases: databasesState.databases,
      databasesLoading: databasesState.loading,
      onSelectDatabase: databasesState.handleSelectDatabase,
      onAddDatabase: databasesState.handleAddDatabase,
      onRefreshDatabases: databasesState.refreshDatabases,
      databasesActiveTab,
      onDatabasesActiveTabChange: handleDatabasesTabChange,
      selectedDbClient,
      onSelectDbClient: setSelectedDbClient,
      mcpServers: extensions.mcpServers.servers,
      mcpLoading: extensions.mcpServers.loading,
      onSelectMcp: extensions.handleExtensionSelect,
      onMcpAdd: extensions.triggerMcpAdd,
      onMcpDelete: extensions.mcp.onDelete,
      onMcpReconnect: extensions.mcp.onReconnect,
      onMcpSetDisabled: extensions.mcp.onSetDisabled,
      onMcpBulkSetDisabled: extensions.mcp.onBulkSetDisabled,
      onMcpBulkReconnect: extensions.mcp.onBulkReconnect,
      onMcpAfterImport: extensions.mcp.onRefresh,
      installedSkills: extensions.skillsHubRaw.installedSkills,
      skillsLoading: extensions.skillsHubRaw.installedLoading,
      onSelectSkill: extensions.handleExtensionSelect,
      onToggleSkill: extensions.skillsHub.onToggleSkill,
      onUninstallSkill: extensions.skillsHub.onUninstallSkill,
      onRefreshSkills: extensions.skillsHub.onRefreshInstalled,
      onSkillsAfterImport: extensions.skillsHub.onRefreshInstalled,
      markdownRules: policies.markdownRules,
      routines: routines.routines,
      policiesLoading:
        category === "routines"
          ? routines.routinesLoading
          : policies.policiesLoading || policies.allRepoPoliciesLoading,
      onSelectMarkdownRule: policies.handleSelectMarkdownRule,
      onDeleteMarkdownRule: policies.handleDeleteMarkdownRuleForRow,
      onToggleMarkdownRule: policies.handleToggleMarkdownRuleForRow,
      onSelectRoutine: routines.handleSelectRoutine,
      cliAgents: {
        agents: cliAgents.agents,
        loading: cliAgents.loading,
        error: cliAgents.error,
        actionMap: cliAgents.actionMap,
        fetchAgents: cliAgents.fetchAgents,
        handleInstall: cliAgents.handleInstall,
        handleUninstall: cliAgents.handleUninstall,
        handleDetect: cliAgents.handleDetect,
      },
      onAddAction: handleAddAction,
      extensionTablesEmbeddedChrome: category === "tools",
    }),
    [
      category,
      accountsHook,
      handleAccountSelect,
      extensions,
      databasesActiveTab,
      handleDatabasesTabChange,
      selectedDbClient,
      setSelectedDbClient,
      channelState,
      connections,
      databasesState,
      policies,
      routines,
      cliAgents,
      handleAddAction,
      modelsActiveTab,
      handleModelsTabChange,
    ]
  );

  return { tableProps };
}
