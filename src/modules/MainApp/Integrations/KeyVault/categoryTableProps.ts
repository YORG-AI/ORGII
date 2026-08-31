import type { ComponentProps } from "react";

import type { useExtensionsState } from "../hooks/useExtensionsState";
import type { AddAction, DetailMode } from "../types";
import type { useCliAgents } from "./CliClients/hooks/useCliAgents";
import type { AccountsTable } from "./Table/AccountsTable";
import type { useKeyVaultPage } from "./hooks/useKeyVaultPage";

export type AccountsCategoryTableProps = ComponentProps<typeof AccountsTable>;

export function getAccountsCategoryTableProps(params: {
  accounts: ReturnType<typeof useKeyVaultPage>;
  onSelect: (id: string | null, mode?: DetailMode) => void;
  models: Pick<
    ReturnType<typeof useExtensionsState>,
    "modelsActiveTab" | "handleToggleModel"
  >;
  modelsActiveTab?: string;
  onModelsTabChange: (tab: string) => void;
  cliAgents: ReturnType<typeof useCliAgents>;
  onAddAction: (action: AddAction) => void;
}): AccountsCategoryTableProps {
  return {
    accounts: params.accounts.filteredAccounts,
    loading: params.accounts.loading,
    onSelect: params.onSelect,
    onAdd: () => params.onAddAction("add-model"),
    onRefresh: params.accounts.refresh,
    onRefreshAccountUsage: params.accounts.handleRefreshAccountUsage,
    onEditAccountSave: params.accounts.handleEditAccountSave,
    onDisconnectAccount: params.accounts.handleDisconnect,
    onRevalidateAccount: params.accounts.handleRefreshAccount,
    refreshingAccountId: params.accounts.refreshingAccountId,
    onRefreshModels: params.accounts.handleRefreshAllModels,
    refreshingAllModels: params.accounts.refreshingAllModels,
    modelsActiveTab: params.modelsActiveTab ?? params.models.modelsActiveTab,
    onModelsTabChange: params.onModelsTabChange,
    onToggleModel: params.models.handleToggleModel,
    cliAgents: {
      agents: params.cliAgents.agents,
      loading: params.cliAgents.loading,
      error: params.cliAgents.error,
      actionMap: params.cliAgents.actionMap,
      fetchAgents: params.cliAgents.fetchAgents,
      handleInstall: params.cliAgents.handleInstall,
      handleUninstall: params.cliAgents.handleUninstall,
      handleDetect: params.cliAgents.handleDetect,
    },
  };
}
