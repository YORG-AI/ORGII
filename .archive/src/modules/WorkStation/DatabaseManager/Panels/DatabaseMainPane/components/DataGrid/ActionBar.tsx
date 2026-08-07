/**
 * ActionBar Component
 *
 * Toolbar for database table CRUD operations.
 * Shows Insert, Delete, and pending changes info.
 */
import { Plus, RotateCcw, Trash2 } from "lucide-react";
import React, { memo } from "react";
import { useTranslation } from "react-i18next";

import { HUMANTOOLS_TEXT_KEYS } from "@src/modules/WorkStation/shared";

// ============================================
// Types
// ============================================

export interface ActionBarProps {
  /** Number of selected rows */
  selectedCount: number;
  /** Pending changes count */
  changeCount: {
    inserts: number;
    updates: number;
    deletes: number;
  };
  /** Whether the table is read-only */
  readOnly?: boolean;
  /** Callback to insert a new row */
  onInsert: () => void;
  /** Callback to delete selected rows */
  onDeleteSelected: () => void;
  /** Callback to discard all changes */
  onDiscard: () => void;
}

// ============================================
// Component
// ============================================

export const ActionBar: React.FC<ActionBarProps> = memo(
  ({
    selectedCount,
    changeCount,
    readOnly = false,
    onInsert,
    onDeleteSelected,
    onDiscard,
  }) => {
    const { t } = useTranslation();
    const totalChanges =
      changeCount.inserts + changeCount.updates + changeCount.deletes;
    const hasChanges = totalChanges > 0;

    if (readOnly) {
      return null;
    }

    return (
      <div className="flex h-[40px] shrink-0 items-center gap-1.5 border-b border-border-1 bg-workstation-bg px-2">
        {/* Insert button */}
        <button
          onClick={onInsert}
          title={t("tooltips.insertNewRow")}
          className="flex h-6 items-center gap-1.5 rounded px-2 text-xs text-text-2 transition-colors hover:bg-fill-2 hover:text-text-1"
        >
          <Plus size={14} strokeWidth={1.75} />
          <span>{t("actions.insert")}</span>
        </button>

        {/* Delete button - enabled when rows selected */}
        <button
          onClick={onDeleteSelected}
          disabled={selectedCount === 0}
          title={
            selectedCount > 0
              ? t("workstation.deleteSelectedRows", { count: selectedCount })
              : t(HUMANTOOLS_TEXT_KEYS.placeholders.selectRowsToDelete)
          }
          className="flex h-6 items-center gap-1.5 rounded px-2 text-xs text-text-2 transition-colors hover:bg-fill-2 hover:text-text-1 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
        >
          <Trash2 size={14} strokeWidth={1.75} />
          <span>{t("actions.delete")}</span>
          {selectedCount > 0 && (
            <span className="rounded bg-fill-3 px-1.5 py-0.5 text-[10px] font-medium">
              {selectedCount}
            </span>
          )}
        </button>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Changes indicator */}
        {hasChanges && (
          <div className="flex items-center gap-2 text-xs text-text-3">
            <span>
              {totalChanges} {t("common:common.pending")} change
              {totalChanges !== 1 ? "s" : ""}
            </span>

            {/* Change type breakdown */}
            <div className="flex items-center gap-1.5">
              {changeCount.inserts > 0 && (
                <span className="flex items-center gap-0.5 text-[var(--color-success-6)]">
                  <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-success-6)]" />
                  {changeCount.inserts}
                </span>
              )}
              {changeCount.updates > 0 && (
                <span className="flex items-center gap-0.5 text-[var(--color-warning-6)]">
                  <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-warning-6)]" />
                  {changeCount.updates}
                </span>
              )}
              {changeCount.deletes > 0 && (
                <span className="flex items-center gap-0.5 text-[var(--color-danger-6)]">
                  <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-danger-6)]" />
                  {changeCount.deletes}
                </span>
              )}
            </div>

            {/* Discard button */}
            <button
              onClick={onDiscard}
              title={t("tooltips.discardAllChanges")}
              className="flex h-5 items-center gap-1 rounded px-1.5 text-text-3 transition-colors hover:bg-fill-2 hover:text-text-1"
            >
              <RotateCcw size={12} strokeWidth={1.75} />
            </button>
          </div>
        )}
      </div>
    );
  }
);

ActionBar.displayName = "ActionBar";

export default ActionBar;
