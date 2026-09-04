import { type ReactNode, useMemo } from "react";
import { useTranslation } from "react-i18next";

import {
  PropertyDropdownField,
  type PropertyDropdownOption,
} from "@src/components/PropertyField/PropertyDropdownField";
import SettingsTable, {
  SETTINGS_TABLE_COL,
  type SettingsTableColumn,
  SettingsTablePagination,
} from "@src/components/SettingsTable";
import { SortIcon } from "@src/components/Table/helpers";

export const WORK_MANAGEMENT_TITLE_COLUMN_MAX_WIDTH = 550;

export type WorkManagementTableSortColumn = "id" | "updated";
export type WorkManagementTableSortOrder = "ascend" | "descend";

export interface WorkManagementTableSort {
  column: WorkManagementTableSortColumn;
  order: WorkManagementTableSortOrder;
}

export interface WorkManagementTableStatusSelect {
  value: string;
  label: string;
  icon: ReactNode;
  iconColor?: string;
  valueClassName?: string;
  options: PropertyDropdownOption<string>[];
  onChange: (value: string) => void | Promise<void>;
  readonly?: boolean;
  readonlyReason?: string;
  dataTestId?: string;
}

export interface WorkManagementTableRow {
  key: string;
  selection?: ReactNode;
  id: ReactNode;
  /** Primitive value used by the sortable ID column. Falls back to `id` or `key`. */
  idSortValue?: string | number;
  title: string;
  titleLinkOnRowHover?: boolean;
  contextLeading?: ReactNode;
  metadata?: ReactNode[];
  /** Lets the final context item absorb the remaining title-column width. */
  fillLastMetadata?: boolean;
  tags?: string[];
  assignee?: ReactNode;
  status?: ReactNode;
  statusSelect?: WorkManagementTableStatusSelect;
  ciStatus?: ReactNode;
  updated: ReactNode;
  actions?: ReactNode;
  onClick?: () => void;
}

export interface WorkManagementTablePagination {
  pageIndex: number;
  pageSize: number;
  total: number;
  pageCount: number;
  canPreviousPage: boolean;
  canNextPage: boolean;
  onPageChange: (pageIndex: number) => void;
  totalLabel?: ReactNode;
  pageLabel?: ReactNode;
  /** See {@link SettingsTablePagination}: page count only covers loaded pages. */
  openEndedPageCount?: boolean;
}

interface WorkManagementTableProps {
  rows: WorkManagementTableRow[];
  loading?: boolean;
  noDataElement?: ReactNode;
  pageSize?: number;
  pageSizeOptions?: number[];
  pagination?: WorkManagementTablePagination;
  /** Controlled cross-page sorting for remotely paginated surfaces. */
  sort?: WorkManagementTableSort;
  onSortChange?: (sort: WorkManagementTableSort) => void;
  testId?: string;
}

interface SortableColumnLabelProps {
  column: WorkManagementTableSortColumn;
  label: string;
  sort: WorkManagementTableSort;
  onSortChange: (sort: WorkManagementTableSort) => void;
}

function SortableColumnLabel({
  column,
  label,
  sort,
  onSortChange,
}: SortableColumnLabelProps): ReactNode {
  const active = sort.column === column;
  const sorted = active ? (sort.order === "descend" ? "desc" : "asc") : false;

  return (
    <button
      type="button"
      className="-my-2 inline-flex items-center gap-2 py-2 text-left"
      aria-label={label}
      aria-pressed={active}
      data-sort-column={column}
      onClick={() =>
        onSortChange({
          column,
          order: !active || sort.order === "ascend" ? "descend" : "ascend",
        })
      }
    >
      <span>{label}</span>
      <span className="table-sorter">
        <SortIcon size={14} sorted={sorted} />
      </span>
    </button>
  );
}

