/**
 * SourceControlTreeRow Component
 *
 * Renders a single row in the virtualized source control tree.
 * Handles both section headers and file/directory items.
 * Uses TreeRowBase for file items to maintain consistency.
 */
import { useAtomValue } from "jotai";
import {
  Archive,
  Check,
  ChevronDown,
  ChevronRight,
  FileDiff,
  Minus,
  Plus,
  Undo2,
} from "lucide-react";
import React, { memo, useCallback, useMemo, useRef, useState } from "react";

import { useActionSystemOptional } from "@src/ActionSystem";
import {
  GitStatusBadge,
  TREE_INDENT_PX,
  TREE_PADDING_X,
  TreeRowAction,
  TreeRowBase,
} from "@src/components/TreeRow";
import type { GitStatusInfo, TreeRowNode } from "@src/components/TreeRow";
import { type NativeDragItem, useNativeDrag } from "@src/hooks/files";
import {
  COUNT_BADGE,
  HEADER_BUTTON,
  PRIMARY_SIDEBAR_HOVER,
  getCountBadgeSizeClass,
} from "@src/modules/WorkStation/shared/tokens";
import { activeWorkspaceRootPathAtom } from "@src/store/workspace";
import type { GitFile } from "@src/types/git/types";

import { SHORTCUTS } from "../../../hooks/useSourceControlShortcuts";
import { GIT_LABELS } from "../config";
import type { SourceControlNode } from "../utils/virtualizedTreeUtils";
import type { GitFileTreeNode } from "./GitFileTreeItem";
import SourceControlContextMenu from "./SourceControlContextMenu";

// ============================================
// Helpers
// ============================================

function collectGitFiles(node: GitFileTreeNode | undefined): GitFile[] {
  if (!node) return [];
  if (node.type === "file" && node.file) return [node.file];
  return node.children?.flatMap(collectGitFiles) ?? [];
}

// ============================================
// Types
// ============================================

export interface SourceControlTreeRowProps {
  node: SourceControlNode;
  depth: number;
  isSelected?: boolean;
  isMultiSelected?: boolean;
  hasMultipleSelected?: boolean;
  // Section actions
  onSectionToggle?: (section: string) => void;
  onStageAll?: () => Promise<void>;
  onUnstageAll?: () => Promise<void>;
  onDiscardAll?: () => Promise<void>;
  onOpenStagedChanges?: () => void;
  onStashPush?: () => void;
  hasChangesToStash?: boolean;
  stashOperationLoading?: boolean;
  // File actions
  onSelect?: (fileId: string, event?: React.MouseEvent) => void;
  onStageToggle?: (fileId: string, stage: boolean) => Promise<void>;
  onDiscard?: (fileId: string) => Promise<void>;
  onDiscardFiles?: (fileIds: string[]) => Promise<void>;
  onToggleDirectory?: (path: string) => void;
  onStageResolved?: (fileId: string) => Promise<void>;
  /** Show parent path hint after filename (flat list mode) */
  showPathHint?: boolean;
  /** Override repo path for multi-root workspaces. */
  overrideRepoPath?: string;
}

// ============================================
// Section Header Component
// ============================================

interface SectionHeaderRowProps {
  node: SourceControlNode;
  depth: number;
  onSectionToggle?: (section: string) => void;
  onStageAll?: () => Promise<void>;
  onUnstageAll?: () => Promise<void>;
  onDiscardAll?: () => Promise<void>;
  onOpenStagedChanges?: () => void;
  onStashPush?: () => void;
  hasChangesToStash?: boolean;
  stashOperationLoading?: boolean;
}

