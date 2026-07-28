/**
 * FileTreeRows - Stateless rendering helpers for file tree items.
 *
 * Extracted to keep index.tsx lean and allow consumers to compose
 * custom rendering without reimplementing the full component.
 */
import { ChevronDown, ChevronRight } from "lucide-react";
import React from "react";

import type { TreePanelNode } from "@src/components/TreePanelSidebar/types";
import { TREE_INDENT_PX, TREE_PADDING_X } from "@src/components/TreeRow";
import type {
  FlattenedTreeNode,
  StickyScrollNode,
} from "@src/components/VirtualizedStickyTree";
import { getStatusBgColor, getStatusColorForFile } from "@src/config/gitStatus";
import { FolderHeaderRow } from "@src/modules/WorkStation/shared/FolderHeaderRow";

import { NewItemInput } from "./NewItemInput";
import { TreeNode } from "./TreeNode";
import type { CreatingNewState } from "./types";
import { NEW_ITEM_PLACEHOLDER_ID } from "./useFileTreeMutationState";
import { getLookupPath } from "./utils/treeUtils";

export interface FileTreeItemRendererOptions {
  creatingNew: CreatingNewState | null;
  renamingPath: string | null;
  isMultiRoot: boolean;
  onSelectNode: (path: string, node: TreePanelNode) => void;
  onToggleDirectory: (path: string) => void;
  onContextMenu: (event: React.MouseEvent, node: TreePanelNode | null) => void;
  onRenameConfirm: (oldPath: string, newName: string) => void;
  onRenameCancel: () => void;
  onCreateNewConfirm: (name: string) => void;
  onCreateNewCancel: () => void;
}

export function renderFileTreeItem(
  item: FlattenedTreeNode<TreePanelNode>,
  options: FileTreeItemRendererOptions
): React.ReactNode {
  const {
    creatingNew,
    renamingPath,
    isMultiRoot,
    onSelectNode,
    onToggleDirectory,
    onContextMenu,
    onRenameConfirm,
    onRenameCancel,
    onCreateNewConfirm,
    onCreateNewCancel,
  } = options;

  if (item.node.path === NEW_ITEM_PLACEHOLDER_ID && creatingNew) {
    return (
      <NewItemInput
        depth={item.depth}
        isFolder={creatingNew.isFolder}
        onConfirm={onCreateNewConfirm}
        onCancel={onCreateNewCancel}
      />
    );
  }

  if (isMultiRoot && item.depth === 0 && item.node.type === "directory") {
    const isExpanded = item.node.expanded ?? false;
    return (
      <FolderHeaderRow
        name={item.node.name}
        expanded={isExpanded}
        onToggle={() => onToggleDirectory(item.node.path)}
        onContextMenu={(event) => onContextMenu(event, item.node)}
      />
    );
  }

  const isRenaming = renamingPath === item.node.path;
  const depth = isMultiRoot ? Math.max(0, item.depth - 1) : item.depth;

  return (
    <div onContextMenu={(event) => onContextMenu(event, item.node)}>
      <TreeNode
        node={item.node}
        depth={depth}
        onSelectNode={onSelectNode}
        onToggleDirectory={onToggleDirectory}
        isRenaming={isRenaming}
        onRenameConfirm={onRenameConfirm}
        onRenameCancel={onRenameCancel}
      />
    </div>
  );
}

export interface StickyTreeHeaderProps {
  stickyNode: StickyScrollNode<TreePanelNode>;
  repoPath: string | null;
  isMultiRoot: boolean;
  gitFolderStatusMap: Map<string, string>;
  onClick: () => void;
}

export function StickyTreeHeader({
  stickyNode,
  repoPath,
  isMultiRoot,
  gitFolderStatusMap,
  onClick,
}: StickyTreeHeaderProps) {
  const { node, depth } = stickyNode;
  const lookupPath = getLookupPath(node.path, repoPath, isMultiRoot);
  const aggregateStatus = gitFolderStatusMap.get(lookupPath);
  const gitInfo = aggregateStatus
    ? { status: aggregateStatus, staged: false }
    : null;
  const isExpanded = node.expanded ?? false;

  return (
    <div
      className="flex h-full cursor-pointer items-center gap-1.5 overflow-hidden bg-bg-1 transition-colors hover:bg-fill-2"
      style={{
        paddingLeft: `${depth * TREE_INDENT_PX + TREE_PADDING_X}px`,
        paddingRight: "8px",
      }}
      onClick={onClick}
      title={`Scroll to ${node.name}`}
    >
      <div className="flex h-4 w-4 flex-shrink-0 items-center justify-center">
        {isExpanded ? (
          <ChevronDown size={14} className="text-text-3" />
        ) : (
          <ChevronRight size={14} className="text-text-3" />
        )}
      </div>

      <span
        className={`min-w-0 flex-1 truncate text-[13px] ${
          gitInfo
            ? getStatusColorForFile(gitInfo.status, gitInfo.staged)
            : "text-text-2"
        }`}
      >
        {node.name}
      </span>

      <div className="flex h-4 w-5 flex-shrink-0 items-center justify-center">
        {gitInfo && (
          <div
            className={`h-1.5 w-1.5 rounded-full ${getStatusBgColor(gitInfo.status)}`}
            title={`Contains ${gitInfo.status} files`}
          />
        )}
      </div>
    </div>
  );
}
