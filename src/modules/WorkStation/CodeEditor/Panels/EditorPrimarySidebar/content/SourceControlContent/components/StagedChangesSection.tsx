/**
 * StagedChangesSection Component
 *
 * Displays staged files with unstage and diff actions
 */
import React, { memo } from "react";

import { FileDiffIcon, HugeiconsIcon, MinusSignIcon } from "@src/icons";
import { HEADER_BUTTON } from "@src/modules/WorkStation/shared/tokens";
import type { GitFile } from "@src/types/git/types";

import { SHORTCUTS } from "../../../hooks/useSourceControlShortcuts";
import { GIT_LABELS } from "../config";
import GitFileListItem from "./GitFileListItem";
import GitFileTreeItem from "./GitFileTreeItem";
import type { GitFileTreeNode } from "./GitFileTreeItem";
import SectionHeader from "./SectionHeader";

export interface StagedChangesSectionProps {
  stagedFiles: GitFile[];
  flattenedStaged: Array<{ node: GitFileTreeNode; depth: number }>;
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
  onUnstageAll?: () => Promise<void>;
  onOpenStagedChanges?: () => void;
}

export const StagedChangesSection: React.FC<StagedChangesSectionProps> = memo(
  ({
    stagedFiles,
    flattenedStaged,
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
    onUnstageAll,
    onOpenStagedChanges,
  }) => {
    if (stagedFiles.length === 0) {
      return null;
    }

    return (
      <div className="mb-1">
        <SectionHeader
          title={GIT_LABELS.stagedChanges}
          count={stagedFiles.length}
          isCollapsed={isCollapsed}
          onToggle={onToggle}
          actions={
            <>
              <button
                className={`${HEADER_BUTTON.actionTreeRow} opacity-0 group-hover/header:opacity-100`}
                onClick={onUnstageAll}
                title={`Unstage All Changes\n\nShortcut: ${SHORTCUTS.unstageAll}`}
              >
                <HugeiconsIcon
                  icon={MinusSignIcon}
                  data-icon="minus"
                  size={14}
                  strokeWidth={1.75}
                />
              </button>
              <button
                className={`${HEADER_BUTTON.actionTreeRow} opacity-0 group-hover/header:opacity-100`}
                onClick={onOpenStagedChanges}
                title={GIT_LABELS.openStagedChanges}
              >
                <HugeiconsIcon
                  icon={FileDiffIcon}
                  data-icon="file-diff"
                  size={14}
                  strokeWidth={1.75}
                />
              </button>
            </>
          }
        />

        {/* Staged files list */}
        {!isCollapsed && (
          <div>
            {viewMode === "list-tree" &&
              flattenedStaged.map(({ node, depth }) => (
                <GitFileTreeItem
                  key={`staged-${node.path}`}
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
              stagedFiles.map((file) => (
                <GitFileListItem
                  key={`staged-${file.id}`}
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

StagedChangesSection.displayName = "StagedChangesSection";

export default StagedChangesSection;
