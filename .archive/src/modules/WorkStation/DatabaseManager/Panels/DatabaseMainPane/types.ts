/**
 * DatabaseMainPane Types
 */
import type { TableInfo } from "@src/engines/DatabaseCore";

import type { ViewMode } from "./config";

// ============================================
// Component Props
// ============================================

export interface DatabaseMainPaneProps {
  connectionId: string | null;
  tableName: string | null;
  repoPath: string;
  /** Available tables for SQL autocomplete */
  tables?: TableInfo[];
  /**
   * Called once the pane has a live executeQuery function to expose.
   * Pass a stable ref-setter; the parent captures it to allow the sidebar
   * history "Run" button to trigger execution without prop drilling the
   * callback through every intermediate layer.
   */
  onRegisterExecuteQuery?: (fn: (sql: string) => Promise<void>) => void;
}

// ============================================
// Re-export ViewMode
// ============================================

export type { ViewMode };