const SectionHeaderRow: React.FC<SectionHeaderRowProps> = memo(
  ({
    node,
    depth,
    onSectionToggle,
    onStageAll,
    onUnstageAll,
    onDiscardAll,
    onOpenStagedChanges,
    onStashPush,
    hasChangesToStash,
    stashOperationLoading,
  }) => {
    const isWarning = node.variant === "warning";
    const sectionCount = node.count ?? 0;
    const countBadgeVariant = isWarning
      ? COUNT_BADGE.danger
      : sectionCount === 0
        ? COUNT_BADGE.muted
        : COUNT_BADGE.primary;
    const paddingLeft = depth * TREE_INDENT_PX + TREE_PADDING_X;

    const handleToggle = useCallback(() => {
      if (onSectionToggle && node.section) {
        onSectionToggle(node.section);
      }
    }, [onSectionToggle, node.section]);

    // Section-specific actions
    let actions: React.ReactNode = null;

    if (node.section === "unstaged") {
      actions = (
        <>
          <button
            className={`group/discard ${HEADER_BUTTON.danger} opacity-0 group-hover/header:opacity-100`}
            onClick={(event) => {
              event.stopPropagation();
              onDiscardAll?.();
            }}
            title={GIT_LABELS.discardAllChanges}
          >
            <Undo2 size={14} strokeWidth={1.75} />
          </button>
          {onStashPush && hasChangesToStash && (
            <button
              className={`${HEADER_BUTTON.actionTreeRow} hidden flex-shrink-0 disabled:opacity-50 group-hover/header:flex`}
              onClick={(event) => {
                event.stopPropagation();
                onStashPush();
              }}
              disabled={stashOperationLoading}
              title={GIT_LABELS.stashAllChanges}
            >
              <Archive size={14} strokeWidth={1.75} />
            </button>
          )}
          <button
            className={`${HEADER_BUTTON.actionTreeRow} hidden flex-shrink-0 group-hover/header:flex`}
            onClick={(event) => {
              event.stopPropagation();
              onStageAll?.();
            }}
            title={GIT_LABELS.stageChanges}
          >
            <Plus size={14} strokeWidth={1.75} />
          </button>
        </>
      );
    } else if (node.section === "staged") {
      actions = (
        <>
          <button
            className={`${HEADER_BUTTON.actionTreeRow} opacity-0 group-hover/header:opacity-100`}
            onClick={(event) => {
              event.stopPropagation();
              onUnstageAll?.();
            }}
            title={`Unstage All Changes\n\nShortcut: ${SHORTCUTS.unstageAll}`}
          >
            <Minus size={14} strokeWidth={1.75} />
          </button>
          <button
            className={`${HEADER_BUTTON.actionTreeRow} opacity-0 group-hover/header:opacity-100`}
            onClick={(event) => {
              event.stopPropagation();
              onOpenStagedChanges?.();
            }}
            title={GIT_LABELS.openStagedChanges}
          >
            <FileDiff size={14} strokeWidth={1.75} />
          </button>
        </>
      );
    }

    return (
      <div
        className={`group/header flex h-[28px] w-full cursor-pointer items-center gap-1.5 ${PRIMARY_SIDEBAR_HOVER.row}`}
        style={{ paddingLeft: `${paddingLeft}px`, paddingRight: "12px" }}
        onClick={handleToggle}
      >
        {/* Chevron */}
        {node.expanded ? (
          <ChevronDown size={14} className="text-text-3" />
        ) : (
          <ChevronRight size={14} className="text-text-3" />
        )}

        {/* Title */}
        <span className="relative min-w-0 truncate text-[11px] font-medium uppercase text-text-2">
          {node.name}
          {/* Loading indicator */}
          {node.loading && (
            <span className="absolute -bottom-0.5 left-0 h-[2px] w-full overflow-hidden rounded-full bg-fill-3">
              <span className="absolute h-full w-1/3 animate-progress-slide rounded-full bg-primary-6" />
            </span>
          )}
        </span>

        <div className="flex-1" />

        {/* Action buttons */}
        {actions}

        {/* Count badge */}
        <span
          className={`${COUNT_BADGE.base} ${getCountBadgeSizeClass(sectionCount)} ${countBadgeVariant}`}
        >
          {sectionCount}
        </span>
      </div>
    );
  }
);

SectionHeaderRow.displayName = "SectionHeaderRow";

// ============================================
// File/Directory Row Component
// ============================================

interface FileDirectoryRowProps {
  node: SourceControlNode;
  depth: number;
  isSelected?: boolean;
  isMultiSelected?: boolean;
  hasMultipleSelected?: boolean;
  onSelect?: (fileId: string, event?: React.MouseEvent) => void;
  onStageToggle?: (fileId: string, stage: boolean) => Promise<void>;
  onDiscard?: (fileId: string) => Promise<void>;
  onDiscardFiles?: (fileIds: string[]) => Promise<void>;
  onToggleDirectory?: (path: string) => void;
  onStageResolved?: (fileId: string) => Promise<void>;
  showPathHint?: boolean;
  overrideRepoPath?: string;
}

