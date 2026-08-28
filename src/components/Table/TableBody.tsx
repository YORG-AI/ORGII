import { Cell, Row, flexRender } from "@tanstack/react-table";
import React, { useState } from "react";

import {
  ChevronsDownUpIcon,
  HugeiconsIcon,
  InboxIcon,
  UnfoldMoreIcon,
} from "@src/icons";

import type { ColumnMeta, TableColumn, TableProps } from "./types";

interface TableBodyProps<T> {
  rows: Row<T>[];
  columns: TableColumn<T>[];
  hasRowSelection: boolean;
  expandable?: TableProps<T>["expandable"];
  expandedRows: Set<string>;
  toggleRowExpand: (key: string) => void;
  resolveRowKey: (record: T, index: number) => string;
  settings: boolean;
  rowClassName?: string | ((record: T, index: number) => string);
  rowDataTestId?: (record: T, index: number) => string | undefined;
  rowDataAttributes?: (
    record: T,
    index: number
  ) => Record<string, string | number | boolean | undefined> | undefined;
  onRowClick?: (record: T, index: number) => void;
  noDataElement?: React.ReactNode;
}

const INTERACTIVE_TABLE_TARGET_SELECTOR = [
  "button",
  "a",
  "input",
  "select",
  "textarea",
  "[data-checkbox]",
  "[role='button']",
  "[role='combobox']",
  "[role='menuitem']",
  ".select-wrapper",
  ".dropdown-trigger-wrapper",
].join(", ");

function isInteractiveTableTarget(target: EventTarget | null): boolean {
  return target instanceof Element
    ? target.closest(INTERACTIVE_TABLE_TARGET_SELECTOR) !== null
    : false;
}

function renderExpandedContent<T>(
  row: Row<T>,
  index: number,
  expandable: NonNullable<TableProps<T>["expandable"]>,
  totalRows: number,
  totalColSpan: number,
  settings: boolean
): React.ReactNode {
  const content = expandable.expandedRowRender!(row.original);

  if (
    Array.isArray(content) &&
    content.length > 0 &&
    Array.isArray(content[0])
  ) {
    const subRows = content as React.ReactNode[][];
    const { onSubRowClick } = expandable;
    return subRows.map((cells, subIdx) => (
      <tr
        key={`${row.id}-sub-${subIdx}`}
        className={["table-expanded-row", onSubRowClick && "cursor-pointer"]
          .filter(Boolean)
          .join(" ")}
        onClick={
          onSubRowClick
            ? (event) => {
                if (isInteractiveTableTarget(event.target)) return;
                onSubRowClick(row.original, subIdx);
              }
            : undefined
        }
      >
        <td className="table-td table-expand-cell" />
        {cells.map((cell, cellIdx) => {
          const parentHeader = row.getVisibleCells()[cellIdx];
          const meta = parentHeader
            ? (parentHeader.column.columnDef.meta as {
                align?: string;
                width?: string | number;
              })
            : undefined;
          return (
            <td
              key={cellIdx}
              className={[
                "table-td",
                meta?.align === "right" && "table-td-align-right",
                meta?.align === "center" && "table-td-align-center",
              ]
                .filter(Boolean)
                .join(" ")}
              style={{
                width: meta?.width,
                textAlign:
                  (meta?.align as "left" | "right" | undefined) || "left",
              }}
            >
              {settings ? <div className="table-td-inner">{cell}</div> : cell}
            </td>
          );
        })}
      </tr>
    ));
  }

  const isLastRow = index === totalRows - 1;
  return (
    <tr
      className={["table-expanded-row", isLastRow && "table-expanded-row-last"]
        .filter(Boolean)
        .join(" ")}
    >
      <td colSpan={totalColSpan} className="p-0">
        <div className="w-0 min-w-full max-w-full overflow-hidden [contain:inline-size]">
          {content}
        </div>
      </td>
    </tr>
  );
}

