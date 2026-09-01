/**
 * Git File List Item Component
 *
 * Displays a single git file with icon, path, and status badge.
 * Shows stage/unstage action on hover.
 * Used in source control file lists for staging and viewing changes.
 */
import React, { useCallback } from "react";
import { useTranslation } from "react-i18next";

import FileTypeIcon from "@src/components/FileTypeIcon";
import { GitStatusBadge, TreeRowAction } from "@src/components/TreeRow";
import { TREE_PADDING_X } from "@src/components/TreeRow/config";
import { SURFACE_TOKENS } from "@src/config/surfaceTokens";
import { Add01Icon, MinusSignIcon, Tick01Icon, Undo02Icon } from "@src/icons";
import { PRIMARY_SIDEBAR_HOVER } from "@src/modules/WorkStation/shared/tokens";
import type { GitFile } from "@src/types/git/types";

export interface GitFileListItemProps {
  file: GitFile;
  isSelected: boolean;
  /** Whether file is multi-selected (Cmd+Click selection) */
  isMultiSelected?: boolean;
  /** Whether multiple files are selected (for styling - no rounding when >1) */
  hasMultipleSelected?: boolean;
  onSelect: (fileId: string, event: React.MouseEvent) => void;
  /** Called when stage/unstage is clicked */
  onStageToggle?: (fileId: string, stage: boolean) => Promise<void> | void;
  /** Called when discard is clicked */
  onDiscard?: (fileId: string) => Promise<void> | void;
  /** Whether this is a conflict file (shows different action button) */
  isConflictFile?: boolean;
}

const GitFileListItem: React.FC<GitFileListItemProps> = React.memo(
  ({
    file,
    isSelected,
    isMultiSelected = false,
    hasMultipleSelected = false,
    onSelect,
    onStageToggle,
    onDiscard,
    isConflictFile = false,
  }) => {
    const { t } = useTranslation();
    const handleRowClick = useCallback(
      (event: React.MouseEvent) => {
        // Don't trigger if clicking on action button
        const target = event.target as HTMLElement;
        if (!target.closest(".action-btn")) {
          onSelect(file.id, event);
        }
      },
      [file.id, onSelect]
    );

    const handleStageToggle = useCallback(
      (event: React.MouseEvent) => {
        event.stopPropagation();
        if (onStageToggle) {
          // If currently staged, unstage (pass false); if unstaged, stage (pass true)
          onStageToggle(file.id, !file.staged);
        }
      },
      [file.id, file.staged, onStageToggle]
    );

    const handleDiscard = useCallback(
      (event: React.MouseEvent) => {
        event.stopPropagation();
        if (onDiscard) {
          onDiscard(file.id);
        }
      },
      [file.id, onDiscard]
    );

    // Extract filename from path
    const fileName =
      file.path.lastIndexOf("/") === -1
        ? file.path
        : file.path.substring(file.path.lastIndexOf("/") + 1);

    // Only round when not in multi-selection mode (1 or fewer selected)
    const shouldRound = !hasMultipleSelected;

    return (
      <div
        className={`group/item flex h-7 cursor-pointer items-center gap-1.5 transition-colors ${
          isSelected || isMultiSelected
            ? `${SURFACE_TOKENS.selected} ${PRIMARY_SIDEBAR_HOVER.selectedRow}`
            : PRIMARY_SIDEBAR_HOVER.row
        } ${shouldRound ? "rounded-lg" : ""}`}
        style={{ paddingLeft: TREE_PADDING_X, paddingRight: 8 }}
        onClick={handleRowClick}
      >
        <FileTypeIcon fileName={fileName} size="small" className="shrink-0" />
        <span
          className={`flex min-w-0 flex-1 items-center gap-1 truncate text-[13px] ${
            isSelected ? "font-medium text-text-1" : "text-text-2"
          }`}
          title={file.path}
        >
          <span className="min-w-0 flex-1 truncate">{fileName}</span>
        </span>
        {/* Discard action button - show on hover */}
        {onDiscard && (
          <TreeRowAction
            icon={Undo02Icon}
            variant="danger"
            onClick={handleDiscard}
            title={t("workstation.discardChanges")}
          />
        )}
        {/* Stage/Unstage action button - show on hover */}
        {onStageToggle && (
          <TreeRowAction
            icon={
              isConflictFile
                ? Tick01Icon
                : file.staged
                  ? MinusSignIcon
                  : Add01Icon
            }
            variant={isConflictFile ? "success" : "default"}
            onClick={handleStageToggle}
            title={
              isConflictFile
                ? "Mark as Resolved (Stage)"
                : file.staged
                  ? "Unstage Changes"
                  : "Stage Changes"
            }
          />
        )}
        <GitStatusBadge
          status={{ status: file.status, staged: file.staged }}
          isDirectory={false}
        />
      </div>
    );
  },
  // Custom comparison to prevent unnecessary re-renders
  (prevProps, nextProps) => {
    return (
      prevProps.file.id === nextProps.file.id &&
      prevProps.file.staged === nextProps.file.staged &&
      prevProps.file.path === nextProps.file.path &&
      prevProps.file.status === nextProps.file.status &&
      prevProps.file.additions === nextProps.file.additions &&
      prevProps.file.deletions === nextProps.file.deletions &&
      prevProps.isSelected === nextProps.isSelected &&
      prevProps.isMultiSelected === nextProps.isMultiSelected &&
      prevProps.hasMultipleSelected === nextProps.hasMultipleSelected &&
      prevProps.isConflictFile === nextProps.isConflictFile
    );
  }
);

GitFileListItem.displayName = "GitFileListItem";

export default GitFileListItem;
