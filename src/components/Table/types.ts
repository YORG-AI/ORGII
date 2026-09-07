import type { CSSProperties, ReactNode } from "react";

export interface ColumnMeta {
  align?: "left" | "center" | "right";
  width?: string | number;
  hideBelow?: "sm" | "md";
}

export interface TableColumn<T = unknown> {
  /** Column data key */
  dataIndex?: string;
  /** Column title */
  title?: ReactNode;
  /** Column key (unique identifier) */
  key?: string;
  /** Column width */
  width?: number | string;
  /** Enable sorting */
  sorter?: boolean | ((itemA: T, itemB: T) => number);
  /** Custom render function */
  render?: (value: unknown, record: T, index: number) => ReactNode;
  /** Align content */
  align?: "left" | "center" | "right";
  /** Fixed column */
  fixed?: "left" | "right";
  /** Enable filtering */
  filterable?: boolean;
  /** Default sort order */
  defaultSortOrder?: "ascend" | "descend";
  /** Hide this column when the table container is narrower than the breakpoint. */
  hideBelow?: "sm" | "md";
}

export interface TablePagination {
  /** Current page */
  current?: number;
  /** Page size */
  pageSize?: number;
  /** Total items */
  total?: number;
  /** Show size changer */
  showSizeChanger?: boolean;
  /** Page size options */
  pageSizeOptions?: number[];
  /** Show quick jumper */
  showQuickJumper?: boolean;
  /** Position */
  position?: "top" | "bottom" | "both";
}

export interface TableSorting {
  column: string;
  order: "ascend" | "descend";
}

export interface PaginationRenderContext {
  pageIndex: number;
  pageSize: number;
  total: number;
  pageCount: number;
  canPreviousPage: boolean;
  canNextPage: boolean;
  onPageChange: (pageIndex: number) => void;
  onPageSizeChange: (pageSize: number) => void;
}

export interface TableProps<T = unknown> {
  columns: TableColumn<T>[];
  data?: T[];
  /** @default 'id' */
  rowKey?: string | ((record: T) => string);
  loading?: boolean;
  /** @default true */
  showHeader?: boolean;
  pagination?: false | TablePagination;
  /** Controlled single-column sort state. Omit to keep Table-local sorting. */
  sorting?: TableSorting | null;
  onSortingChange?: (sorting: TableSorting | null) => void;
  onChange?: (
    pagination: TablePagination,
    filters: Record<string, unknown>,
    sorter: unknown
  ) => void;
  rowSelection?: {
    selectedRowKeys?: string[];
    onChange?: (selectedRowKeys: string[], selectedRows: T[]) => void;
    onSelect?: (selected: boolean, record: T, selectedRows: T[]) => void;
    checkboxProps?: (record: T) => { disabled?: boolean };
    type?: "checkbox" | "radio";
  };
  /** @default true */
  hover?: boolean;
  stripe?: boolean;
  /** @default 'default' */
  size?: "mini" | "small" | "default" | "large";
  /** @default false */
  border?:
    | boolean
    | {
        wrapper?: boolean;
        cell?: boolean;
      };
  noDataElement?: ReactNode;
  rowClassName?: string | ((record: T, index: number) => string);
  rowDataTestId?: (record: T, index: number) => string | undefined;
  rowDataAttributes?: (
    record: T,
    index: number
  ) => Record<string, string | number | boolean | undefined> | undefined;
  className?: string;
  style?: CSSProperties;
  scroll?: {
    x?: number | string;
    y?: number | string;
  };
  expandable?: {
    /**
     * Return ReactNode for free-form content in a colSpan cell,
     * or ReactNode[][] for aligned sub-rows (one inner array per row,
     * one element per parent column — the expand column is auto-prepended).
     */
    expandedRowRender?: (record: T) => ReactNode | ReactNode[][];
    rowExpandable?: (record: T) => boolean;
    expandedRowKeys?: string[];
    onExpandedRowsChange?: (keys: string[]) => void;
    /** Click handler for aligned sub-rows (ReactNode[][] mode).
     *  Clicks originating from interactive elements are skipped. */
    onSubRowClick?: (parentRecord: T, subRowIndex: number) => void;
  };
  /** Apply Settings-page visual preset */
  settings?: boolean;
  /**
   * Row click handler. Skips clicks originating from interactive elements
   * (button, a, input, select).
   */
  onRowClick?: (record: T, index: number) => void;
  renderPagination?: (ctx: PaginationRenderContext) => ReactNode;
}
