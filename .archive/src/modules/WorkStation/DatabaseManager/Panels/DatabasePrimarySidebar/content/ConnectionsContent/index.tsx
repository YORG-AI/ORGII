/**
 * ConnectionsContent Component
 *
 * Content for the Connections tab - wraps Added and Pending connections lists.
 * This is the tab RENDERING component (not configuration).
 */
import React, { memo } from "react";

import type { DatabaseConnection } from "@src/store/workstation/database";

import type { SqliteFile } from "../../types";
import AddedConnectionsList from "./components/AddedConnectionsList";
import PendingConnectionsList from "./components/PendingConnectionsList";

// ============================================
// Types
// ============================================

export interface ConnectionsContentProps {
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
}

// ============================================
// Sub-components for sections
// ============================================

export const AddedConnectionsSection: React.FC<{
  connections: DatabaseConnection[];
  selectedConnectionId: string | null;
  selectedTable: string | null;
  error: string | null;
  onToggleConnection: (connectionId: string) => void;
  onSelectTable: (connectionId: string, tableName: string) => void;
  onRefreshConnection: (event: React.MouseEvent, connectionId: string) => void;
  onCloseConnection: (event: React.MouseEvent, connectionId: string) => void;
}> = memo((props) => (
  <AddedConnectionsList
    connections={props.connections}
    selectedConnectionId={props.selectedConnectionId}
    selectedTable={props.selectedTable}
    error={props.error}
    onToggleConnection={props.onToggleConnection}
    onSelectTable={props.onSelectTable}
    onRefreshConnection={props.onRefreshConnection}
    onCloseConnection={props.onCloseConnection}
  />
));

AddedConnectionsSection.displayName = "AddedConnectionsSection";

export const PendingConnectionsSection: React.FC<{
  files: SqliteFile[];
  isScanning: boolean;
  error: string | null;
  onOpenFile: (file: SqliteFile) => void;
}> = memo((props) => (
  <PendingConnectionsList
    files={props.files}
    isScanning={props.isScanning}
    error={props.error}
    onOpenFile={props.onOpenFile}
  />
));

PendingConnectionsSection.displayName = "PendingConnectionsSection";

// ============================================
// Main Export (for direct use if needed)
// ============================================

export { AddedConnectionsList, PendingConnectionsList };
