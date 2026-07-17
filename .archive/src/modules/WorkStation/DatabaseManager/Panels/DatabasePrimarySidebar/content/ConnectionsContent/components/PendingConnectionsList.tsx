/**
 * PendingConnectionsList Component
 *
 * Renders the list of discovered SQLite files that haven't been opened yet.
 * Used in the "Pending Connections" section of the sidebar.
 */
import { Database, Loader2, Plus } from "lucide-react";
import React, { memo, useCallback } from "react";
import { useTranslation } from "react-i18next";

import { TreeRowBase } from "@src/components/TreeRow";
import { SPINNER_TOKENS } from "@src/config/spinnerTokens";
import { HEADER_BUTTON } from "@src/modules/WorkStation/shared/tokens";
import { Placeholder } from "@src/modules/shared/layouts/blocks";

import type { SqliteFile } from "../../../types";

// ============================================
// Types
// ============================================

export interface PendingConnectionsListProps {
  files: SqliteFile[];
  isScanning?: boolean;
  error?: string | null;
  onOpenFile: (file: SqliteFile) => void;
}

// ============================================
// Component
// ============================================

export const PendingConnectionsList: React.FC<PendingConnectionsListProps> =
  memo(({ files, isScanning = false, error, onOpenFile }) => {
    const { t } = useTranslation();
    // Handle add button click
    const handleAddClick = useCallback(
      (event: React.MouseEvent, file: SqliteFile) => {
        event.stopPropagation();
        onOpenFile(file);
      },
      [onOpenFile]
    );

    return (
      <div className="flex h-full flex-col overflow-y-auto scrollbar-hide">
        {/* Error message */}
        {error && <Placeholder variant="error" title={error} />}

        {/* File list */}
        {files.map((file) => (
          <TreeRowBase
            key={file.path}
            node={{
              id: file.path,
              name: file.name,
              path: file.path,
              type: "file",
              icon: (
                <Database
                  size={14}
                  strokeWidth={1.75}
                  className="text-text-3"
                />
              ),
            }}
            depth={0}
            isSelected={false}
          >
            {/* Add button (on hover) */}
            <button
              className={`${HEADER_BUTTON.actionTreeRow} hidden shrink-0 group-focus-within/item:flex group-hover/item:flex`}
              onClick={(event) => handleAddClick(event, file)}
              title={t("tooltips.addConnection")}
            >
              <Plus size={14} strokeWidth={1.75} />
            </button>
          </TreeRowBase>
        ))}

        {/* Subtle scanning indicator (non-blocking) */}
        {isScanning && (
          <span className="flex items-center gap-2 px-3 py-1.5 text-[13px] text-text-3">
            <Loader2 size={SPINNER_TOKENS.small} className="animate-spin" />
            Scanning...
          </span>
        )}

        {/* Empty state */}
        {files.length === 0 && !isScanning && (
          <Placeholder
            variant="empty"
            title={t("placeholders.noFilesFound")}
            subtitle={t("placeholders.noSqliteFiles")}
          />
        )}
      </div>
    );
  });

PendingConnectionsList.displayName = "PendingConnectionsList";

export default PendingConnectionsList;
