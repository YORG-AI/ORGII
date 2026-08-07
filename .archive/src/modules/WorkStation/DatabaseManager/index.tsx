/**
 * DatabaseManager Component
 *
 * Main entry point for Database Manager mode (appMode === "data").
 * Wraps DatabaseLayout with ActionSystemProvider.
 *
 * Architecture:
 * - Shown when user switches to "data" mode.
 * - DatabaseLayout handles all panel orchestration
 */
import React, { memo } from "react";

import { ActionSystemProvider } from "@src/ActionSystem";

import { DatabaseLayout } from "./DatabaseLayout";

// ============================================
// Types
// ============================================

export interface DatabaseManagerProps {
  /** Repository path (for context, e.g., finding .sqlite files) */
  repoPath: string;
  /** Repository name for display */
  repoName: string;
}

// ============================================
// Component
// ============================================

export const DatabaseManager: React.FC<DatabaseManagerProps> = memo(
  ({ repoPath, repoName }) => {
    return (
      <ActionSystemProvider repoPath={repoPath} repoId={repoPath}>
        <DatabaseLayout repoPath={repoPath} repoName={repoName} />
      </ActionSystemProvider>
    );
  }
);

DatabaseManager.displayName = "DatabaseManager";

export default DatabaseManager;
