import React, {
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import Input from "@src/components/Input";
import { Placeholder } from "@src/components/Placeholder";
import Select from "@src/components/Select";
import type { SelectOption, SelectProps } from "@src/components/Select";
import Table, { type TableColumn } from "@src/components/Table";
import Tooltip from "@src/components/Tooltip";
import {
  FilterIcon,
  HugeiconsIcon,
  InformationCircleIcon,
  Search01Icon,
} from "@src/icons";

import SearchSortBar, { type SearchSortBarProps } from "./SearchSortBar";
import {
  SettingsTableAddFooter,
  type SettingsTableAddFooterProps,
} from "./SettingsTableAddFooter";
import { SettingsTablePagination } from "./SettingsTablePagination";

/**
 * Settings Table Cell Tokens
 *
 * All text inside SettingsTable cells inherits font-size: 13px
 * from `.table-settings .table-td` — never override with text-sm/text-xs
 * for regular cell content.
 *
 * Usage:
 * ```tsx
 * import { SETTINGS_TABLE_CELL } from "@src/components/SettingsTable";
 *
 * renderCell: (row) => <span className={SETTINGS_TABLE_CELL.primary}>{row.name}</span>
 * renderCell: (row) => <span className={SETTINGS_TABLE_CELL.value}>{row.size}</span>
 * ```
 */
export const SETTINGS_TABLE_CELL = {
  /** Primary label — first column or main identifier */
  primary: "text-text-1",
  /** Primary label with leading icon */
  primaryIcon: "inline-flex items-center gap-1.5 text-text-1",
  /** Data value — secondary columns like size, version */
  value: "text-text-2",
  /** Muted value — tertiary columns like percentage */
  muted: "text-text-3",
  /** Subtitle under primary text — deliberately smaller */
  subtitle: "text-xs text-text-3",
  /** Status row with icon + label inline */
  statusRow: "inline-flex items-center gap-1.5",
} as const;

/**
 * Column width presets for SettingsTable.
 *
 * | Token        | Use for                            | Sizing            |
 * |--------------|------------------------------------|--------------------|
 * | `fill`       | Primary text / label column        | Absorbs remaining  |
 * | `valueSm`    | Short values: "0 B", "Yes", status | Hug content        |
 * | `valueMd`    | Sized values: "93.4 MB", "77.8%"   | Comfortable fixed  |
 * | `valueLg`    | Spread-out tables (e.g. DB)       | 140px              |
 * | `hug`        | Action buttons, icon-only columns  | Shrink-wrap        |
 * | `control`    | Column with Select/Input           | Shrink-wrap        |
 * | `controlStyle` | Inline style for the control     | Fixed 200px        |
 *
 * All value/hug columns pair with `whitespace-nowrap` on cell content.
 */
export const SETTINGS_TABLE_COL = {
  /** Primary column — absorbs remaining space (auto layout distributes leftover here) */
  fill: "",
  /** Small value — version, status dot, short text — hug content */
  valueSm: "1%",
  /** Medium value — "93.4 MB", "77.8%" — guaranteed minimum width */
  valueMd: "110px",
  /** Large value — spread-out tables (e.g. DB clients) */
  valueLg: "140px",
  /** Shrink-wrap column — action buttons, icons */
  hug: "1%",
  /** Column containing a Select or Input — shrink-wraps around the control */
  control: "1%",
  /** Inline style for the Select/Input inside a control column */
  controlStyle: { width: 200 } as React.CSSProperties,
} as const;

export interface SettingsTableColumn<RowData> {
  key: string;
  label: ReactNode;
  width?: React.CSSProperties["width"];
  align?: "left" | "center" | "right";
  /** Legacy: SettingsTable now preserves columns and relies on internal horizontal scrolling. */
  hideBelow?: "sm" | "md";
  sorter?: boolean | ((rowA: RowData, rowB: RowData) => number);
  renderCell: (rowData: RowData) => ReactNode;
  /** When provided, appends an info icon with tooltip after cell content. */
  cellInfoTooltip?: (rowData: RowData) => string | undefined;
}

/** Select filter descriptor for the search bar area. */
export interface SettingsTableSelectFilter {
  key: string;
  value: string | number;
  /** The "all / unfiltered" value. When `value !== defaultValue` the trigger text turns primary-6. */
  defaultValue: string | number;
  options: SelectOption[];
  onChange: (value: string | number) => void;
  minWidth?: number;
  /** Defaults to the compact toolbar's ghost appearance. */
  appearance?: SelectProps["appearance"];
}

interface SettingsTablePaginationContext {
  pageIndex: number;
  pageSize: number;
  total: number;
  pageCount: number;
  canPreviousPage: boolean;
  canNextPage: boolean;
  onPageChange: (pageIndex: number) => void;
  onPageSizeChange: (pageSize: number) => void;
}

export type SettingsTableSurfaceVariant = "default" | "transparent";

export type SettingsTableBodySurface = "raised" | "pane";

export interface SettingsTableProps<RowData> {
  columns: SettingsTableColumn<RowData>[];
  rows: RowData[];
  getRowKey: (rowData: RowData) => string;
  /** Header height: "compact" (32px, default) for nested tables, "tall" (40px) for standalone */
  headerHeight?: "compact" | "tall";
  /** When false, hides the column header row. Default: true */
  showHeader?: boolean;
  /** Vertical alignment for header and body cells. Default: middle. */
  cellVerticalAlign?: "middle" | "top";
  /** Reduce row padding for cells containing 32px form controls (Input/Button) */
  dense?: boolean;
  /** When set, enables client-side pagination with the given page size */
  pageSize?: number;
  /** Page size options for the size-changer Select. Default: [10, 20, 50, 100] */
  pageSizeOptions?: number[];
  /** Custom pagination footer. When provided, replaces the default footer. */
  paginationFooter?: (ctx: SettingsTablePaginationContext) => React.ReactNode;
  /** Expandable row config — renders detail content below a row when toggled.
   *  Return ReactNode for free-form content, or ReactNode[][] for column-aligned sub-rows. */
  expandable?: {
    expandedRowRender?: (
      record: RowData
    ) => React.ReactNode | React.ReactNode[][];
    rowExpandable?: (record: RowData) => boolean;
    expandedRowKeys?: string[];
    onExpandedRowsChange?: (keys: string[]) => void;
    onSubRowClick?: (parentRecord: RowData, subRowIndex: number) => void;
  };
  /** Table-level loading overlay; keeps header, toolbar, and columns visible. */
  loading?: boolean;
  /** Custom title for the empty state Placeholder. */
  emptyTitle?: string;
  /** Custom subtitle for the empty state Placeholder. */
  emptySubtitle?: string;
  /** Action button shown below the empty state (e.g. Add). */
  emptyAction?: {
    label: string;
    onClick: () => void;
    type?: "primary" | "secondary";
  };
  /** Empty state shown while loading is false. Useful to suppress premature empty placeholders during first load. */
  noDataElement?: React.ReactNode;
  /** Footer rendered below the table (e.g. "+ Add" button). */
  footer?: React.ReactNode;
  /** Shorthand for a standard "+ Add" footer button. Ignored when `footer` is provided. */
  addFooter?: SettingsTableAddFooterProps;
  /** Sticky search bar rendered above the table header. Both stick together when scrolling. */
  searchBar?: SearchSortBarProps;
  /** Extra classes for the sticky search/header wrapper. */
  searchHeaderClassName?: string;
  /** Select filter row rendered below the search bar. Each entry uses the regular 32px Select size. */
  selectFilters?: SettingsTableSelectFilter[];
  /** Extra inline content rendered at the end of the {@link selectFilters} row
   *  (e.g. a scope TabPill). Renders only when this prop or `selectFilters`
   *  has content. */
  selectFiltersExtra?: ReactNode;
  /** When true, filters/pills and search share one 32px row when space allows, then split into search/actions above filters. Default: false. */
  inlineHeaderToolbar?: boolean;
  /** When false, disables sticky table header. Default: true */
  stickyHeader?: boolean;
  /** When true, pins the first (label) column while scrolling horizontally. */
  stickyFirstColumn?: boolean;
  /** When true, shows a border below the header row. Default: false */
  headerBorder?: boolean;
  /** When true, removes horizontal cell padding on outer edges (first-child left, last-child right).
   *  Use for tables nested inside SectionContainer which already provides px-4. */
  noPx?: boolean;
  /** Row click handler. Clicks on interactive elements (buttons, links, inputs) are ignored. */
  onRowClick?: (row: RowData) => void;
  /** Enable row hover highlight. Default: false */
  hover?: boolean;
  /** Optional class or function for row styling (e.g. selected highlight) */
  rowClassName?: string | ((row: RowData, index: number) => string);
  rowDataTestId?: (row: RowData, index: number) => string | undefined;
  rowDataAttributes?: (
    row: RowData,
    index: number
  ) => Record<string, string | number | boolean | undefined> | undefined;
  surfaceVariant?: SettingsTableSurfaceVariant;
  /** Body surface treatment. "raised" (default) keeps the title row and rows
   *  on the raised table surface; "pane" blends them into the surrounding
   *  page/chat pane — the exception used by the GitHub PR/issue and
   *  work-item tables. */
  bodySurface?: SettingsTableBodySurface;
  /** Fill the parent flex column and scroll rows inside the table body. */
  fillHeight?: boolean;
  /** Cap table height and scroll rows inside the body. */
  maxHeight?: number | string;
  className?: string;
  rootClassName?: string;
}

function SettingsTableToolbar({
  searchBar,
  selectFilters,
  selectFiltersExtra,
}: {
  searchBar?: SearchSortBarProps;
  selectFilters?: SettingsTableSelectFilter[];
  selectFiltersExtra?: ReactNode;
}) {
  const { t } = useTranslation();

  const effectiveTabPills = searchBar?.filterConfig?.expanded
    ? searchBar.filterConfig.pills
    : searchBar?.tabPills;

  const filterConfig = searchBar?.filterConfig;
  const showSort =
    searchBar &&
    typeof searchBar.sortValue === "string" &&
    Array.isArray(searchBar.sortOptions) &&
    searchBar.sortOptions.length > 0 &&
    typeof searchBar.onSortChange === "function";

  const hasInlineSearch =
    searchBar?.onSearchChange != null &&
    searchBar.searchPlaceholder != null &&
    searchBar.searchValue !== undefined;

  const filterButton = filterConfig ? (
    <Button
      variant="secondary"
      iconOnly
      onClick={filterConfig.onToggle}
      icon={
        <HugeiconsIcon
          icon={FilterIcon}
          data-icon="filter"
          size={14}
          className={filterConfig.active ? "text-primary-6" : ""}
        />
      }
      title={filterConfig.title ?? t("actions.filter")}
    />
  ) : undefined;
  const hasRightControls =
    !!selectFiltersExtra ||
    !!filterButton ||
    !!showSort ||
    !!hasInlineSearch ||
    !!searchBar?.rightContent;

  return (
    <div className="flex min-w-0 flex-col gap-2 pb-2 pt-2 @[640px]:flex-row @[640px]:items-center">
      <div className="order-2 w-full min-w-0 overflow-x-auto overflow-y-hidden @[640px]:order-1 @[640px]:w-auto @[640px]:flex-none">
        <div className="flex w-max min-w-full items-center gap-2">
          {searchBar?.leftContent}
          {selectFilters?.map((filter) => {
            const isActive = filter.value !== filter.defaultValue;
            return (
              <Select
                key={filter.key}
                value={filter.value}
                options={filter.options}
                onChange={(val) => filter.onChange(val as string | number)}
                appearance={filter.appearance ?? "ghost"}
                dropdownWidthMode="auto"
                dropdownMinWidth={filter.minWidth ?? 120}
                className={isActive ? "text-primary-6" : ""}
              />
            );
          })}
          {effectiveTabPills ? (
            <div className="flex min-w-0 shrink-0 items-center gap-2">
              {effectiveTabPills}
            </div>
          ) : null}
          {searchBar?.searchCountText ? (
            <span className="text-[13px] font-semibold text-text-1">
              {searchBar.searchCountText}
            </span>
          ) : null}
        </div>
      </div>
      {hasRightControls ? (
        <div className="order-1 flex w-full min-w-0 items-center justify-end gap-2 @[640px]:order-2 @[640px]:flex-1">
          {selectFiltersExtra ? (
            <div className="flex shrink-0 items-center">
              {selectFiltersExtra}
            </div>
          ) : null}
          {filterButton}
          {showSort && searchBar ? (
            <div className={searchBar.sortWidthClassName ?? "w-[180px]"}>
              <Select
                value={searchBar.sortValue}
                onChange={searchBar.onSortChange}
                options={searchBar.sortOptions}
              />
            </div>
          ) : null}
          {hasInlineSearch && searchBar ? (
            <div className="min-w-0 flex-1">
              <Input
                type="search"
                size={searchBar.searchInputSize ?? "default"}
                className="w-full min-w-0"
                value={searchBar.searchValue ?? ""}
                placeholder={searchBar.searchPlaceholder}
                prefix={
                  <HugeiconsIcon
                    icon={Search01Icon}
                    data-icon="search"
                    size={14}
                    className="text-text-3"
                    aria-hidden
                  />
                }
                onChange={(value) => searchBar.onSearchChange?.(value)}
                allowClear={searchBar.allowSearchClear ?? true}
                onClear={searchBar.onSearchClear}
              />
            </div>
          ) : null}
          {searchBar?.rightContent ? (
            <div className="flex shrink-0 items-center gap-2">
              {searchBar.rightContent}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function SelectFilterRow({
  filters,
  extra,
  hasSearchBarAbove,
}: {
  filters: SettingsTableSelectFilter[];
  extra?: ReactNode;
  hasSearchBarAbove: boolean;
}) {
  return (
    <div
      className={`min-w-0 overflow-x-auto overflow-y-hidden px-1 pb-1 ${hasSearchBarAbove ? "" : "pt-1"}`}
    >
      <div className="flex w-max min-w-full items-center gap-2">
        {filters.map((filter) => {
          const isActive = filter.value !== filter.defaultValue;
          return (
            <Select
              key={filter.key}
              value={filter.value}
              options={filter.options}
              onChange={(val) => filter.onChange(val as string | number)}
              appearance={filter.appearance ?? "ghost"}
              dropdownWidthMode="auto"
              dropdownMinWidth={filter.minWidth ?? 120}
              className={isActive ? "text-primary-6" : ""}
            />
          );
        })}
        {extra ? (
          <div className="flex shrink-0 items-center">{extra}</div>
        ) : null}
      </div>
    </div>
  );
}

export default function SettingsTable<RowData>({
  columns,
  rows,
  getRowKey,
  headerHeight = "compact",
  showHeader = true,
  cellVerticalAlign = "middle",
  dense = false,
  pageSize,
  pageSizeOptions,
  paginationFooter,
  expandable,
  loading = false,
  emptyTitle,
  emptySubtitle,
  emptyAction,
  noDataElement,
  footer,
  addFooter,
  searchBar,
  searchHeaderClassName = "",
  selectFilters,
  selectFiltersExtra,
  inlineHeaderToolbar = false,
  stickyHeader = true,
  stickyFirstColumn = false,
  headerBorder = false,
  noPx = false,
  onRowClick,
  hover = false,
  rowClassName,
  rowDataTestId,
  rowDataAttributes,
  surfaceVariant = "default",
  bodySurface = "raised",
  fillHeight = false,
  maxHeight,
  className = "",
  rootClassName = "",
}: SettingsTableProps<RowData>) {
  const searchRef = useRef<HTMLDivElement>(null);
  const [searchHeight, setSearchHeight] = useState(0);
  const hasSelectFilterRow =
    (!!selectFilters && selectFilters.length > 0) || !!selectFiltersExtra;
  const hasSearchBar = !!searchBar || hasSelectFilterRow;

  useEffect(() => {
    const el = searchRef.current;
    if (!el) return;

    const measure = () => setSearchHeight(el.offsetHeight);
    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasSearchBar]);

  const resolvedFooter =
    footer ??
    (addFooter ? (
      <SettingsTableAddFooter {...addFooter} noPx={addFooter.noPx ?? noPx} />
    ) : null);
  const tableColumns = useMemo<TableColumn<RowData>[]>(
    () =>
      columns.map((column) => ({
        key: column.key,
        dataIndex: column.key,
        title: column.label,
        width: column.width,
        align: column.align,
        sorter: column.sorter,
        render: (_value, rowData) => {
          const cell = column.renderCell(rowData);
          const tooltip = column.cellInfoTooltip?.(rowData);
          if (!tooltip) return cell;
          return (
            <div className="flex items-center gap-1.5">
              {cell}
              <Tooltip
                content={
                  <span style={{ whiteSpace: "pre-line" }}>{tooltip}</span>
                }
                position="top"
                showArrow={false}
              >
                <span className="flex cursor-help items-center p-1">
                  <HugeiconsIcon
                    icon={InformationCircleIcon}
                    data-icon="info"
                    size={14}
                    className="text-text-3"
                  />
                </span>
              </Tooltip>
            </div>
          );
        },
      })),
    [columns]
  );

  const needsPagination = pageSize != null && rows.length > pageSize;
  const showEmptyFooter = !needsPagination && resolvedFooter == null;
  const hasBottomFooter =
    needsPagination || resolvedFooter != null || showEmptyFooter;
  const containedScroll = fillHeight || maxHeight != null;
  const heightClass = headerHeight === "tall" ? "table-settings-tall" : "";
  const denseClass = dense ? "table-settings-dense" : "";
  const noStickyClass = !stickyHeader ? "table-settings-no-sticky" : "";
  const headerBorderClass = headerBorder ? "table-settings-header-border" : "";
  const noHeaderClass = !showHeader ? "table-settings-no-header" : "";
  const noPxClass = noPx ? "table-settings-no-px" : "";
  const cellVAlignClass =
    cellVerticalAlign === "top" ? "table-settings-cell-top" : "";
  const combinedClassName = [
    heightClass,
    denseClass,
    noStickyClass,
    headerBorderClass,
    noHeaderClass,
    noPxClass,
    cellVAlignClass,
    fillHeight && "table-settings-fill-height",
    maxHeight != null && "table-settings-fill-height",
    containedScroll && "table-settings-contained-scroll",
    stickyFirstColumn && "table-settings-sticky-first-col",
    bodySurface === "pane" && "table-settings-pane-body",
    !hasSearchBar &&
      surfaceVariant !== "transparent" &&
      "table-settings-rounded-top",
    !hasBottomFooter && "table-settings-no-footer",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  const paginationRenderer = useMemo(() => {
    if (!needsPagination) return undefined;
    if (paginationFooter) return paginationFooter;
    return function SettingsTablePaginationRenderer(
      ctx: SettingsTablePaginationContext
    ) {
      return (
        <SettingsTablePagination {...ctx} pageSizeOptions={pageSizeOptions} />
      );
    };
  }, [needsPagination, paginationFooter, pageSizeOptions]);

  const hasHeader = !!searchBar || hasSelectFilterRow;
  const surfaceClassName =
    surfaceVariant === "transparent"
      ? "settings-table-root-transparent"
      : "settings-table-root-default bg-primary-container";
  // Standalone tables get an outer border. Tables flagged `noPx` are embedded
  // inside a SectionContainer that already draws the border — skip it there to
  // avoid a double border.
  const hasOuterBorder = surfaceVariant !== "transparent" && !noPx;
  // Page-scrolled tables with a sticky header: the header must carry the top
  // border + radius itself so they stay pinned while scrolling (the root scrolls
  // away). The header's side borders are pulled out by 1px (-mx-px) so they sit
  // exactly on top of the root's side borders — otherwise the two 12px arcs land
  // 1px apart and the corner renders a doubled/offset curve.
  // Contained-scroll tables (fillHeight/maxHeight) clip via overflow-hidden, so
  // the root can keep the full border with clean corners — no split needed.
  const stickyBordered = hasOuterBorder && hasHeader && !containedScroll;
  const rootClasses = [
    "settings-table-root min-w-0 max-w-full",
    surfaceVariant !== "transparent" && "rounded-xl",
    hasOuterBorder &&
      (stickyBordered
        ? "border-x border-b border-border-1"
        : "border border-border-1"),
    fillHeight && "flex h-full min-h-0 flex-col overflow-hidden",
    maxHeight != null && "flex min-h-0 flex-col overflow-hidden",
    surfaceClassName,
    rootClassName,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={rootClasses}
      style={{
        ...(hasHeader && !containedScroll
          ? ({ "--search-bar-h": `${searchHeight}px` } as React.CSSProperties)
          : {}),
        ...(maxHeight != null ? { maxHeight } : {}),
      }}
    >
      {hasHeader && (
        <div
          ref={searchRef}
          className={`${containedScroll ? "shrink-0" : "settings-table-sticky-toolbar"} ${stickyBordered ? "settings-table-sticky-mask bg-bg-2" : ""}`.trim()}
        >
          <div
            className={`${stickyBordered ? "settings-table-sticky-surface -mx-px border-x border-t border-border-1" : ""} border-b border-border-1 px-4 ${surfaceVariant !== "transparent" ? "rounded-t-xl" : ""} ${surfaceClassName} ${searchHeaderClassName}`.trim()}
          >
            {inlineHeaderToolbar ? (
              <SettingsTableToolbar
                searchBar={searchBar}
                selectFilters={selectFilters}
                selectFiltersExtra={selectFiltersExtra}
              />
            ) : (
              <>
                {searchBar && <SearchSortBar {...searchBar} noPadding />}
                {hasSelectFilterRow && (
                  <SelectFilterRow
                    filters={selectFilters ?? []}
                    extra={selectFiltersExtra}
                    hasSearchBarAbove={!!searchBar}
                  />
                )}
              </>
            )}
          </div>
        </div>
      )}
      <Table<RowData>
        columns={tableColumns}
        data={rows}
        rowKey={getRowKey}
        showHeader={showHeader}
        pagination={needsPagination ? { pageSize } : false}
        renderPagination={paginationRenderer}
        hover={hover}
        stripe={false}
        border={false}
        settings
        size="small"
        className={combinedClassName}
        loading={loading}
        expandable={expandable}
        onRowClick={
          onRowClick ? (record: RowData) => onRowClick(record) : undefined
        }
        rowClassName={rowClassName}
        rowDataTestId={rowDataTestId}
        rowDataAttributes={rowDataAttributes}
        noDataElement={
          noDataElement ??
          (loading ? (
            <div className="min-h-[120px]" />
          ) : (
            <Placeholder
              variant="empty"
              title={emptyTitle}
              subtitle={emptySubtitle}
              action={emptyAction}
            />
          ))
        }
      />
      {resolvedFooter}
      {showEmptyFooter && (
        <div
          className={`settings-table-empty-footer ${bodySurface === "pane" ? "settings-table-empty-footer-pane" : ""}`.trim()}
        />
      )}
    </div>
  );
}
export { SettingsTableLoadMoreFooter } from "./SettingsTableLoadMoreFooter";
export { SettingsTablePagination } from "./SettingsTablePagination";
