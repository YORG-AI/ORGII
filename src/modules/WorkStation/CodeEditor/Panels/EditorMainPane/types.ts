/**
 * EditorContent Types
 *
 * Type definitions for the main content area.
 */
import type { UseTerminalStateReturn } from "@/src/engines/TerminalCore/exports";
import type { ReactNode } from "react";

import type { SourceControlFilterMode } from "@src/modules/WorkStation/shared/SidebarModules";
import type { CursorPosition } from "@src/modules/WorkStation/shared/StatusBar/EditorStatusBar";
import type { PanelState, WorkStationTab } from "@src/store/workstation/tabs";
import type { GitFile } from "@src/types/git/types";

// ============================================
// Tab Types
// ============================================

/**
 * All supported tab types in the editor content area
 */
export type EditorTabType =
  | "file"
  | "directory"
  | "explorer"
  | "git-diff"
  | "source-control"
  | "git-log"
  | "terminal-content"
  | "dom-component-preview"
  | "terminal"
  | "output"
  | "settings"
  | "search"
  | "lint-scan";

// ============================================
// Component Props
// ============================================

export interface EditorContentProps {
  // File viewing (only used as fallback / for tree selection sync)
  selectedFile: string | null;
  fileContent: string;
  loading: boolean;
  error: string | null;
  repoPath: string;
  repoId?: string | null;
  repoDisplayName: string;

  // Git diff viewing
  gitDiffTabs: Set<string>;
  gitFilesByPath: Map<string, GitFile>;
  gitDiffLoading: boolean;

  // Actions
  onFileSelect: (path: string) => void;
  onFileSelectWithLine?: (path: string, line: number) => void;
  onContentChange: (content: string) => void;
  onSave: () => Promise<void>;
  onDiscard: () => void;
  onAllChangesClick: () => void;

  // Flags (fallback from parent)
  hasUnsavedChanges: boolean;
  saving: boolean;
  isBinary: boolean;

  // Cursor position
  onCursorPositionChange?: (position: CursorPosition | null) => void;

  // Terminal tab
  terminalState: UseTerminalStateReturn;

  // Source Control header controls
  sourceControlHeaderLeadingSlot?: ReactNode;
  sourceControlHeaderTrailingSlot?: ReactNode;
  sourceControlFilterMode?: SourceControlFilterMode;
  /** Repo/worktree root selected by the Source Control scope picker. */
  sourceControlActiveRepoRoot?: string;
  showSourceControlModePill?: boolean;
}

// ============================================
// Hook Types
// ============================================

/**
 * Return type for useEditorPaneState hook
 */
export interface UseEditorPaneStateReturn {
  /** Current tabs in this pane */
  tabs: WorkStationTab[];
  /** Currently active tab ID */
  activeTabId: string | null;
  /** Currently active tab object */
  activeTab: WorkStationTab | null;
  /** Current panel state */
  currentState: PanelState;
  /** Switch to a specific tab */
  switchToTab: (tabId: string) => void;
  /** Close a tab (with unsaved changes handling) */
  closeTab: (tabId: string) => Promise<void>;
  /** Reorder tabs via drag and drop */
  reorderTabs: (startIndex: number, endIndex: number) => void;
  /** Close all tabs except the specified one */
  closeOtherTabs: (tabId: string) => Promise<void>;
  /** Close all saved tabs (keep unsaved) */
  closeSavedTabs: () => void;
  /** Generic pane state updater */
  updatePaneState: (updater: (state: PanelState) => PanelState) => void;
}

/**
 * Options for useFileContentManager hook
 */
export interface UseFileContentManagerOptions {
  /** Path to the active file */
  activeFilePath: string | null;
  /** Callback after successful save */
  onSaveSuccess?: () => void;
}

/**
 * Options for useTabContentSync hook
 */
export interface UseTabContentSyncOptions {
  /** Currently active tab */
  activeTab: WorkStationTab | null;
  /** Whether file has unsaved changes */
  hasUnsavedChanges: boolean;
  /** Whether file is loading */
  fileLoading: boolean;
  /** File content (for navigation) */
  fileContent: string | null;
  /** Generic pane state updater */
  updatePaneState: (updater: (state: PanelState) => PanelState) => void;
}

// ============================================
// Re-exports
// ============================================

export type { CursorPosition };
export type { PanelState, WorkStationTab };
export type { GitFile };
