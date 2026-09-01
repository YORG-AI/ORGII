/**
 * ChangesSection Component
 *
 * Displays unstaged files with stage, discard, stash, and diff actions
 */
import React, { memo } from "react";

import { Add01Icon, ArchiveIcon, HugeiconsIcon, Undo02Icon } from "@src/icons";
import { HEADER_BUTTON } from "@src/modules/WorkStation/shared/tokens";
import type { GitFile } from "@src/types/git/types";

import { GIT_LABELS } from "../config";
import GitFileListItem from "./GitFileListItem";
import GitFileTreeItem from "./GitFileTreeItem";
import type { GitFileTreeNode } from "./GitFileTreeItem";
import SectionHeader from "./SectionHeader";

export interface ChangesSectionProps {
  unstagedFiles: GitFile[];
  flattenedUnstaged: Array<{ node: GitFileTreeNode; depth: number }>;
  isCollapsed: boolean;
  onToggle: () => void;
  viewMode: "list-tree" | "list";
  selectedFileId: string;
  selectedFileIds: Set<string>;
  isFileSelected: (fileId: string) => boolean;
  onSelect: (fileId: string, event?: React.MouseEvent) => void;
  onStageToggle: (fileId: string, stage: boolean) => Promise<void>;
  onDiscard: (fileId: string) => Promise<void>;
  onToggleDirectory: (path: string) => void;
  onStageAll?: () => Promise<void>;
  onDiscardAll?: () => Promise<void>;
  // Stash
  hasChangesToStash?: boolean;
  stashOperationLoading?: boolean;
  onStashPush?: (
    message?: string,
    includeUntracked?: boolean
  ) => Promise<boolean>;
  // Loading states
  loading?: boolean;
  commitLoading?: boolean;
  syncLoading?: boolean;
  publishLoading?: boolean;
}

export const ChangesSection: React.FC<ChangesSectionProps> = memo(
  ({
    unstagedFiles,
    flattenedUnstaged,
    isCollapsed,
    onToggle,
    viewMode,
    selectedFileId,
    selectedFileIds,
    isFileSelected,
    onSelect,
    onStageToggle,
    onDiscard,
    onToggleDirectory,
    onStageAll,
    onDiscardAll,
    hasChangesToStash = false,
    stashOperationLoading = false,
    onStashPush,
    loading = false,
    commitLoading = false,
    syncLoading = false,
    publishLoading = false,
  }) => {
    if (unstagedFiles.length === 0) {
      return null;
    }

    const _showLoading =
      loading ||
      commitLoading ||
      syncLoading ||
      publishLoading ||
      stashOperationLoading;

    return (
      <div className="mb-1">
        <SectionHeader
          title={GIT_LABELS.changes}
          count={unstagedFiles.length}
          isCollapsed={isCollapsed}
          onToggle={onToggle}
          actions={
            <>
              <button
                className={`group/discard ${HEADER_BUTTON.danger} opacity-0 group-hover/header:opacity-100`}
                onClick={onDiscardAll}
                title={GIT_LABELS.discardAllChanges}
              >
                <HugeiconsIcon
                  icon={Undo02Icon}
                  data-icon="undo-2"
                  size={14}
                  strokeWidth={1.75}
                />
              </button>
              {onStashPush && hasChangesToStash && (
                <button
                  className={`${HEADER_BUTTON.actionTreeRow} hidden shrink-0 group-hover/header:flex disabled:opacity-50`}
                  onClick={() => onStashPush()}
                  disabled={stashOperationLoading}
                  title={GIT_LABELS.stashAllChanges}
                >
                  <HugeiconsIcon
                    icon={ArchiveIcon}
                    data-icon="archive"
                    size={14}
                    strokeWidth={1.75}
                  />
                </button>
              )}
              <button
                className={`${HEADER_BUTTON.actionTreeRow} hidden shrink-0 group-hover/header:flex`}
                onClick={onStageAll}
                title={GIT_LABELS.stageChanges}
              >
                <HugeiconsIcon
                  icon={Add01Icon}
                  data-icon="plus"
                  size={14}
                  strokeWidth={1.75}
                />
              </button>
            </>
          }
        />

        {/* Unstaged files list */}
        {!isCollapsed && (
          <div>
            {viewMode === "list-tree" &&
              flattenedUnstaged.map(({ node, depth }) => (
                <GitFileTreeItem
                  key={`unstaged-${node.path}`}
                  node={node}
                  depth={depth}
                  selectedFileId={selectedFileId}
                  isMultiSelected={
                    node.file ? isFileSelected(node.file.id) : false
                  }
                  hasMultipleSelected={selectedFileIds.size > 1}
                  onSelect={onSelect}
                  onStageToggle={onStageToggle}
                  onDiscard={onDiscard}
                  onToggleDirectory={onToggleDirectory}
                />
              ))}
            {viewMode === "list" &&
              unstagedFiles.map((file) => (
                <GitFileListItem
                  key={`unstaged-${file.id}`}
                  file={file}
                  isSelected={file.id === selectedFileId}
                  isMultiSelected={isFileSelected(file.id)}
                  hasMultipleSelected={selectedFileIds.size > 1}
                  onSelect={onSelect}
                  onStageToggle={onStageToggle}
                  onDiscard={onDiscard}
                />
              ))}
          </div>
        )}
      </div>
    );
  }
);

ChangesSection.displayName = "ChangesSection";

export default ChangesSection;
