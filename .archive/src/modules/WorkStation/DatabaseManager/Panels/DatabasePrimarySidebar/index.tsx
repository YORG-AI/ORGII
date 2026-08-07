/**
 * DatabasePrimarySidebar Component
 *
 * Primary sidebar for Database Manager using PrimarySidebarLayout.
 * Provides pill tabs:
 * - Connections: Two collapsible sections (Added Connections / Pending Connections)
 * - Query History: Past queries
 *
 * Shares structural components with other Workstation for consistency.
 */
import React, { memo, useCallback, useMemo, useState } from "react";

import {
  PrimarySidebarLayout,
  type PrimarySidebarTab,
} from "@src/modules/WorkStation/shared";

import { useDatabaseSidebarState } from "./hooks/useDatabaseSidebarState";
import { useConnectionsTabConfig } from "./tabs/ConnectionsTab";
import { useQueryHistoryTabConfig } from "./tabs/QueryHistoryTab";
import type { DatabasePrimarySidebarProps } from "./types";

// ============================================
// Component
// ============================================

export const DatabasePrimarySidebar: React.FC<DatabasePrimarySidebarProps> =
  memo(
    ({
      repoPath,
      selectedConnectionId,
      selectedTable,
      onSelectConnection,
      onSelectTable,
      onConnectionClose,
      onOpenAddModal,
      onOpenDbSelector,
      onRunQuery,
    }) => {
      // Active tab state
      const [activeTab, setActiveTab] = useState("connections");

      // Path to scan
      const [scanPath, setScanPath] = useState<string | null>(null);

      // Clear scan path after it's been processed
      const handleScanPathProcessed = useCallback(() => {
        setScanPath(null);
      }, []);

      // Use the shared sidebar state hook
      const {
        connections,
        connectionError,
        discoveredFiles,
        isScanning,
        scanError,
        handleToggleConnection,
        handleSelectTable,
        handleRefreshConnection,
        handleCloseConnection,
        handleOpenFile,
      } = useDatabaseSidebarState({
        repoPath,
        selectedConnectionId,
        onSelectConnection,
        onSelectTable,
        onConnectionClose,
        scanPath,
        onScanPathProcessed: handleScanPathProcessed,
      });

      // Handle tab change
      const handleTabChange = useCallback((tab: string) => {
        setActiveTab(tab);
      }, []);

      // Get tab configurations
      const connectionsTab = useConnectionsTabConfig({
        connections,
        selectedConnectionId,
        selectedTable,
        connectionError,
        onToggleConnection: handleToggleConnection,
        onSelectTable: handleSelectTable,
        onRefreshConnection: handleRefreshConnection,
        onCloseConnection: handleCloseConnection,
        discoveredFiles,
        isScanning,
        scanError,
        onOpenFile: handleOpenFile,
        onOpenAddModal,
        onOpenDbSelector,
      });

      const queryHistoryTab = useQueryHistoryTabConfig({
        connectionId: selectedConnectionId,
        onRunQuery,
      });

      // Build tabs array
      const tabs: PrimarySidebarTab[] = useMemo(
        () => [connectionsTab, queryHistoryTab],
        [connectionsTab, queryHistoryTab]
      );

      return (
        <PrimarySidebarLayout
          tabs={tabs}
          activeTab={activeTab}
          onTabChange={handleTabChange}
          tabIconOnly={true}
        />
      );
    }
  );

DatabasePrimarySidebar.displayName = "DatabasePrimarySidebar";

export default DatabasePrimarySidebar;
