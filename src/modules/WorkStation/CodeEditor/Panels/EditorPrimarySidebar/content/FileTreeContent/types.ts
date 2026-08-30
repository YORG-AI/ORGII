/** Types owned by the WorkStation file tree. */
import type { GitFileInfo } from "@/src/store/git";

import type { TreePanelNode } from "@src/components/TreePanelSidebar/types";

export type { GitFileInfo };

export interface TreeNodeProps {
  node: TreePanelNode;
  depth: number;
  onSelectNode: (path: string, node: TreePanelNode) => void;
  onToggleDirectory: (path: string) => void;
  /** Whether this node is currently in rename mode */
  isRenaming?: boolean;
  /** Callback when rename is confirmed */
  onRenameConfirm?: (oldPath: string, newName: string) => void;
  /** Callback when rename is cancelled */
  onRenameCancel?: () => void;
}

/** Dispatch function type for GUI actions */
export type DispatchFn = (
  actionType: string,
  payload: Record<string, unknown>,
  source: "user" | "ai" | "system"
) => Promise<unknown>;

export interface FileTreeContentProps {
  treeData: TreePanelNode[];
  selectedPath: string | null;
  repoPath?: string | null;
  onSelectNode: (path: string, node: TreePanelNode) => void;
  onToggleDirectory: (path: string) => void;
  filterQuery: string;
  onFilterChange: (query: string) => void;
  filterPlaceholder?: string;
  showFilter?: boolean;
  loading?: boolean;
  error?: string | null;
  emptyMessage?: string;
  noResultsMessage?: string;
  revealPath?: string | null;
  revealKey?: number | null;
  /** Optional dispatch function for file operations (from ActionSystem) */
  dispatch?: DispatchFn;
  /** Whether the workspace has multiple root folders */
  isMultiRoot?: boolean;
}

export interface FlattenedNode {
  node: TreePanelNode;
  depth: number;
}

export interface GitStatusContextValue {
  statusMap: Map<string, GitFileInfo>;
  folderStatusMap: Map<string, string>;
  repoPath: string | null;
  isMultiRoot: boolean;
}

export interface CreatingNewState {
  parentDir: string;
  isFolder: boolean;
}

/**
 * Handle for imperative control of FileTreeContent.
 * Used by parent components to trigger inline file/folder creation.
 */
export interface FileTreeContentHandle {
  /**
   * Start creating a new file or folder at the specified parent directory.
   * Expands the parent if collapsed, inserts placeholder, and scrolls to it.
   * @param parentDir - The directory path where the new item will be created
   * @param isFolder - Whether to create a folder (true) or file (false)
   */
  startCreatingNew: (parentDir: string, isFolder: boolean) => void;
}