export function WorkManagementTable({
  rows,
  loading = false,
  noDataElement,
  pageSize,
  pageSizeOptions,
  pagination,
  sort,
  onSortChange,
  testId = "work-management-table",
}: WorkManagementTableProps): ReactNode {
  const { t } = useTranslation("common");
  const hasActions = rows.some((row) => row.actions !== undefined);
  const hasAssignees = rows.some((row) => row.assignee !== undefined);
  const hasCiStatus = rows.some((row) => row.ciStatus !== undefined);
  const hasSelection = rows.some((row) => row.selection !== undefined);
  const columns = useMemo<SettingsTableColumn<WorkManagementTableRow>[]>(() => {
    const idLabel = t("workManagementTable.columns.id", {
      defaultValue: "ID",
    });
    const updatedLabel = t("workManagementTable.columns.updated", {
      defaultValue: "Updated",
    });
    const controlledSort = sort && onSortChange;
    const tableColumns: SettingsTableColumn<WorkManagementTableRow>[] = [
      {
        key: "id",
        label: controlledSort ? (
          <SortableColumnLabel
            column="id"
            label={idLabel}
            sort={sort}
            onSortChange={onSortChange}
          />
        ) : (
          idLabel
        ),
        width: SETTINGS_TABLE_COL.hug,
        align: "left",
        sorter: controlledSort
          ? undefined
          : (left, right) => {
              const getSortValue = (row: WorkManagementTableRow) =>
                row.idSortValue ??
                (typeof row.id === "string" || typeof row.id === "number"
                  ? row.id
                  : row.key);
              return String(getSortValue(left)).localeCompare(
                String(getSortValue(right)),
                undefined,
                { numeric: true, sensitivity: "base" }
              );
            },
        renderCell: (row) => (
          <div className="min-w-0 self-start truncate text-left font-medium text-text-2 tabular-nums">
            {row.id}
          </div>
        ),
      },
      {
        key: "title",
        label: t("workManagementTable.columns.titleContext", {
          defaultValue: "Title / Context",
        }),
        width: `${WORK_MANAGEMENT_TITLE_COLUMN_MAX_WIDTH}px`,
        renderCell: (row) => (
          <div
            className="group/title w-full min-w-0"
            style={{ maxWidth: WORK_MANAGEMENT_TITLE_COLUMN_MAX_WIDTH }}
          >
            {row.onClick ? (
              <button
                type="button"
                className={`block w-full truncate text-left font-semibold text-text-1 ${
                  row.titleLinkOnRowHover
                    ? "transition-colors group-hover/title:text-primary-6 group-hover/title:underline group-hover/title:underline-offset-2"
                    : ""
                }`}
                title={row.title}
                onClick={row.onClick}
              >
                {row.title}
              </button>
            ) : (
              <div
                className={`truncate font-semibold text-text-1 ${
                  row.titleLinkOnRowHover
                    ? "transition-colors group-hover/title:text-primary-6 group-hover/title:underline group-hover/title:underline-offset-2"
                    : ""
                }`}
                title={row.title}
              >
                {row.title}
              </div>
            )}
            {row.contextLeading ||
            (row.metadata && row.metadata.length > 0) ||
            (row.tags && row.tags.length > 0) ? (
              <div className="mt-0.5 flex min-w-0 items-center gap-1 overflow-hidden">
                {row.contextLeading}
                {row.metadata?.map((item, index) => {
                  const fillsRemaining =
                    row.fillLastMetadata && index === row.metadata!.length - 1;
                  return (
                    <span
                      key={index}
                      className={`inline-flex min-w-0 items-center gap-1 text-[11px] text-text-1 ${
                        fillsRemaining ? "flex-1" : "shrink-0"
                      }`}
                    >
                      {index > 0 ? <span aria-hidden>·</span> : null}
                      <span
                        className={
                          fillsRemaining
                            ? "min-w-0 truncate"
                            : "max-w-40 truncate"
                        }
                      >
                        {item}
                      </span>
                    </span>
                  );
                })}
                {row.tags?.map((tag, index) => (
                  <span
                    key={`${tag}-${index}`}
                    className="inline-flex max-w-40 shrink-0 truncate rounded border border-border-1 px-1.5 py-px text-[10px] leading-none font-normal text-text-1"
                    title={tag}
                  >
                    {tag}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        ),
      },
    ];
    if (hasSelection) {
      tableColumns.unshift({
        key: "selection",
        label: "",
        width: SETTINGS_TABLE_COL.hug,
        align: "center",
        renderCell: (row) => (
          <div
            className="flex h-6 w-full items-center justify-center"
            data-work-management-selection
          >
            {row.selection}
          </div>
        ),
      });
    }
    if (hasAssignees) {
      tableColumns.push({
        key: "assignee",
        label: t("workManagementTable.columns.assignee", {
          defaultValue: "Assignee",
        }),
        width: SETTINGS_TABLE_COL.hug,
        align: "left",
        renderCell: (row) => (
          <div className="flex w-full justify-start">{row.assignee}</div>
        ),
      });
    }
    tableColumns.push({
      key: "status",
      label: t("workManagementTable.columns.status", {
        defaultValue: "Status",
      }),
      width: SETTINGS_TABLE_COL.valueLg,
      renderCell: (row) =>
        row.statusSelect ? (
          <div
            title={
              row.statusSelect.readonly
                ? row.statusSelect.readonlyReason
                : undefined
            }
          >
            <PropertyDropdownField
              {...row.statusSelect}
              searchable={false}
              maxWidthClassName="max-w-[140px]"
              triggerVariant="pill"
              fieldVariant="pill"
              compactPill
              idleSurface="fill"
              focusTreatment="field"
              placement="portal"
              borderless
            />
          </div>
        ) : (
          row.status
        ),
    });
    if (hasCiStatus) {
      tableColumns.push({
        key: "ciStatus",
        label: "CI",
        width: SETTINGS_TABLE_COL.valueMd,
        renderCell: (row) => row.ciStatus,
      });
    }
    tableColumns.push({
      key: "updated",
      label: controlledSort ? (
        <SortableColumnLabel
          column="updated"
          label={updatedLabel}
          sort={sort}
          onSortChange={onSortChange}
        />
      ) : (
        updatedLabel
      ),
      width: SETTINGS_TABLE_COL.valueMd,
      renderCell: (row) => (
        <span className="whitespace-nowrap text-text-3">{row.updated}</span>
      ),
    });
    if (hasActions) {
      tableColumns.push({
        key: "actions",
        label: "",
        width: SETTINGS_TABLE_COL.hug,
        align: "right",
        renderCell: (row) => row.actions,
      });
    }
    return tableColumns;
  }, [
    hasActions,
    hasAssignees,
    hasCiStatus,
    hasSelection,
    onSortChange,
    sort,
    t,
  ]);
  const footer = pagination ? (
    <div className="flex h-10 shrink-0 items-center border-t border-border-1 px-4">
      <SettingsTablePagination
        {...pagination}
        onPageSizeChange={() => undefined}
        showTotal={pagination.totalLabel !== undefined}
        showPageSize={false}
      />
    </div>
  ) : undefined;

  return (
    <div className="h-full min-h-0 w-full" data-testid={testId}>
      <SettingsTable<WorkManagementTableRow>
        columns={columns}
        rows={rows}
        getRowKey={(row) => row.key}
        surfaceVariant="transparent"
        fillHeight
        hover
        loading={loading}
        noDataElement={noDataElement}
        pageSize={pageSize}
        pageSizeOptions={pageSizeOptions}
        footer={footer}
        onRowClick={(row) => row.onClick?.()}
        rowClassName="group"
        className={`table-settings-page-list-hover [&_.table-fixed-header]:scrollbar-hide [&_.table-row_.table-td:first-child]:align-top! [&_.table-row_.table-td:first-child_.table-td-inner]:items-start! [&_.table-scroll]:scrollbar-hide [&_.table-td]:h-auto! [&_.table-td]:py-1.5! [&_.table-td-inner]:h-auto! [&_.table-td-inner]:w-full ${
          hasSelection
            ? "[&_.table-row_.table-td:nth-child(2)]:align-top! [&_.table-row_.table-td:nth-child(2)_.table-td-inner]:items-start!"
            : ""
        }`}
      />
    </div>
  );
}
