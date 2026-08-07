/**
 * DatabasePrimarySidebar Types
 */

// ============================================
// Component Props
// ============================================

export interface DatabasePrimarySidebarProps {
  repoPath: string;
  selectedConnectionId: string | null;
  selectedTable: string | null;
  onSelectConnection: (connectionId: string | null) => void;
  /** Called when a table is selected - opens a tab */
  onSelectTable: (connectionId: string, tableName: string) => void;
  /** Called when a connection is closed - to clean up tabs */
  onConnectionClose?: (connectionId: string) => void;
  /** Called to open the add remote connection modal */
  onOpenAddModal: () => void;
  /** Called to open the database selector (scan folder/open file) */
  onOpenDbSelector: () => void;
  /** Called when the user clicks Run on a query history item */
  onRunQuery?: (sql: string) => void;
}

// ============================================
// SQLite File Type
// ============================================

export interface SqliteFile {
  path: string;
  name: string;
}
