import { ChevronDown, ChevronRight, GitBranch } from "lucide-react";
import React, { memo } from "react";

import { FOLDER_HEADER } from "@src/config/workstation/tokens";

export interface FolderHeaderRowProps {
  name: string;
  expanded: boolean;
  onToggle: () => void;
  branchName?: string;
  badgeCount?: number;
  className?: string;
  onContextMenu?: (event: React.MouseEvent) => void;
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
          <ChevronDown size={14} className="flex-shrink-0 text-text-3" />
        ) : (
          <ChevronRight size={14} className="flex-shrink-0 text-text-3" />
        )}
        <span className={FOLDER_HEADER.name}>{name}</span>
        {branchName && (
          <>
            <GitBranch size={11} className="flex-shrink-0 text-text-3" />
            <span className={FOLDER_HEADER.branch}>{branchName}</span>
          </>
        )}
        {badgeCount != null && badgeCount > 0 && (
          <span className="bg-accent-7 ml-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-medium text-white">
            {badgeCount}
          </span>
        )}
      </button>
      {actions && <div className={FOLDER_HEADER.actions}>{actions}</div>}
    </div>
  )
);

FolderHeaderRow.displayName = "FolderHeaderRow";
