/**
 * WorkStation TreeNode Component
 *
 * Renders a single node in the file tree with git status and drag support.
 * Uses Jotai atom for selection state - only selected/deselected nodes re-render.
 *
 * Supports inline rename mode when isRenaming prop is true.
 */
import React, {
  memo,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";

import FileTypeIcon from "@src/components/FileTypeIcon";
import {
  GitStatusBadge,
  type GitStatusInfo,
  TreeRowBase,
  type TreeRowNode,
} from "@src/components/TreeRow";
import {
  CHEVRON_SIZE,
  TREE_INDENT_PX,
  TREE_PADDING_RIGHT,
  TREE_PADDING_X,
  TREE_ROW_INSET_CLASS,
  TREE_ROW_INSET_X,
  TREE_ROW_ROUNDED_CLASS,
} from "@src/components/TreeRow";
import { type NativeDragItem, useNativeDrag } from "@src/hooks/files";
import { ArrowDown01Icon, ArrowRight01Icon, HugeiconsIcon } from "@src/icons";
import { useIsFileSelected } from "@src/store/ui/fileTreeSelectionAtom";

import { InlineRenameInput } from "./InlineRenameInput";
import { GitStatusContext } from "./context";
import type { TreeNodeProps } from "./types";
import { getLookupPath } from "./utils/treeUtils";

const TreeNodeInner: React.FC<TreeNodeProps> = ({
  node,
  depth,
  onSelectNode,
  onToggleDirectory,
  isRenaming = false,
  onRenameConfirm,
  onRenameCancel,
}) => {
  const { statusMap, folderStatusMap, repoPath, isMultiRoot } =
    useContext(GitStatusContext);
  const isDirectory = node.type === "directory";
  const rowRef = useRef<HTMLDivElement>(null);

  const [renameValue, setRenameValue] = useState(node.name);

  const isSelected = useIsFileSelected(node.path, node.name, repoPath);

  const lookupPath = useMemo(
    () => getLookupPath(node.path, repoPath, isMultiRoot),
    [node.path, repoPath, isMultiRoot]
  );

  const gitStatus: GitStatusInfo | null = useMemo(() => {
    if (isDirectory) {
      const status = folderStatusMap.get(lookupPath);
      return status ? { status, staged: false } : null;
    }
    const fileInfo = statusMap.get(lookupPath);
    return fileInfo
      ? { status: fileInfo.status, staged: fileInfo.staged }
      : null;
  }, [isDirectory, lookupPath, statusMap, folderStatusMap]);

  const treeRowNode: TreeRowNode = useMemo(
    () => ({
      id: node.path,
      name: node.name,
      path: node.path,
      type: node.type,
      expanded: node.expanded ?? false,
      ...(node.icon !== undefined ? { icon: node.icon } : {}),
      isSymlink: node.isSymlink,
      isIgnored: node.isIgnored,
    }),
    [
      node.path,
      node.name,
      node.type,
      node.expanded,
      node.icon,
      node.isSymlink,
      node.isIgnored,
    ]
  );

  const handleClick = useCallback(() => {
    onSelectNode(node.path, node);
    if (isDirectory) {
      onToggleDirectory(node.path);
    }
  }, [isDirectory, node, onSelectNode, onToggleDirectory]);

  const { handleMouseDown: nativeDragMouseDown } = useNativeDrag(rowRef);

  const dragItem: NativeDragItem = useMemo(
    () => ({
      path: node.path,
      name: node.name,
      type: node.type as "file" | "directory",
    }),
    [node.path, node.name, node.type]
  );

  const handleMouseDown = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!node.path) return;
      nativeDragMouseDown(event, dragItem);
    },
    [node.path, nativeDragMouseDown, dragItem]
  );

  const handleRenameConfirm = useCallback(
    (newName: string) => {
      onRenameConfirm?.(node.path, newName);
    },
    [node.path, onRenameConfirm]
  );

  const handleRenameCancel = useCallback(() => {
    onRenameCancel?.();
  }, [onRenameCancel]);

  const handleRenameValueChange = useCallback((value: string) => {
    setRenameValue(value);
  }, []);

  if (isRenaming) {
    const paddingLeft =
      depth * TREE_INDENT_PX + TREE_PADDING_X - TREE_ROW_INSET_X;
    const isExpanded = node.expanded ?? false;

    return (
      <div
        ref={rowRef}
        data-tree-path={node.path}
        className={`tree-row-base group/item ${TREE_ROW_INSET_CLASS} flex h-7 shrink-0 items-center gap-1.5 ${TREE_ROW_ROUNDED_CLASS} bg-primary-1`}
        style={{
          paddingLeft: `${paddingLeft}px`,
          paddingRight: `${TREE_PADDING_RIGHT - TREE_ROW_INSET_X}px`,
        }}
      >
        {node.icon ? (
          <span className="flex-shrink-0">{node.icon}</span>
        ) : isDirectory ? (
          <div className="flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center">
            {isExpanded ? (
              <HugeiconsIcon
                icon={ArrowDown01Icon}
                data-icon="chevron-down"
                size={CHEVRON_SIZE}
                className="text-text-3"
              />
            ) : (
              <HugeiconsIcon
                icon={ArrowRight01Icon}
                data-icon="chevron-right"
                size={CHEVRON_SIZE}
                className="text-text-3"
              />
            )}
          </div>
        ) : (
          <FileTypeIcon
            fileName={renameValue || node.name}
            size="small"
            className="flex-shrink-0"
          />
        )}

        <div className="min-w-0 flex-1">
          <InlineRenameInput
            initialName={node.name}
            isDirectory={isDirectory}
            onConfirm={handleRenameConfirm}
            onCancel={handleRenameCancel}
            onValueChange={handleRenameValueChange}
          />
        </div>

        {(repoPath || isMultiRoot) && (
          <GitStatusBadge status={gitStatus} isDirectory={isDirectory} />
        )}
      </div>
    );
  }

  return (
    <TreeRowBase
      ref={rowRef}
      node={treeRowNode}
      depth={depth}
      isSelected={isSelected}
      gitStatus={gitStatus}
      onClick={handleClick}
      dataPath={node.path}
      onMouseDown={handleMouseDown}
    >
      {node.isAgentSelected && (
        <div className="flex h-4 w-4 flex-shrink-0 items-center justify-center">
          <div className="h-[6px] w-[6px] rounded-full bg-primary-6" />
        </div>
      )}
      {node.secondaryText && (
        <span className="ml-auto flex-shrink-0 text-[11px] text-text-4">
          {node.secondaryText}
        </span>
      )}
      {(repoPath || isMultiRoot) && (
        <GitStatusBadge status={gitStatus} isDirectory={isDirectory} />
      )}
    </TreeRowBase>
  );
};

TreeNodeInner.displayName = "TreeNodeInner";

export const TreeNode = memo(TreeNodeInner);
TreeNode.displayName = "TreeNode";
