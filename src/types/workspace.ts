/**
 * Workspace Types
 *
 * Multi-root workspace support types, modeled after VS Code/Cursor workspace conventions.
 * A workspace can contain multiple folder roots, each with independent git tracking.
 */

// ============================================
// Core Workspace Types
// ============================================

/** A single folder root within a workspace */
export interface WorkspaceFolder {
  /** Unique identifier (UUID) */
  id: string;
  /** Display name (defaults to folder basename, user-customizable) */
  name: string;
  /** Absolute filesystem path */
  path: string;
  /** file:// URI */
  uri: string;
  /** Whether this is the primary folder (used as default workspace_path for agents) */
  isPrimary: boolean;
  /** Optional back-reference to the Repo this folder was imported as (for git tracking) */
  repoId?: string;
  /** Folder kind - "git" for repos with .git, "folder" for plain folders */
  kind?: "git" | "folder";
}

/** Workspace-level settings (persisted inside .orgii-workspace file) */
export interface WorkspaceSettings {
  /** Which folder id is marked primary (for agent/LSP default target) */
  primaryFolderId?: string;
  /** User-defined workspace display name (shown in title bar, status bar) */
  displayName?: string;
  /** Arbitrary extension settings keyed by extension id */
  extensions?: Record<string, unknown>;
}

/** Persisted workspace configuration (.orgii-workspace file) */
export interface WorkspaceConfig {
  /** Ordered list of workspace folders */
  folders: WorkspaceFolderEntry[];
  /** Optional workspace-level settings overrides */
  settings?: Record<string, unknown> & WorkspaceSettings;
}

/** Recent workspace entry (persisted to localStorage) */
export interface RecentWorkspace {
  /** Path to the .orgii-workspace file */
  path: string;
  /** Display name (from settings.displayName or filename) */
  name: string;
  /** Number of folders in the workspace (shown in palette) */
  folderCount: number;
  /** Last opened timestamp */
  lastOpened: number;
}

/** Minimal folder entry for .orgii-workspace file (no runtime fields like id) */
export interface WorkspaceFolderEntry {
  /** Absolute filesystem path */
  path: string;
  /** Optional custom display name */
  name?: string;
}

// ============================================
// Constants
// ============================================

export const WORKSPACE_FILE_EXTENSION = ".orgii-workspace";