export function TableBody<T>({
  rows,
  columns,
  hasRowSelection,
  expandable,
  expandedRows,
  toggleRowExpand,
  resolveRowKey,
  settings,
  rowClassName,
  rowDataTestId,
  rowDataAttributes,
  onRowClick,
  noDataElement,
}: TableBodyProps<T>) {
  const totalColSpan =
    columns.length + (hasRowSelection ? 1 : 0) + (expandable ? 1 : 0);
  const [hoverSuppressedRowKey, setHoverSuppressedRowKey] = useState<
    string | null
  >(null);

  if (rows.length === 0) {
    return (
      <tbody className="table-tbody">
        <tr>
          <td colSpan={totalColSpan}>
            <div className="table-empty">
              {noDataElement || (
                <>
                  <HugeiconsIcon
                    icon={InboxIcon}
                    data-icon="inbox"
                    size={48}
                    className="opacity-40"
                  />
                  <span>No Data</span>
                </>
              )}
            </div>
          </td>
        </tr>
      </tbody>
    );
  }

  return (
    <tbody className="table-tbody">
      {rows.map((row, index) => {
        const rowClass =
          typeof rowClassName === "function"
            ? rowClassName(row.original, index)
            : rowClassName;

        const rowKey = resolveRowKey(row.original, index);
        const dataTestId = rowDataTestId?.(row.original, index);
        const dataAttributes = rowDataAttributes?.(row.original, index) ?? {};
        const canExpand =
          expandable?.rowExpandable?.(row.original) ?? !!expandable;
        const isExpanded = expandedRows.has(rowKey);

        return (
          <React.Fragment key={rowKey}>
            <tr
              data-testid={dataTestId}
              {...dataAttributes}
              className={[
                "table-row",
                rowClass,
                hoverSuppressedRowKey === rowKey &&
                  "table-row-hover-suppressed",
                (onRowClick || canExpand) && "cursor-pointer",
              ]
                .filter(Boolean)
                .join(" ")}
              onMouseLeave={() => {
                if (hoverSuppressedRowKey === rowKey) {
                  setHoverSuppressedRowKey(null);
                }
              }}
              onClick={(event) => {
                if (isInteractiveTableTarget(event.target)) return;
                if (onRowClick) {
                  onRowClick(row.original, index);
                } else if (canExpand) {
                  setHoverSuppressedRowKey(rowKey);
                  toggleRowExpand(rowKey);
                }
              }}
            >
              {expandable && (
                <td className="table-td table-expand-cell">
                  <div className="flex h-full items-center justify-end">
                    {canExpand ? (
                      <button
                        type="button"
                        className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded text-text-3 transition-colors hover:text-text-1"
                        onClick={(event) => {
                          event.stopPropagation();
                          event.currentTarget.blur();
                          setHoverSuppressedRowKey(rowKey);
                          toggleRowExpand(rowKey);
                        }}
                        aria-label={isExpanded ? "Collapse row" : "Expand row"}
                        aria-expanded={isExpanded}
                      >
                        {isExpanded ? (
                          <HugeiconsIcon
                            icon={ChevronsDownUpIcon}
                            data-icon="chevrons-down-up"
                            size={14}
                            className="shrink-0"
                          />
                        ) : (
                          <HugeiconsIcon
                            icon={UnfoldMoreIcon}
                            data-icon="chevrons-up-down"
                            size={14}
                            className="shrink-0"
                          />
                        )}
                      </button>
                    ) : (
                      <span
                        className="inline-flex h-3.5 w-3.5 shrink-0"
                        aria-hidden
                      />
                    )}
                  </div>
                </td>
              )}
              {row.getVisibleCells().map((cell: Cell<T, unknown>) => {
                const meta = cell.column.columnDef.meta as
                  | ColumnMeta
                  | undefined;
                const cellContent = flexRender(
                  cell.column.columnDef.cell,
                  cell.getContext()
                );
                const isFillCol = settings && !meta?.width;
                const hideClass = meta?.hideBelow
                  ? `table-col-hide-${meta.hideBelow}`
                  : "";
                return (
                  <td
                    key={cell.id}
                    className={[
                      "table-td",
                      meta?.align === "right" && "table-td-align-right",
                      meta?.align === "center" && "table-td-align-center",
                      isFillCol && "table-td-fill",
                      hideClass,
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    style={{
                      width: meta?.width,
                      textAlign: meta?.align || "left",
                    }}
                  >
                    {settings ? (
                      <div className="table-td-inner">{cellContent}</div>
                    ) : (
                      cellContent
                    )}
                  </td>
                );
              })}
            </tr>
            {isExpanded &&
              expandable?.expandedRowRender &&
              renderExpandedContent(
                row,
                index,
                expandable,
                rows.length,
                totalColSpan,
                settings
              )}
          </React.Fragment>
        );
      })}
    </tbody>
  );
}
