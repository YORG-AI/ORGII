/**
 * QueryResults Component
 *
 * Displays SQL query results in a table format.
 * Features:
 * - Success/error status indicator
 * - Duration display
 * - Row count
 * - Scrollable results table
 */
import React, { memo } from "react";
import { useTranslation } from "react-i18next";

import { Placeholder } from "@src/components/Placeholder";
import type { QueryResult } from "@src/engines/DatabaseCore";
import {
  AlertCircleIcon,
  CheckmarkCircle01Icon,
  Clock01Icon,
  HugeiconsIcon,
} from "@src/icons";

// ============================================
// Types
// ============================================

export interface QueryResultsProps {
  /** Query result data */
  result: QueryResult | null;
  /** Error message if query failed */
  error: string | null;
  /** Loading state */
  loading?: boolean;
}

// ============================================
// Component
// ============================================

export const QueryResults: React.FC<QueryResultsProps> = memo(
  ({ result, error, loading }) => {
    const { t } = useTranslation("common");

    // Loading state
    if (loading) {
      return (
        <Placeholder variant="loading" title={t("sqlEditor.executingQuery")} />
      );
    }

    // Error state
    if (error) {
      return (
        <div className="flex h-full flex-col">
          {/* Error header */}
          <div className="bg-[color-mix(in srgb, var(--color-danger-6) 10%, transparent)] flex items-center gap-2 border-b border-border-1 px-3 py-2">
            <HugeiconsIcon
              icon={AlertCircleIcon}
              data-icon="alert-circle"
              size={14}
              strokeWidth={1.75}
              className="text-(--color-danger-6)"
            />
            <span className="text-xs font-medium text-(--color-danger-6)">
              {t("sqlEditor.queryFailed")}
            </span>
          </div>

          {/* Error message */}
          <div className="flex-1 overflow-auto p-3">
            <pre className="text-xs whitespace-pre-wrap text-(--color-danger-6)">
              {error}
            </pre>
          </div>
        </div>
      );
    }

    // Empty state (no query run yet)
    if (!result) {
      return (
        <Placeholder
          variant="empty"
          title={t("sqlEditor.runQueryToSeeResults")}
        />
      );
    }

    // No results
    if (result.rowCount === 0) {
      return (
        <div className="flex h-full flex-col">
          {/* Success header */}
          <div className="bg-[color-mix(in srgb, var(--color-success-6) 10%, transparent)] flex items-center gap-3 border-b border-border-1 px-3 py-2">
            <div className="flex items-center gap-1.5">
              <HugeiconsIcon
                icon={CheckmarkCircle01Icon}
                data-icon="check-circle-2"
                size={14}
                strokeWidth={1.75}
                className="text-(--color-success-6)"
              />
              <span className="text-xs font-medium text-(--color-success-6)">
                {t("sqlEditor.queryCompleted")}
              </span>
            </div>
            <div className="flex items-center gap-1 text-xs text-text-3">
              <HugeiconsIcon
                icon={Clock01Icon}
                data-icon="clock"
                size={12}
                strokeWidth={1.75}
              />
              <span>{result.duration.toFixed(1)}ms</span>
            </div>
          </div>

          {/* Empty message */}
          <div className="flex flex-1 items-center justify-center">
            <Placeholder
              variant="no-results"
              title={t("sqlEditor.noResults")}
            />
          </div>
        </div>
      );
    }

    const rowCountLabel =
      result.rowCount === 1
        ? t("sqlEditor.rowCount_one", { count: result.rowCount })
        : t("sqlEditor.rowCount_other", { count: result.rowCount });

    // Results table
    return (
      <div className="flex h-full flex-col">
        {/* Success header with stats */}
        <div className="flex items-center gap-3 border-b border-border-1 bg-[color-mix(in_srgb,var(--color-success-6)_5%,transparent)] px-3 py-2">
          <div className="flex items-center gap-1.5">
            <HugeiconsIcon
              icon={CheckmarkCircle01Icon}
              data-icon="check-circle-2"
              size={14}
              strokeWidth={1.75}
              className="text-(--color-success-6)"
            />
            <span className="text-xs font-medium text-text-1">
              {rowCountLabel}
            </span>
          </div>
          <div className="flex items-center gap-1 text-xs text-text-3">
            <HugeiconsIcon
              icon={Clock01Icon}
              data-icon="clock"
              size={12}
              strokeWidth={1.75}
            />
            <span>{result.duration.toFixed(1)}ms</span>
          </div>
        </div>

        {/* Results table */}
        <div className="flex-1 overflow-auto">
          <table className="w-full border-collapse text-xs">
            <thead className="sticky top-0 bg-bg-3">
              <tr>
                {result.columns.map((column, idx) => (
                  <th
                    key={idx}
                    className="border-r border-b border-border-1 px-3 py-2 text-left font-medium text-text-2 last:border-r-0"
                  >
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.values.map((row, rowIdx) => (
                <tr key={rowIdx} className="hover:bg-fill-1">
                  {row.map((cell, cellIdx) => (
                    <td
                      key={cellIdx}
                      className="border-r border-b border-border-1 px-3 py-1.5 last:border-r-0"
                    >
                      {renderCellValue(cell, t)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }
);

// ============================================
// Helper Functions
// ============================================

type TranslateFn = (key: string) => string;

function renderCellValue(value: unknown, t: TranslateFn): React.ReactNode {
  if (value === null) {
    return (
      <span className="text-text-4 italic">{t("sqlEditor.nullValue")}</span>
    );
  }
  if (value === undefined) {
    return <span className="text-text-4">—</span>;
  }
  if (typeof value === "boolean") {
    return (
      <span className="text-(--color-primary-6)">
        {value ? t("sqlEditor.booleanTrue") : t("sqlEditor.booleanFalse")}
      </span>
    );
  }
  if (typeof value === "number") {
    return <span className="text-(--color-primary-5)">{value}</span>;
  }
  // Truncate long strings
  const strValue = String(value);
  if (strValue.length > 100) {
    return (
      <span className="text-text-1" title={strValue}>
        {strValue.slice(0, 100)}…
      </span>
    );
  }
  // Ensure strings are visible in both light/dark themes.
  return <span className="text-text-1">{strValue}</span>;
}

QueryResults.displayName = "QueryResults";

export default QueryResults;
