/**
 * FolderHeaderRow
 *
 * Shared collapsible header row for workspace folder / worktree sections.
 * Renders: chevron + name + optional branch icon & name + optional badge.
 * Uses FOLDER_HEADER tokens for consistent styling across explorer and
 * source control panels.
 */
import React, { memo } from "react";

import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  HugeiconsIcon,
  WorkflowCircle05Icon,
} from "@src/icons";

import { FOLDER_HEADER } from "./tokens";

export interface FolderHeaderRowProps {
  /** Display name (folder name / repo name) */
  name: string;
  /** Whether the section is expanded */
  expanded: boolean;
  /** Toggle expand/collapse */
  onToggle: () => void;
  /** Git branch name (shown after name with branch icon) */
  branchName?: string;
  /** Optional trailing badge count */
  badgeCount?: number;
  /** Additional className on the outer row div */
  className?: string;
  /** Context menu handler */
  onContextMenu?: (event: React.MouseEvent) => void;
  /** Optional trailing actions rendered on the right edge */
  actions?: React.ReactNode;
}

export const FolderHeaderRow: React.FC<FolderHeaderRowProps> = memo(
  ({
    name,
    expanded,
    onToggle,
    branchName,
    badgeCount,
    className,
    onContextMenu,
    actions,
  }) => (
    <div
      className={`${FOLDER_HEADER.row}${className ? ` ${className}` : ""}`}
      onContextMenu={onContextMenu}
    >
      <button type="button" className={FOLDER_HEADER.button} onClick={onToggle}>
        {expanded ? (
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            data-icon="chevron-down"
            size={14}
            className="flex-shrink-0 text-text-3"
          />
        ) : (
          <HugeiconsIcon
            icon={ArrowRight01Icon}
            data-icon="chevron-right"
            size={14}
            className="flex-shrink-0 text-text-3"
          />
        )}
        <span className={FOLDER_HEADER.name}>{name}</span>
        {branchName && (
          <>
            <HugeiconsIcon
              icon={WorkflowCircle05Icon}
              data-icon="git-branch"
              size={11}
              className="flex-shrink-0 text-text-3"
            />
            <span className={FOLDER_HEADER.branch}>{branchName}</span>
          </>
        )}
        {badgeCount != null && badgeCount > 0 && (
          <span className="bg-accent-7 ml-1 inline-flex h-[16px] min-w-[16px] items-center justify-center rounded-full px-1 text-[10px] font-medium text-white">
            {badgeCount}
          </span>
        )}
      </button>
      {actions && <div className={FOLDER_HEADER.actions}>{actions}</div>}
    </div>
  )
);

FolderHeaderRow.displayName = "FolderHeaderRow";
