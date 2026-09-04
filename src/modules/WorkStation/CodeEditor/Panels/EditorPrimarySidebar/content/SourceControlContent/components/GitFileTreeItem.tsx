/**
 * Git File Tree Item Component
 *
 * Displays git files in a tree structure grouped by directory.
 * Folders use status dots; files use status letters.
 * Shows stage/unstage action on hover.
 *
 * Uses shared TreeRow components for base rendering.
 */
import React, { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import {
  GitStatusBadge,
  TreeRowAction,
  TreeRowBase,
} from "@src/components/TreeRow";
import type { GitStatusInfo, TreeRowNode } from "@src/components/TreeRow";
import { Add01Icon, MinusSignIcon, Tick01Icon, Undo02Icon } from "@src/icons";
import type { GitFile } from "@src/types/git/types";

export interface GitFileTreeNode {
  type: "file" | "directory";
  name: string;
  path: string;
  file?: GitFile;
  children?: GitFileTreeNode[];
  expanded?: boolean;
  /** Aggregate status for folders (highest priority status of children) */
  aggregateStatus?: GitFile["status"];
}

export interface GitFileTreeItemProps {
  node: GitFileTreeNode;
  depth: number;
  selectedFileId: string;
  /** Whether file is multi-selected (Cmd+Click selection) */
  isMultiSelected?: boolean;
  /** Whether multiple files are selected (for styling - no rounding when >1) */
  hasMultipleSelected?: boolean;
  onSelect: (fileId: string, event: React.MouseEvent) => void;
  /** Called when stage/unstage is clicked. If staged, this unstages; if unstaged, this stages */
  onStageToggle?: (fileId: string, stage: boolean) => Promise<void> | void;
  /** Called when discard is clicked */
  onDiscard?: (fileId: string) => Promise<void> | void;
  onToggleDirectory: (path: string) => void;
  /** Whether this is a conflict file (shows different action button) */
  isConflictFile?: boolean;
}

const GitFileTreeItem: React.FC<GitFileTreeItemProps> = React.memo(
  ({
    node,
    depth,
    selectedFileId,
    isMultiSelected = false,
    hasMultipleSelected = false,
    onSelect,
    onStageToggle,
    onDiscard,
    onToggleDirectory,
    isConflictFile = false,
  }) => {
    const { t } = useTranslation();
    const isDirectory = node.type === "directory";
    const isFile = node.type === "file";
    const isSelected = isFile && node.file && node.file.id === selectedFileId;
    const isStaged = node.file?.staged ?? false;

    // Convert to TreeRowNode format
    const treeRowNode: TreeRowNode = useMemo(
      () => ({
        id: node.path,
        name: node.name,
        path: node.path,
        type: node.type,
        expanded: node.expanded ?? true,
      }),
      [node.path, node.name, node.type, node.expanded]
    );

    // Convert to GitStatusInfo format
    const gitStatus: GitStatusInfo | null = useMemo(() => {
      if (isDirectory && node.aggregateStatus) {
        return { status: node.aggregateStatus, staged: false };
      }
      if (isFile && node.file) {
        return { status: node.file.status, staged: node.file.staged };
      }
      return null;
    }, [isDirectory, isFile, node.aggregateStatus, node.file]);

    const handleClick = useCallback(
      (event: React.MouseEvent) => {
        // Don't trigger if clicking on action button
        const target = event.target as HTMLElement;
        if (target.closest(".action-btn")) {
          return;
        }

        if (isDirectory) {
          onToggleDirectory(node.path);
        } else if (isFile && node.file) {
          onSelect(node.file.id, event);
        }
      },
      [isDirectory, isFile, node.path, node.file, onSelect, onToggleDirectory]
    );

    const handleStageToggle = useCallback(
      (event: React.MouseEvent) => {
        event.stopPropagation();
        if (isFile && node.file && onStageToggle) {
          // If currently staged, unstage (pass false); if unstaged, stage (pass true)
          onStageToggle(node.file.id, !isStaged);
        }
      },
      [isFile, node.file, onStageToggle, isStaged]
    );

    const handleDiscard = useCallback(
      (event: React.MouseEvent) => {
        event.stopPropagation();
        if (isFile && node.file && onDiscard) {
          onDiscard(node.file.id);
        }
      },
      [isFile, node.file, onDiscard]
    );

    // Only round when not in multi-selection mode (1 or fewer selected)
    const shouldRound = !hasMultipleSelected;

    return (
      <TreeRowBase
        node={treeRowNode}
        depth={depth}
        isSelected={isSelected ?? false}
        isMultiSelected={isMultiSelected}
        gitStatus={null}
        onClick={handleClick}
        rounded={shouldRound}
      >
        {/* Action buttons for files (shown on hover) */}
        {isFile && node.file && (
          <>
            {/* Discard action button */}
            {onDiscard && (
              <TreeRowAction
                icon={Undo02Icon}
                variant="danger"
                onClick={handleDiscard}
                title={t("workstation.discardChanges")}
              />
            )}
            {/* Stage/Unstage action button */}
            {onStageToggle && (
              <TreeRowAction
                icon={
                  isConflictFile
                    ? Tick01Icon
                    : isStaged
                      ? MinusSignIcon
                      : Add01Icon
                }
                variant={isConflictFile ? "success" : "default"}
                onClick={handleStageToggle}
                title={
                  isConflictFile
                    ? "Mark as Resolved (Stage)"
                    : isStaged
                      ? "Unstage Changes"
                      : "Stage Changes"
                }
              />
            )}
          </>
        )}
        {/* Git status badge */}
        <GitStatusBadge status={gitStatus} isDirectory={isDirectory} />
      </TreeRowBase>
    );
  },
  // Custom comparison to prevent unnecessary re-renders
  (prevProps, nextProps) => {
    const prevFile = prevProps.node.file;
    const nextFile = nextProps.node.file;

    return (
      prevProps.node.path === nextProps.node.path &&
      prevProps.node.expanded === nextProps.node.expanded &&
      prevProps.node.aggregateStatus === nextProps.node.aggregateStatus &&
      prevProps.depth === nextProps.depth &&
      prevProps.selectedFileId === nextProps.selectedFileId &&
      prevProps.isMultiSelected === nextProps.isMultiSelected &&
      prevProps.hasMultipleSelected === nextProps.hasMultipleSelected &&
      prevProps.isConflictFile === nextProps.isConflictFile &&
      prevFile?.id === nextFile?.id &&
      prevFile?.staged === nextFile?.staged &&
      prevFile?.status === nextFile?.status
    );
  }
);

GitFileTreeItem.displayName = "GitFileTreeItem";

export default GitFileTreeItem;
