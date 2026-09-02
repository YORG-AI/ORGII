/**
 * SectionTable Component
 *
 * A table-style layout for displaying multiple settings across views.
 * Uses CSS grid (wide) for perfect column alignment + flex-col (narrow) for stacking.
 *
 * Wide (>=480px): CSS grid — label column auto-sizes to longest content,
 *   cell columns share remaining space equally via 1fr.
 * Narrow (<480px): Stacked flex-col — label on top, cells grouped below.
 *
 * Usage:
 * <SectionContainer>
 *   <SectionTable
 *     columns={[
 *       { key: "layout", label: "Layout Method" },
 *       { key: "chat", label: "Chat Position" }
 *     ]}
 *     rows={[
 *       { key: "main", icon: <LayoutGrid size={14} />, label: "Main App" },
 *       { key: "session", icon: <MessagesSquare size={14} />, label: "Agent Session" },
 *     ]}
 *     renderCell={(rowKey, columnKey) => <Select ... />}
 *     labelColumnHeader="View"
 *   />
 * </SectionContainer>
 */
import React, { type ReactNode, memo, useMemo } from "react";

import {
  SECTION_TABLE_DEFAULT_COL,
  SECTION_TABLE_EMPTY_CLASSES,
  SECTION_TABLE_HEADER_CLASSES,
  SECTION_TABLE_LABEL_CLASSES,
} from "./tokens";

export interface SectionTableColumn {
  /** Unique column key */
  key: string;
  /** Column header label */
  label: string;
  /** Fixed width in pixels (optional - if not set, uses 1fr) */
  width?: number;
  /** Whether this column should fill remaining space */
  fill?: boolean;
}

export interface SectionTableRow {
  /** Unique row key */
  key: string;
  /** Optional icon for the row */
  icon?: ReactNode;
  /** Row label */
  label: string;
}

export interface SectionTableProps {
  /** Column definitions */
  columns: SectionTableColumn[];
  /** Row definitions */
  rows: SectionTableRow[];
  /**
   * Render function for each cell
   * Return null to render an empty cell (e.g., N/A)
   */
  renderCell: (rowKey: string, columnKey: string) => ReactNode;
  /** Optional className for the container */
  className?: string;
  /** Hide the row labels column (for tables where all data is in columns) */
  hideRowLabels?: boolean;
  /** Header text for the row labels column (e.g., "View") */
  labelColumnHeader?: string;
}

const SectionTable: React.FC<SectionTableProps> = memo(
  ({
    columns,
    rows,
    renderCell,
    className = "",
    hideRowLabels = false,
    labelColumnHeader,
  }) => {
    // Build CSS grid template from column definitions
    // Label column = auto (content-sized), data columns = width or 1fr
    const gridTemplateColumns = useMemo(() => {
      const colTemplates = columns.map((col) => {
        if (col.width !== undefined) return `${col.width}px`;
        if (col.fill) return "1fr";
        return SECTION_TABLE_DEFAULT_COL;
      });
      if (hideRowLabels) return colTemplates.join(" ");
      // Label column fills remaining space, pushing data columns right
      return `1fr ${colTemplates.join(" ")}`;
    }, [columns, hideRowLabels]);

    return (
      <div className={className}>
        {/* ===== Wide layout: CSS grid (hidden below 480px) ===== */}
        <div
          className="hidden gap-x-4 gap-y-1.5 @[480px]:grid"
          style={{ gridTemplateColumns }}
        >
          {/* Header row */}
          {!hideRowLabels && (
            <div
              className={`self-center pt-3 pb-2 ${SECTION_TABLE_HEADER_CLASSES}`}
            >
              {labelColumnHeader ?? ""}
            </div>
          )}
          {columns.map((column) => (
            <div
              key={`header-${column.key}`}
              className={`min-w-0 self-center pt-3 pb-2 ${SECTION_TABLE_HEADER_CLASSES}`}
            >
              {column.label}
            </div>
          ))}

          {/* Data rows */}
          {rows.map((row) => (
            <React.Fragment key={row.key}>
              {/* Label cell */}
              {!hideRowLabels && (
                <div className="flex items-center gap-2 py-1.5">
                  {row.icon && (
                    <span className="shrink-0 text-text-2">{row.icon}</span>
                  )}
                  <span
                    className={`whitespace-nowrap ${SECTION_TABLE_LABEL_CLASSES}`}
                  >
                    {row.label}
                  </span>
                </div>
              )}
              {/* Data cells */}
              {columns.map((column) => {
                const cellContent = renderCell(row.key, column.key);
                return (
                  <div key={column.key} className="min-w-0 py-1.5">
                    {cellContent !== null ? (
                      cellContent
                    ) : (
                      <span className={SECTION_TABLE_EMPTY_CLASSES}>—</span>
                    )}
                  </div>
                );
              })}
            </React.Fragment>
          ))}
        </div>

        {/* ===== Narrow layout: stacked (visible below 480px) ===== */}
        <div className="flex flex-col @[480px]:hidden">
          {rows.map((row) => (
            <div key={row.key} className="flex flex-col gap-2 py-1.5">
              {/* Row label */}
              {!hideRowLabels && (
                <div className="flex items-center gap-2">
                  {row.icon && (
                    <span className="shrink-0 text-text-2">{row.icon}</span>
                  )}
                  <span
                    className={`whitespace-nowrap ${SECTION_TABLE_LABEL_CLASSES}`}
                  >
                    {row.label}
                  </span>
                </div>
              )}

              {/* Cells in a row */}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                {columns.map((column) => {
                  const cellContent = renderCell(row.key, column.key);
                  return (
                    <div
                      key={column.key}
                      className={
                        column.fill
                          ? "min-w-[120px] flex-1"
                          : column.width !== undefined
                            ? "min-w-0 shrink-0"
                            : "min-w-[120px] flex-1"
                      }
                      style={
                        column.width !== undefined
                          ? { width: column.width, maxWidth: "100%" }
                          : undefined
                      }
                    >
                      {cellContent !== null ? (
                        cellContent
                      ) : (
                        <span className={SECTION_TABLE_EMPTY_CLASSES}>—</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }
);

SectionTable.displayName = "SectionTable";

export default SectionTable;
