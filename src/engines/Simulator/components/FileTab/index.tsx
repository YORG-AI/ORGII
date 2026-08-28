/**
 * FileTab Component
 *
 * IDE-style file tab with 40px height.
 * Shows file icon + path (directory grayed, filename bold).
 * Used in file/code viewers.
 */
import React, { memo } from "react";

import FileTypeIcon from "@src/components/FileTypeIcon";
import { SURFACE_TOKENS } from "@src/config/surfaceTokens";
import { Cancel01Icon, HugeiconsIcon } from "@src/icons";

// ============================================
// Types
// ============================================

export interface FileTabProps {
  /** Full file path */
  filePath: string;
  /** Whether this tab is active */
  isActive?: boolean;
  /** Show close button */
  showClose?: boolean;
  /** Close callback */
  onClose?: () => void;
  /** Click callback */
  onClick?: () => void;
  /** Optional className */
  className?: string;
}

// ============================================
// Helpers
// ============================================

/** Parse file path into directory and filename */
function parsePath(path: string): { directory: string; fileName: string } {
  const lastSlashIndex = path.lastIndexOf("/");

  if (lastSlashIndex === -1) {
    return { directory: "", fileName: path };
  }

  return {
    directory: path.substring(0, lastSlashIndex + 1),
    fileName: path.substring(lastSlashIndex + 1),
  };
}

// ============================================
// Component
// ============================================

const FileTab: React.FC<FileTabProps> = memo(
  ({
    filePath,
    isActive = true,
    showClose = false,
    onClose,
    onClick,
    className = "",
  }) => {
    const { directory, fileName } = parsePath(filePath);

    return (
      <div
        className={`flex h-10 shrink-0 items-center gap-2 overflow-hidden border-b border-border-2 px-3 ${
          isActive
            ? SURFACE_TOKENS.surface
            : `${SURFACE_TOKENS.surface} ${SURFACE_TOKENS.hover}`
        } ${onClick ? "cursor-pointer" : ""} ${className}`}
        onClick={onClick}
        title={filePath}
      >
        {/* File icon */}
        <FileTypeIcon fileName={fileName} size="medium" className="shrink-0" />

        {/* Path: directory (grayed, truncatable) + filename (bold, always visible) */}
        <div className="flex min-w-0 flex-1 items-baseline overflow-hidden text-[13px]">
          {directory && (
            <span className="shrink truncate text-text-3">{directory}</span>
          )}
          <span
            className={`shrink-0 truncate font-medium ${isActive ? "text-text-1" : "text-text-2"}`}
          >
            {fileName}
          </span>
        </div>

        {/* Close button */}
        {showClose && onClose && (
          <button
            onClick={(event) => {
              event.stopPropagation();
              onClose();
            }}
            className={`flex h-5 w-5 shrink-0 items-center justify-center rounded ${SURFACE_TOKENS.iconButtonHover}`}
          >
            <HugeiconsIcon
              icon={Cancel01Icon}
              data-icon="x"
              size={14}
              className="text-text-3"
            />
          </button>
        )}
      </div>
    );
  }
);

FileTab.displayName = "FileTab";

export default FileTab;
