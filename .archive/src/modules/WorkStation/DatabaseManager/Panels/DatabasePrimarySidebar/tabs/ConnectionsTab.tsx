/**
 * ConnectionsTab Configuration
 *
 * Tab configuration hook for the Connections tab.
 * Defines sections and actions for Added/Pending connections.
 */
import { Cloud, Database, Plus } from "lucide-react";
import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { SectionHeaderAction } from "@src/components/TreePanelSidebar/types";
import type { PrimarySidebarTab } from "@src/modules/WorkStation/shared";
import type { DatabaseConnection } from "@src/store/workstation/database";

import {
  AddedConnectionsSection,
  PendingConnectionsSection,
} from "../content/ConnectionsContent";
import type { SqliteFile } from "../types";

// ============================================
// Types
// ============================================

export interface UseConnectionsTabConfigProps {
  // Added connections
  connections: DatabaseConnection[];
  selectedConnectionId: string | null;
  selectedTable: string | null;
  connectionError: string | null;
  onToggleConnection: (connectionId: string) => void;
  onSelectTable: (connectionId: string, tableName: string) => void;
  onRefreshConnection: (event: React.MouseEvent, connectionId: string) => void;
  onCloseConnection: (event: React.MouseEvent, connectionId: string) => void;

  // Pending connections
  discoveredFiles: SqliteFile[];
  isScanning: boolean;
  scanError: string | null;
  onOpenFile: (file: SqliteFile) => void;

  // Actions
  onOpenAddModal: () => void;
  onOpenDbSelector: () => void;
}

// ============================================
// Hook
// ============================================

export function useConnectionsTabConfig({
  connections,
  selectedConnectionId,
  selectedTable,
  connectionError,
  onToggleConnection,
  onSelectTable,
  onRefreshConnection,
  onCloseConnection,
  discoveredFiles,
  isScanning,
  scanError,
  onOpenFile,
  onOpenAddModal,
  onOpenDbSelector,
}: UseConnectionsTabConfigProps): PrimarySidebarTab {
  const { t } = useTranslation();
  // Section header actions for Added Connections
  const addedConnectionsActions: SectionHeaderAction[] = useMemo(
    () => [
      {
        key: "add-remote",
        icon: <Cloud size={14} />,
        tooltip: "Add remote (Supabase, Turso)",
        onClick: onOpenAddModal,
      },
      {
        key: "add-database",
        icon: <Plus size={14} />,
        tooltip: "Add SQLite",
        onClick: onOpenDbSelector,
      },
    ],
    [onOpenAddModal, onOpenDbSelector]
  );

  // Section header actions for Pending Connections
  const pendingConnectionsActions: SectionHeaderAction[] = useMemo(
    () => [
      {
        key: "scan-folder",
        icon: <Plus size={14} />,
        tooltip: "Scan folder",
        onClick: onOpenDbSelector,
      },
    ],
    [onOpenDbSelector]
  );

  return useMemo(
    () => ({
      key: "connections",
      label: t("tabs.connections"),
      icon: <Database size={16} strokeWidth={1.75} />,
      sections: [
        {
          key: "added-connections",
          title: t("labels.addedConnections"),
          content: (
            <AddedConnectionsSection
              connections={connections}
              selectedConnectionId={selectedConnectionId}
              selectedTable={selectedTable}
              error={connectionError}
              onToggleConnection={onToggleConnection}
              onSelectTable={onSelectTable}
              onRefreshConnection={onRefreshConnection}
              onCloseConnection={onCloseConnection}
            />
          ),
          defaultFlexGrow: 1,
          resizable: true,
          actions: addedConnectionsActions,
        },
        {
          key: "pending-connections",
          title: t("labels.pendingConnections"),
          content: (
            <PendingConnectionsSection
              files={discoveredFiles}
              isScanning={isScanning}
              error={scanError}
              onOpenFile={onOpenFile}
            />
          ),
          defaultFlexGrow: 1,
          resizable: true,
          actions: pendingConnectionsActions,
        },
      ],
    }),
    [
      t,
      connections,
      selectedConnectionId,
      selectedTable,
      connectionError,
      onToggleConnection,
      onSelectTable,
      onRefreshConnection,
      onCloseConnection,
      addedConnectionsActions,
      discoveredFiles,
      isScanning,
      scanError,
      onOpenFile,
      pendingConnectionsActions,
    ]
  );
}
