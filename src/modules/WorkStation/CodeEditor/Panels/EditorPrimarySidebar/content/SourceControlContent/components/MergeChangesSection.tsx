/**
 * MergeChangesSection Component
 *
 * Displays merge conflict files with warning styling
 */
import React, { memo } from "react";
import { useTranslation } from "react-i18next";

import { Alert01Icon, HugeiconsIcon, Tick01Icon } from "@src/icons";
import { HEADER_BUTTON } from "@src/modules/WorkStation/shared/tokens";
import type { GitFile } from "@src/types/git/types";

import { GIT_LABELS } from "../config";
import GitFileListItem from "./GitFileListItem";
import GitFileTreeItem from "./GitFileTreeItem";
import type { GitFileTreeNode } from "./GitFileTreeItem";
import SectionHeader from "./SectionHeader";

export interface MergeChangesSectionProps {
  conflictFiles: GitFile[];
  flattenedConflicts: Array<{ node: GitFileTreeNode; depth: number }>;
  isCollapsed: boolean;
  onToggle: () => void;
  viewMode: "list-tree" | "list";
  selectedFileId: string;
  selectedFileIds: Set<string>;
  isFileSelected: (fileId: string) => boolean;
  onSelect: (fileId: string, event?: React.MouseEvent) => void;
  onStageResolved?: (fileId: string) => Promise<void>;
  onDiscard: (fileId: string) => Promise<void>;
  onToggleDirectory: (path: string) => void;
}

export const MergeChangesSection: React.FC<MergeChangesSectionProps> = memo(
  ({
    conflictFiles,
    flattenedConflicts,
    isCollapsed,
    onToggle,
    viewMode,
    selectedFileId,
    selectedFileIds,
    isFileSelected,
    onSelect,
    onStageResolved,
    onDiscard,
    onToggleDirectory,
  }) => {
    const { t } = useTranslation();
    if (conflictFiles.length === 0) {
      return null;
    }

    return (
      <div className="mb-1">
        <SectionHeader
          title={GIT_LABELS.mergeChanges}
          count={conflictFiles.length}
          isCollapsed={isCollapsed}
          onToggle={onToggle}
          variant="warning"
          warningCountOnly={true}
          icon={
            <HugeiconsIcon
              icon={Alert01Icon}
              data-icon="alert-triangle"
              size={14}
              className="text-warning-6"
            />
          }
          actions={
            onStageResolved && (
              <button
                className={`${HEADER_BUTTON.success} opacity-0 group-hover/header:opacity-100`}
                onClick={async () => {
                  // Stage all conflict files
                  for (const file of conflictFiles) {
                    await onStageResolved(file.id);
                  }
                }}
                title={t("workstation.acceptAllMergeChanges")}
              >
                <HugeiconsIcon
                  icon={Tick01Icon}
                  data-icon="check"
                  size={14}
                  strokeWidth={1.75}
                  className="text-success-6"
                />
              </button>
            )
          }
        />

        {/* Conflict files list */}
        {!isCollapsed && (
          <div>
            {viewMode === "list-tree" &&
              flattenedConflicts.map(({ node, depth }) => (
                <GitFileTreeItem
                  key={`conflict-${node.path}`}
                  node={node}
                  depth={depth}
                  selectedFileId={selectedFileId}
                  isMultiSelected={
                    node.file ? isFileSelected(node.file.id) : false
                  }
                  hasMultipleSelected={selectedFileIds.size > 1}
                  onSelect={onSelect}
                  onStageToggle={
                    onStageResolved
                      ? async (fileId) => {
                          await onStageResolved(fileId);
                        }
                      : undefined
                  }
                  onDiscard={onDiscard}
                  onToggleDirectory={onToggleDirectory}
                  isConflictFile={true}
                />
              ))}
            {viewMode === "list" &&
              conflictFiles.map((file) => (
                <GitFileListItem
                  key={`conflict-${file.id}`}
                  file={file}
                  isSelected={file.id === selectedFileId}
                  isMultiSelected={isFileSelected(file.id)}
                  hasMultipleSelected={selectedFileIds.size > 1}
                  onSelect={onSelect}
                  onStageToggle={
                    onStageResolved
                      ? async (fileId) => {
                          await onStageResolved(fileId);
                        }
                      : undefined
                  }
                  onDiscard={onDiscard}
                  isConflictFile={true}
                />
              ))}
          </div>
        )}
      </div>
    );
  }
);

MergeChangesSection.displayName = "MergeChangesSection";

export default MergeChangesSection;