const FileDirectoryRow: React.FC<FileDirectoryRowProps> = memo(
  ({
    node,
    depth,
    isSelected = false,
    isMultiSelected = false,
    hasMultipleSelected = false,
    onSelect,
    onStageToggle,
    onDiscard,
    onDiscardFiles,
    onToggleDirectory,
    onStageResolved,
    showPathHint = false,
    overrideRepoPath,
  }) => {
    const isDirectory = node.nodeType === "directory";
    const isConflictFile = node.section === "merge";
    const isStaged = node.file?.staged ?? false;
    const rowRef = useRef<HTMLDivElement>(null);
    const activeWorkspaceRootPath = useAtomValue(activeWorkspaceRootPathAtom);
    const actionSystem = useActionSystemOptional();
    const [showContextMenu, setShowContextMenu] = useState(false);

    const effectiveRepoPath = overrideRepoPath ?? activeWorkspaceRootPath;

    // Build absolute path for drag operations
    const absolutePath = useMemo(() => {
      const relativePath = node.file?.path ?? node.treeNode?.path ?? node.path;
      if (!effectiveRepoPath) return relativePath;
      if (relativePath.startsWith("/")) return relativePath;
      return `${effectiveRepoPath}/${relativePath}`;
    }, [node.file?.path, node.treeNode?.path, node.path, effectiveRepoPath]);

    const contextMenuFiles = useMemo(
      () => (isDirectory ? collectGitFiles(node.treeNode) : []),
      [isDirectory, node.treeNode]
    );
    const contextMenuFile = node.file ?? contextMenuFiles[0];

    // Native OS drag-out via tauri-plugin-drag
    const { handleMouseDown: nativeDragMouseDown } = useNativeDrag(rowRef);

    const dragItem: NativeDragItem = useMemo(
      () => ({
        path: absolutePath,
        name: node.name,
        type: isDirectory ? "directory" : "file",
      }),
      [absolutePath, node.name, isDirectory]
    );

    const handleMouseDown = useCallback(
      (event: React.MouseEvent<HTMLDivElement>) => {
        nativeDragMouseDown(event, dragItem);
      },
      [nativeDragMouseDown, dragItem]
    );

    // Convert to TreeRowNode format
    const treeRowNode: TreeRowNode = useMemo(
      () => ({
        id: node.path,
        name: node.name,
        path: node.treeNode?.path ?? node.file?.path ?? node.path,
        type: isDirectory ? "directory" : "file",
        expanded: node.expanded,
      }),
      [
        node.path,
        node.name,
        node.treeNode?.path,
        node.file?.path,
        node.expanded,
        isDirectory,
      ]
    );

    // Git status info
    const gitStatus: GitStatusInfo | null = useMemo(() => {
      if (isDirectory && node.treeNode?.aggregateStatus) {
        return { status: node.treeNode.aggregateStatus, staged: false };
      }
      if (node.file) {
        return { status: node.file.status, staged: node.file.staged };
      }
      return null;
    }, [isDirectory, node.treeNode, node.file]);

    const handleClick = useCallback(
      (event: React.MouseEvent) => {
        // Don't trigger if clicking on action button
        const target = event.target as HTMLElement;
        if (target.closest(".action-btn")) {
          return;
        }

        if (isDirectory) {
          onToggleDirectory?.(node.treeNode?.path ?? node.path);
        } else if (node.file) {
          onSelect?.(node.file.id, event);
        }
      },
      [
        isDirectory,
        node.treeNode?.path,
        node.path,
        node.file,
        onSelect,
        onToggleDirectory,
      ]
    );

    const handleStageToggle = useCallback(
      (event: React.MouseEvent) => {
        event.stopPropagation();
        if (node.file && onStageToggle) {
          onStageToggle(node.file.id, !isStaged);
        }
      },
      [node.file, onStageToggle, isStaged]
    );

    const handleStageResolved = useCallback(
      (event: React.MouseEvent) => {
        event.stopPropagation();
        if (node.file && onStageResolved) {
          onStageResolved(node.file.id);
        }
      },
      [node.file, onStageResolved]
    );

    const handleDiscard = useCallback(
      (event: React.MouseEvent) => {
        event.stopPropagation();
        if (node.file && onDiscard) {
          onDiscard(node.file.id);
        }
      },
      [node.file, onDiscard]
    );

    // Context menu handler
    const handleContextMenu = useCallback(
      (event: React.MouseEvent) => {
        if (!contextMenuFile) return;
        event.preventDefault();
        event.stopPropagation();
        // Force remount: reset to false first so React unmounts the menu,
        // then set true on next tick to remount with fresh state
        setShowContextMenu(false);
        requestAnimationFrame(() => setShowContextMenu(true));
      },
      [contextMenuFile]
    );

    const handleContextMenuClose = useCallback(() => {
      setShowContextMenu(false);
    }, []);

    // Only round when not in multi-selection mode
    const shouldRound = !hasMultipleSelected;

    return (
      <>
        <TreeRowBase
          ref={rowRef}
          node={treeRowNode}
          depth={depth}
          isSelected={isSelected}
          isMultiSelected={isMultiSelected}
          gitStatus={null}
          onClick={handleClick}
          onContextMenu={handleContextMenu}
          rounded={shouldRound}
          onMouseDown={handleMouseDown}
          showPathHint={showPathHint}
        >
          {/* Action buttons for files (shown on hover) */}
          {!isDirectory && node.file && (
            <>
              {/* Discard action button */}
              {onDiscard && (
                <TreeRowAction
                  icon={Undo2}
                  variant="danger"
                  onClick={handleDiscard}
                  title={GIT_LABELS.discardChanges}
                />
              )}
              {/* Stage/Unstage/Resolve action button */}
              {(onStageToggle || (isConflictFile && onStageResolved)) && (
                <TreeRowAction
                  icon={isConflictFile ? Check : isStaged ? Minus : Plus}
                  variant={isConflictFile ? "success" : "default"}
                  onClick={
                    isConflictFile ? handleStageResolved : handleStageToggle
                  }
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
        {showContextMenu && contextMenuFile && actionSystem?.dispatch && (
          <SourceControlContextMenu
            file={contextMenuFile}
            files={isDirectory ? contextMenuFiles : undefined}
            targetPath={isDirectory ? node.treeNode?.path : undefined}
            repoPath={effectiveRepoPath ?? ""}
            isConflictFile={isConflictFile}
            isDirectory={isDirectory}
            dispatch={actionSystem.dispatch}
            onSelect={
              onSelect ? (fileId: string) => onSelect(fileId) : undefined
            }
            onStageToggle={onStageToggle}
            onDiscard={onDiscard}
            onDiscardFiles={onDiscardFiles}
            onStageResolved={onStageResolved}
            onClose={handleContextMenuClose}
          />
        )}
      </>
    );
  }
);

FileDirectoryRow.displayName = "FileDirectoryRow";

// ============================================
// Main Component
// ============================================

export const SourceControlTreeRow: React.FC<SourceControlTreeRowProps> = memo(
  (props) => {
    const { node } = props;

    // Route to appropriate sub-component based on node type
    if (node.nodeType === "section-header") {
      return (
        <SectionHeaderRow
          node={node}
          depth={props.depth}
          onSectionToggle={props.onSectionToggle}
          onStageAll={props.onStageAll}
          onUnstageAll={props.onUnstageAll}
          onDiscardAll={props.onDiscardAll}
          onOpenStagedChanges={props.onOpenStagedChanges}
          onStashPush={props.onStashPush}
          hasChangesToStash={props.hasChangesToStash}
          stashOperationLoading={props.stashOperationLoading}
        />
      );
    }

    return (
      <FileDirectoryRow
        node={node}
        depth={props.depth}
        isSelected={props.isSelected}
        isMultiSelected={props.isMultiSelected}
        hasMultipleSelected={props.hasMultipleSelected}
        onSelect={props.onSelect}
        onStageToggle={props.onStageToggle}
        onDiscard={props.onDiscard}
        onToggleDirectory={props.onToggleDirectory}
        onStageResolved={props.onStageResolved}
        showPathHint={props.showPathHint}
        overrideRepoPath={props.overrideRepoPath}
      />
    );
  }
);

SourceControlTreeRow.displayName = "SourceControlTreeRow";

export default SourceControlTreeRow;
