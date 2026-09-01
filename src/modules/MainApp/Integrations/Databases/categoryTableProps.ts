import type { ComponentProps } from "react";

import type { useDatabasesState } from "../hooks/useDatabasesState";
import type { DependencyStatus } from "../hooks/useSystemDependencies";
import type { DatabasesTable } from "./Table/DatabasesTable";

export type DatabasesCategoryTableProps = ComponentProps<typeof DatabasesTable>;

export function getDatabasesCategoryTableProps(params: {
  databases: ReturnType<typeof useDatabasesState>;
  activeTab: string;
  onActiveTabChange: (tab: string) => void;
  selectedDbClient: DependencyStatus | null;
  onSelectDbClient: (client: DependencyStatus | null) => void;
}): DatabasesCategoryTableProps {
  return {
    databases: params.databases.databases ?? [],
    loading: params.databases.loading ?? false,
    onSelect: params.databases.handleSelectDatabase,
    onAdd: params.databases.handleAddDatabase,
    onRefresh: params.databases.refreshDatabases,
    activeTab: params.activeTab,
    onActiveTabChange: params.onActiveTabChange,
    selectedDbClient: params.selectedDbClient,
    onSelectDbClient: params.onSelectDbClient,
  };
}
