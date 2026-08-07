/**
 * DataGrid Component
 *
 * Table data viewer using ali-react-table with CRUD support.
 * Features:
 * - Column sorting
 * - Column resizing
 * - Virtualization for large datasets
 * - Cell selection/focus
 * - Row selection (checkboxes)
 * - Inline cell editing
 * - Visual indicators for pending changes
 *
 * No antd - uses custom styling with Tailwind/SCSS.
 */
import {
  ArtColumn,
  BaseTable,
  SortItem,
  features,
  useTablePipeline,
} from "ali-react-table";
import React, { memo, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import Checkbox from "@src/components/Checkbox";
import type { ColumnInfo, QueryResult } from "@src/engines/DatabaseCore";
import { Placeholder } from "@src/modules/shared/layouts/blocks";
import type { PendingChangeType } from "@src/store/workstation/database";

import InlineEditCell from "./InlineEditCell";
import "./index.scss";

// ============================================
// Types
// ============================================

interface DataGridProps {
  /** Query result data */
  data: QueryResult | null;
  /** Column schema */
  schema: ColumnInfo[];
  /** Loading state */
  loading?: boolean;
  /** Error message */
  error?: string | null;
  /** Table name for display */
  tableName?: string;
  /** Enable edit mode */
  editable?: boolean;
  /** Selected row indices */
  selectedRows?: Set<number>;
  /** Currently editing cell */
  editingCell?: { rowIndex: number; column: string } | null;
  /** Get change type for a row */
  getRowChangeType?: (rowIndex: number) => PendingChangeType | null;
  /** Check if cell is modified */
  isCellModified?: (rowIndex: number, column: string) => boolean;
  /** Get pending value for a cell */
  getPendingValue?: (rowIndex: number, column: string) => unknown | undefined;
  /** Callback when cell is clicked */
  onCellClick?: (row: unknown[], column: string, rowIndex: number) => void;
  /** Callback when cell is double-clicked (for editing) */
  onCellDoubleClick?: (
    row: unknown[],
    column: string,
    rowIndex: number
  ) => void;
  /** Callback when row selection changes */
  onRowSelect?: (rowIndex: number) => void;
  /** Callback to select/deselect all rows */
  onSelectAll?: (selected: boolean) => void;
  /** Callback when cell edit is saved */
  onCellSave?: (
    rowIndex: number,
    column: string,
    originalRow: Record<string, unknown>,
    newValue: unknown
  ) => void;
  /** Callback when cell edit is cancelled */
  onCellCancel?: () => void;
}

// ============================================
// Component
// ============================================

export const DataGrid: React.FC<DataGridProps> = memo(
  ({
    data,
    schema,
    loading,
    error,
    tableName,
    editable = false,
    selectedRows = new Set(),
    editingCell,
    getRowChangeType,
    isCellModified,
    getPendingValue,
    onCellClick,
    onCellDoubleClick,
    onRowSelect,
    onSelectAll,
    onCellSave,
    onCellCancel,
  }) => {
    const { t } = useTranslation();
    // Selected row state (for highlighting entire row with fill-2)
    const [selectedRow, setSelectedRow] = useState<number | null>(null);

    // Selected cell state (for highlighting specific cell with primary-6)
    const [selectedCell, setSelectedCell] = useState<{
      rowIndex: number;
      column: string;
    } | null>(null);

    // Column resize state
    const [columnSizes, setColumnSizes] = useState<number[]>([]);

    // Sort state
    const [sorts, setSorts] = useState<SortItem[]>([]);

    // Check if all rows are selected
    const allSelected = useMemo(() => {
      if (!data?.values || data.values.length === 0) return false;
      return data.values.every((_, idx) => selectedRows.has(idx));
    }, [data?.values, selectedRows]);

    // Build columns from schema
    const columns: ArtColumn[] = useMemo(() => {
      if (!data?.columns) return [];

      const cols: ArtColumn[] = [];

      // Selection checkbox column (only if editable)
      if (editable) {
        cols.push({
          code: "__select__",
          name: "",
          lock: true,
          width: 40,
          title: (
            <div className="data-grid__checkbox-header">
              <Checkbox
                checked={allSelected}
                onChange={() => onSelectAll?.(!allSelected)}
              />
            </div>
          ),
          render: (
            _value: unknown,
            _record: Record<string, unknown>,
            rowIndex: number
          ) => {
            const changeType = getRowChangeType?.(rowIndex);
            const isDeleted = changeType === "delete";

            return (
              <div
                className={`data-grid__checkbox-cell ${isDeleted ? "data-grid__checkbox-cell--deleted" : ""}`}
              >
                <Checkbox
                  checked={selectedRows.has(rowIndex)}
                  onChange={() => onRowSelect?.(rowIndex)}
                  disabled={isDeleted}
                />
              </div>
            );
          },
        });
      }

      // Data columns
      data.columns.forEach((colName, colIndex) => {
        const schemaInfo = schema.find(
          (schemaItem) => schemaItem.name === colName
        );
        const isPrimaryKey = schemaInfo?.primaryKey || false;
        const columnType = schemaInfo?.type || "TEXT";

        cols.push({
          code: colName,
          name: colName,
          title: (
            <div className="data-grid__header-cell">
              <span className="data-grid__header-name">
                {colName}
                {isPrimaryKey && (
                  <span className="data-grid__pk-badge">PK</span>
                )}
              </span>
              {schemaInfo?.type && (
                <span className="data-grid__header-type">
                  {schemaInfo.type}
                </span>
              )}
            </div>
          ),
          width: columnSizes[colIndex] || 150,
          render: (
            value: unknown,
            record: Record<string, unknown>,
            rowIndex: number
          ) => {
            // Cell selection for primary-6 highlight
            const isSelected =
              selectedCell?.rowIndex === rowIndex &&
              selectedCell?.column === colName;
            const isEditing =
              editingCell?.rowIndex === rowIndex &&
              editingCell?.column === colName;
            const isModified = isCellModified?.(rowIndex, colName) || false;
            const changeType = getRowChangeType?.(rowIndex);
            const isDeleted = changeType === "delete";
            const isInserted = changeType === "insert";
            const isUpdated = changeType === "update";

            // Use pending value if available
            const displayValue = getPendingValue?.(rowIndex, colName) ?? value;

            // Get original row array for callbacks
            const rowArray = (record.__rowArray as unknown[]) || [];

            // State classes for visual indicators (passed to input)
            const stateClass = isModified
              ? "modified"
              : isDeleted
                ? "deleted"
                : isInserted
                  ? "inserted"
                  : isUpdated
                    ? "updated"
                    : undefined;

            // No wrapper div - InlineEditCell is the direct child of the cell
            return (
              <InlineEditCell
                value={displayValue}
                columnType={columnType}
                isEditing={isEditing}
                isSelected={isSelected}
                stateClass={stateClass}
                onClick={() => {
                  if (!isDeleted) {
                    setSelectedRow(rowIndex);
                    setSelectedCell({ rowIndex, column: colName });
                    onCellClick?.(rowArray, colName, rowIndex);
                  }
                }}
                onDoubleClick={() => {
                  if (editable && !isDeleted && !isPrimaryKey) {
                    onCellDoubleClick?.(rowArray, colName, rowIndex);
                  }
                }}
                onSave={(newValue) => {
                  if (newValue !== value) {
                    const rowObj = { ...record };
                    delete rowObj.__rowArray;
                    onCellSave?.(rowIndex, colName, rowObj, newValue);
                  } else {
                    onCellCancel?.();
                  }
                }}
                onCancel={() => onCellCancel?.()}
              />
            );
          },
          features: {
            sortable: true,
          },
        });
      });

      return cols;
      // eslint-disable-next-line react-hooks/exhaustive-deps -- selectedRow used in cell click handler, not for recomputation
    }, [
      data,
      schema,
      columnSizes,
      selectedCell,
      editingCell,
      editable,
      selectedRows,
      allSelected,
      getRowChangeType,
      isCellModified,
      getPendingValue,
      onCellClick,
      onCellDoubleClick,
      onRowSelect,
      onSelectAll,
      onCellSave,
      onCellCancel,
    ]);

    // Build data source - convert row arrays to objects for ali-react-table
    // ali-react-table expects objects like { id: 1, name: "John" }, not arrays
    const dataSource = useMemo(() => {
      if (!data?.values || !data?.columns) return [];
      return data.values.map((row) => {
        const obj: Record<string, unknown> = {};
        data.columns.forEach((colName, idx) => {
          obj[colName] = row[idx];
        });
        // Also keep the original array for callbacks
        obj.__rowArray = row;
        return obj;
      });
    }, [data]);

    // Handle column resize
    const handleColumnResize = useCallback((sizes: number[]) => {
      setColumnSizes(sizes);
    }, []);

    // Handle sort change
    const handleSortChange = useCallback((newSorts: SortItem[]) => {
      setSorts(newSorts);
    }, []);

    // Table pipeline
    const pipeline = useTablePipeline()
      .input({ dataSource, columns })
      .use(
        features.sort({
          mode: "single",
          sorts,
          onChangeSorts: handleSortChange,
          highlightColumnWhenActive: true,
        })
      )
      .use(
        features.columnResize({
          fallbackSize: 150,
          minSize: 80,
          maxSize: 500,
          handleHoverBackground:
            "color-mix(in srgb, var(--color-primary-6) 30%, transparent)",
          handleActiveBackground:
            "color-mix(in srgb, var(--color-primary-6) 50%, transparent)",
          onChangeSizes: handleColumnResize,
        })
      );

    // Loading state
    if (loading) {
      return (
        <Placeholder
          variant="loading"
          placement="detail-panel"
          title={t("workstation.loadingData")}
          fillParentHeight
        />
      );
    }

    // Error state
    if (error) {
      return (
        <Placeholder
          variant="error"
          placement="detail-panel"
          title={error}
          fillParentHeight
        />
      );
    }

    // Empty state
    if (!data || dataSource.length === 0) {
      return (
        <Placeholder
          variant="empty"
          placement="detail-panel"
          title={t("workstation.noData")}
          fillParentHeight
        />
      );
    }

    return (
      <div className="data-grid">
        {/* Table container with scrolling */}
        <div className="data-grid__table-container">
          <BaseTable
            className="data-grid__table"
            style={
              {
                height: "100%",
                overflow: "auto",
                "--row-height": "28px",
              } as React.CSSProperties
            }
            isStickyHead
            stickyTop={0}
            {...pipeline.getProps()}
            getRowProps={(_record, rowIndex) => ({
              className:
                selectedRow === rowIndex ? "data-grid__row--selected" : "",
            })}
            components={{
              EmptyContent: () => (
                <Placeholder variant="empty" title={t("placeholders.noRows")} />
              ),
            }}
          />
        </div>

        {/* Status bar */}
        <div className="data-grid__status">
          {tableName && (
            <span className="data-grid__table-name">{tableName}</span>
          )}
          <span className="data-grid__row-count">
            {data.rowCount} row{data.rowCount !== 1 ? "s" : ""}
          </span>
          {data.duration !== undefined && (
            <span className="data-grid__duration">
              {data.duration.toFixed(1)}ms
            </span>
          )}
        </div>
      </div>
    );
  }
);

DataGrid.displayName = "DataGrid";

export default DataGrid;
