/**
 * QueryHistoryContent Component
 *
 * Shows recent SQL queries for quick re-execution.
 * Queries are stored per-connection in localStorage via queryHistoryAtom.
 */
import { Eraser, Play, Trash2 } from "lucide-react";
import React, { memo, useCallback } from "react";
import { useTranslation } from "react-i18next";

import { useQueryHistory } from "@src/hooks/database";
import { HEADER_BUTTON } from "@src/modules/WorkStation/shared/tokens";
import { Placeholder } from "@src/modules/shared/layouts/blocks";

// ============================================
// Types
// ============================================

interface QueryHistoryContentProps {
  connectionId: string | null;
  /** Called when the user clicks Run on a history item */
  onRunQuery?: (sql: string) => void;
}

// ============================================
// Helpers
// ============================================

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const isToday =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  return isToday
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" }) +
        " " +
        d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// ============================================
// Component
// ============================================

export const QueryHistoryContent: React.FC<QueryHistoryContentProps> = memo(
  ({ connectionId, onRunQuery }) => {
    const { t } = useTranslation();
    const { history, removeQuery, clearHistory } = useQueryHistory(
      connectionId ?? ""
    );

    const handleRun = useCallback(
      (sql: string) => {
        onRunQuery?.(sql);
      },
      [onRunQuery]
    );

    // Empty state
    if (history.length === 0) {
      return (
        <Placeholder
          variant="empty"
          placement="sidebar"
          title={t("placeholders.noQueryHistory")}
          subtitle={t("placeholders.executedQueriesSubtitle")}
          fillParentHeight
        />
      );
    }

    // History list
    return (
      <div className="flex flex-col gap-1 p-2">
        {/* Clear all button */}
        <div className="flex justify-end pb-1">
          <button
            className={HEADER_BUTTON.action}
            title={t("tooltips.clearHistory")}
            onClick={clearHistory}
          >
            <Eraser size={13} />
            <span className="ml-1 text-xs">{t("labels.clearAll")}</span>
          </button>
        </div>

        {history.map((item) => (
          <div
            key={item.timestamp}
            className="group flex flex-col gap-1 rounded border border-border-1 bg-workstation-bg p-2 transition-colors hover:border-border-2"
          >
            {/* Query preview */}
            <pre className="line-clamp-2 overflow-hidden text-ellipsis whitespace-pre-wrap font-mono text-xs text-text-2">
              {item.sql}
            </pre>

            {/* Meta info */}
            <div className="flex items-center justify-between text-xs text-text-3">
              <span
                className={item.success ? "text-text-3" : "text-status-error"}
              >
                {item.success
                  ? `${item.duration.toFixed(0)}ms`
                  : t("labels.failed")}
              </span>
              <div className="flex items-center gap-2">
                {item.rowCount !== undefined && (
                  <span>{item.rowCount} rows</span>
                )}
                <span>{formatTimestamp(item.timestamp)}</span>
              </div>
            </div>

            {/* Actions (shown on hover) */}
            <div className="flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
              <button
                className={HEADER_BUTTON.success}
                title={t("tooltips.runQuery")}
                onClick={() => handleRun(item.sql)}
              >
                <Play size={14} />
              </button>
              <button
                className={HEADER_BUTTON.danger}
                title={t("tooltips.removeFromHistory")}
                onClick={() => removeQuery(item.timestamp)}
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        ))}
      </div>
    );
  }
);

QueryHistoryContent.displayName = "QueryHistoryContent";

export default QueryHistoryContent;
