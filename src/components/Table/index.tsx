/**
 * Native Table Component
 *
 * Native table built on TanStack Table (React Table v8).
 * Provides a headless table with complete UI control.
 *
 * Features:
 * - Full API compatibility
 * - Sorting (single and multi-column)
 * - Pagination
 * - Row selection
 * - Expandable rows
 * - Column resizing
 * - Column visibility
 * - Custom cell rendering
 * - Loading states
 * - Empty states
 *
 * @example
 * ```tsx
 * import Table from "@src/components/Table";
 *
 * <Table
 *   columns={columns}
 *   data={data}
 *   pagination={{ pageSize: 10 }}
 *   onChange={(pagination, sorter) => {}}
 * />
 * ```
 */
import {
  ColumnFiltersState,
  PaginationState,
  RowSelectionState,
  SortingState,
  VisibilityState,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import React, {
  forwardRef,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { useCurrentTheme } from "@src/util/ui/theme/themeUtils";

import { PaginationFooter } from "./PaginationFooter";
import { TableBody } from "./TableBody";
import { TableColGroup } from "./TableColGroup";
import { TableHeader } from "./TableHeader";
import "./index.scss";
import type { TableProps } from "./types";
import { useTableColumns } from "./useTableColumns";

export type { TableColumn, TablePagination, TableProps } from "./types";

function TableComponent<T = unknown>(
  {
    columns,
    data = [],
    rowKey: _rowKey = "id",
    loading: _loading = false,
    showHeader = true,
    pagination,
    onChange,
    rowSelection,
    hover = true,
    stripe = false,
    size = "default",
    border = false,
    noDataElement,
    rowClassName,
    rowDataTestId,
    rowDataAttributes,
    className = "",
    style,
    scroll,
    expandable,
    settings = false,
    renderPagination,
    onRowClick,
  }: TableProps<T>,
  ref: React.ForwardedRef<HTMLDivElement>
) {
  const { isDark } = useCurrentTheme();
  const [sorting, setSorting] = useState<SortingState>([]);
  const [internalExpandedRows, setInternalExpandedRows] = useState<Set<string>>(
    new Set()
  );

  const isControlledExpand =
    expandable?.expandedRowKeys !== undefined &&
    expandable?.onExpandedRowsChange !== undefined;
  const expandedRows = isControlledExpand
    ? new Set(expandable!.expandedRowKeys ?? [])
    : internalExpandedRows;

  const resolveRowKey = useCallback(
    (record: T, index: number): string => {
      if (typeof _rowKey === "function") return _rowKey(record);
      const val = (record as Record<string, unknown>)[_rowKey];
      return val != null ? String(val) : String(index);
    },
    [_rowKey]
  );

  const toggleRowExpand = useCallback(
    (key: string) => {
      if (isControlledExpand && expandable?.onExpandedRowsChange) {
        const current = new Set(expandable.expandedRowKeys ?? []);
        const next = new Set(current);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        expandable.onExpandedRowsChange([...next]);
      } else {
        setInternalExpandedRows((prev) => {
          const next = new Set(prev);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        });
      }
    },
    [isControlledExpand, expandable]
  );

  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
  const [rowSelectionState, setRowSelectionState] = useState<RowSelectionState>(
    {}
  );
  const [paginationState, setPaginationState] = useState<PaginationState>({
    pageIndex: pagination && pagination.current ? pagination.current - 1 : 0,
    pageSize: (pagination && pagination.pageSize) || 10,
  });

  const tableInternalRef = useRef<HTMLDivElement>(null);
  const bodyTableRef = useRef<HTMLTableElement>(null);
  const bodyScrollRef = useRef<HTMLDivElement>(null);
  const headerScrollRef = useRef<HTMLDivElement>(null);
  const [settingsHeaderColumnWidths, setSettingsHeaderColumnWidths] = useState<
    number[]
  >([]);
  const [horizontalAffordance, setHorizontalAffordance] = useState({
    left: false,
    right: false,
  });
  const savedScrollRef = useRef<{ element: Element; top: number } | null>(null);

  const saveScrollPosition = useCallback(() => {
    let element: Element | null = tableInternalRef.current;
    while (element) {
      element = element.parentElement;
      if (
        element &&
        element.scrollHeight > element.clientHeight &&
        element.clientHeight > 0
      ) {
        savedScrollRef.current = { element, top: element.scrollTop };
        return;
      }
    }
  }, []);

  useLayoutEffect(() => {
    const saved = savedScrollRef.current;
    if (saved) {
      saved.element.scrollTop = saved.top;
      savedScrollRef.current = null;
    }
  }, [paginationState]);

  const tanstackColumns = useTableColumns(columns, rowSelection);

  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data,
    columns: tanstackColumns,
    getRowId: (record, index) => resolveRowKey(record, index),
    state: {
      sorting,
      columnFilters,
      columnVisibility,
      rowSelection: rowSelectionState,
      pagination: paginationState,
    },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onColumnVisibilityChange: setColumnVisibility,
    onRowSelectionChange: setRowSelectionState,
    onPaginationChange: setPaginationState,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel:
      pagination !== false ? getPaginationRowModel() : undefined,
    enableRowSelection: !!rowSelection,
    manualPagination: false,
    pageCount:
      pagination && pagination.total
        ? Math.ceil(pagination.total / paginationState.pageSize)
        : undefined,
  });

  const handlePageChange = useCallback(
    (page: number) => {
      saveScrollPosition();
      setPaginationState((prev: PaginationState) => ({
        ...prev,
        pageIndex: page - 1,
      }));
      if (onChange && pagination) {
        onChange(
          { ...pagination, current: page },
          {},
          {
            column: sorting[0]?.id,
            order: sorting[0]?.desc ? "descend" : "ascend",
          }
        );
      }
    },
    [onChange, pagination, sorting, saveScrollPosition]
  );

  const handlePageSizeChange = useCallback(
    (pageSize: number) => {
      saveScrollPosition();
      setPaginationState({ pageIndex: 0, pageSize });
      if (onChange && pagination) {
        onChange(
          { ...pagination, current: 1, pageSize },
          {},
          {
            column: sorting[0]?.id,
            order: sorting[0]?.desc ? "descend" : "ascend",
          }
        );
      }
    },
    [onChange, pagination, sorting, saveScrollPosition]
  );

  const lastColumnKey = columns.at(-1)?.key;
  const pinLastColumn =
    settings &&
    lastColumnKey != null &&
    ["actions", "status", "enabled"].includes(lastColumnKey);
  const tableRows = table.getRowModel().rows;
  const tableHeaderGroups = table.getHeaderGroups();
  const showFixedSettingsHeader = settings && showHeader;

  const wrapperClasses = [
    "table-wrapper",
    `table-size-${size}`,
    hover && "table-hover",
    onRowClick && "table-clickable",
    stripe && "table-stripe",
    border && "table-border",
    settings && "table-settings",
    tableRows.length === 0 && "table-has-empty-state",
    pinLastColumn && "table-settings-pin-last-column",
    horizontalAffordance.left && "table-scroll-has-left",
    horizontalAffordance.right && "table-scroll-has-right",
    isDark && "table-dark",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  const scrollStyle = scroll
    ? {
        overflowX: scroll.x ? ("auto" as const) : undefined,
        overflowY: scroll.y ? ("auto" as const) : undefined,
        maxWidth: scroll.x,
        maxHeight: scroll.y,
      }
    : undefined;

  const updateHorizontalAffordance = useCallback(() => {
    const scrollElement = bodyScrollRef.current;
    if (!settings || !scrollElement) {
      setHorizontalAffordance({ left: false, right: false });
      return;
    }

    const maxScrollLeft = scrollElement.scrollWidth - scrollElement.clientWidth;
    const nextAffordance = {
      left: scrollElement.scrollLeft > 1,
      right: scrollElement.scrollLeft < maxScrollLeft - 1,
    };
    setHorizontalAffordance((previousAffordance) =>
      previousAffordance.left === nextAffordance.left &&
      previousAffordance.right === nextAffordance.right
        ? previousAffordance
        : nextAffordance
    );
  }, [settings]);

  const measureSettingsHeader = useCallback(() => {
    if (!showFixedSettingsHeader) return;

    const bodyRow =
      bodyTableRef.current?.querySelector<HTMLTableRowElement>(
        "tbody tr.table-row"
      );
    const bodyCells = bodyRow
      ? Array.from(
          bodyRow.querySelectorAll<HTMLTableCellElement>(
            "td:not(.table-expand-cell)"
          )
        )
      : [];
    const measuredWidths =
      bodyCells.length > 0
        ? bodyCells.map((cell) => cell.getBoundingClientRect().width)
        : (tableHeaderGroups[0]?.headers ?? []).map((header) => {
            const meta = header.column.columnDef.meta as
              | { width?: string | number }
              | undefined;
            return typeof meta?.width === "number"
              ? meta.width
              : header.getSize();
          });

    setSettingsHeaderColumnWidths((previousWidths) => {
      const hasChanged =
        previousWidths.length !== measuredWidths.length ||
        previousWidths.some(
          (width, index) => Math.abs(width - measuredWidths[index]) > 0.5
        );
      return hasChanged ? measuredWidths : previousWidths;
    });
    updateHorizontalAffordance();
  }, [showFixedSettingsHeader, tableHeaderGroups, updateHorizontalAffordance]);

  useLayoutEffect(() => {
    if (!showFixedSettingsHeader) return;

    measureSettingsHeader();

    const observer =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(measureSettingsHeader)
        : null;
    if (bodyTableRef.current) observer?.observe(bodyTableRef.current);
    if (bodyScrollRef.current) observer?.observe(bodyScrollRef.current);
    if (tableInternalRef.current) observer?.observe(tableInternalRef.current);
    window.addEventListener("resize", measureSettingsHeader);

    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measureSettingsHeader);
    };
  }, [measureSettingsHeader, showFixedSettingsHeader, tableRows.length]);

  useLayoutEffect(() => {
    if (!settings) return;

    updateHorizontalAffordance();

    const observer =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(updateHorizontalAffordance)
        : null;
    if (bodyScrollRef.current) observer?.observe(bodyScrollRef.current);
    if (bodyTableRef.current) observer?.observe(bodyTableRef.current);
    window.addEventListener("resize", updateHorizontalAffordance);

    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", updateHorizontalAffordance);
    };
  }, [settings, tableRows.length, updateHorizontalAffordance]);

  const handleBodyScroll = useCallback(() => {
    if (headerScrollRef.current && bodyScrollRef.current) {
      headerScrollRef.current.scrollLeft = bodyScrollRef.current.scrollLeft;
    }
    updateHorizontalAffordance();
  }, [updateHorizontalAffordance]);

  const mergedRef = useCallback(
    (node: HTMLDivElement | null) => {
      (
        tableInternalRef as React.MutableRefObject<HTMLDivElement | null>
      ).current = node;
      if (typeof ref === "function") ref(node);
      else if (ref)
        (ref as React.MutableRefObject<HTMLDivElement | null>).current = node;
    },
    [ref]
  );

  return (
    <div ref={mergedRef} className={wrapperClasses} style={style}>
      <div className="table-container">
        {showFixedSettingsHeader && (
          <div className="table-fixed-header" ref={headerScrollRef}>
            <table className="table">
              <TableColGroup
                headerGroups={tableHeaderGroups}
                hasExpandable={!!expandable}
                columnWidths={settingsHeaderColumnWidths}
              />
              <TableHeader
                headerGroups={tableHeaderGroups}
                hasExpandable={!!expandable}
                columnWidths={settingsHeaderColumnWidths}
              />
            </table>
          </div>
        )}
        <div
          className="table-scroll"
          style={scrollStyle}
          ref={bodyScrollRef}
          onScroll={showFixedSettingsHeader ? handleBodyScroll : undefined}
        >
          <table className="table" ref={bodyTableRef}>
            <TableColGroup
              headerGroups={tableHeaderGroups}
              hasExpandable={!!expandable}
            />
            {showHeader && !showFixedSettingsHeader && (
              <TableHeader
                headerGroups={tableHeaderGroups}
                hasExpandable={!!expandable}
              />
            )}
            <TableBody
              rows={tableRows}
              columns={columns}
              hasRowSelection={!!rowSelection}
              expandable={expandable}
              expandedRows={expandedRows}
              toggleRowExpand={toggleRowExpand}
              resolveRowKey={resolveRowKey}
              settings={settings}
              rowClassName={rowClassName}
              rowDataTestId={rowDataTestId}
              rowDataAttributes={rowDataAttributes}
              onRowClick={onRowClick}
              noDataElement={noDataElement}
            />
          </table>
        </div>
      </div>

      {pagination !== false && (
        <div
          className={
            renderPagination
              ? "flex h-10 w-full items-center border-t border-border-1 px-4"
              : "table-pagination-wrapper"
          }
        >
          <PaginationFooter
            pagination={pagination || {}}
            pageIndex={paginationState.pageIndex}
            pageSize={paginationState.pageSize}
            total={pagination?.total ?? data.length}
            pageCount={table.getPageCount()}
            canPreviousPage={table.getCanPreviousPage()}
            canNextPage={table.getCanNextPage()}
            onPageChange={handlePageChange}
            onPageSizeChange={handlePageSizeChange}
            renderPagination={renderPagination}
          />
        </div>
      )}
    </div>
  );
}

const Table = forwardRef(TableComponent) as <T = unknown>(
  props: TableProps<T> & { ref?: React.ForwardedRef<HTMLDivElement> }
) => ReturnType<typeof TableComponent>;

export default Table;
