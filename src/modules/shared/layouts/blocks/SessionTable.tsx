import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import SettingsTable from "@src/components/SettingsTable";
import type {
  SettingsTableBodySurface,
  SettingsTableColumn,
  SettingsTableSurfaceVariant,
} from "@src/components/SettingsTable";

export interface SessionTableItem {
  id: string;
  title: React.ReactNode;
  description?: React.ReactNode;
  statusLabel: React.ReactNode;
  statusColor?: string;
  ownerLabel?: React.ReactNode;
  agentIcon?: React.ReactNode;
  agentLabel?: React.ReactNode;
  modelIcon?: React.ReactNode;
  modelLabel?: React.ReactNode;
  workspaceLabel?: React.ReactNode;
  workspaceTitle?: string;
  impactLabel?: React.ReactNode;
  filesChangedLabel?: React.ReactNode;
  relatedCommitsLabel?: React.ReactNode;
  committedRateLabel?: React.ReactNode;
  committedRateValue?: number;
  tokensLabel?: React.ReactNode;
  tokensValue?: number;
  startedLabel?: React.ReactNode;
  lastUpdatedLabel?: React.ReactNode;
  active?: boolean;
  disabled?: boolean;
  testId?: string;
  dataAttributes?: Record<string, string | number | boolean | undefined>;
  /**
   * Optional trailing per-row action (e.g. the collab panel's fork button).
   * The actions column only renders when at least one item provides this;
   * clicks inside it do not trigger the row's `onSelect`.
   */
  rowAction?: React.ReactNode;
}

export type SessionTableColumnKey =
  | "name"
  | "status"
  | "owner"
  | "agent"
  | "model"
  | "workspace"
  | "impact"
  | "filesChanged"
  | "relatedCommits"
  | "committedRate"
  | "tokens"
  | "started"
  | "lastUpdated"
  | "actions";

export type SessionTableColumnOverrides = Partial<
  Record<
    SessionTableColumnKey,
    Partial<Pick<SettingsTableColumn<SessionTableItem>, "label" | "width">>
  >
>;

/**
 * Preserve established table layouts while allowing the Kanban list to opt
 * into its token-usage column. Row actions remain visible whenever supplied.
 */
const DEFAULT_COLUMN_VISIBILITY: Record<SessionTableColumnKey, boolean> = {
  name: true,
  status: true,
  owner: false,
  agent: true,
  model: true,
  workspace: true,
  impact: true,
  filesChanged: true,
  relatedCommits: true,
  committedRate: true,
  tokens: false,
  started: true,
  lastUpdated: true,
  actions: true,
};

export interface SessionTableProps {
  items: SessionTableItem[];
  onSelect?: (item: SessionTableItem) => void;
  className?: string;
  rootClassName?: string;
  surfaceVariant?: SettingsTableSurfaceVariant;
  bodySurface?: SettingsTableBodySurface;
  headerBorder?: boolean;
  showSearch?: boolean;
  fillHeight?: boolean;
  maxHeight?: number | string;
  pageSize?: number;
  pageSizeOptions?: number[];
  /** Per-column overrides merged over the shared visibility defaults. */
  columnVisibility?: Partial<Record<SessionTableColumnKey, boolean>>;
  /** Optional presentation overrides for consumers with a denser column. */
  columnOverrides?: SessionTableColumnOverrides;
  /** Override the shared Member label when owner means a more precise role. */
  ownerColumnLabel?: React.ReactNode;
}

const EMPTY_CELL = "—";
const OWNER_NAME_MAX_CHARACTERS = 12;

export function truncateSessionOwnerLabel(
  value: React.ReactNode | undefined
): React.ReactNode | undefined {
  if (typeof value !== "string") return value;
  const characters = Array.from(value);
  return characters.length > OWNER_NAME_MAX_CHARACTERS
    ? `${characters.slice(0, OWNER_NAME_MAX_CHARACTERS).join("")}…`
    : value;
}

function toSearchText(value: React.ReactNode | undefined): string {
  if (value == null) return "";
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : "";
}

function compareSessionText(
  left: React.ReactNode | undefined,
  right: React.ReactNode | undefined
): number {
  return toSearchText(left).localeCompare(toSearchText(right), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function matchesSessionSearch(
  item: SessionTableItem,
  searchQuery: string
): boolean {
  const normalizedQuery = searchQuery.trim().toLowerCase();
  if (!normalizedQuery) return true;

  const haystack = [
    item.id,
    toSearchText(item.title),
    toSearchText(item.description),
    toSearchText(item.statusLabel),
    toSearchText(item.ownerLabel),
    toSearchText(item.agentLabel),
    toSearchText(item.modelLabel),
    toSearchText(item.workspaceLabel),
    toSearchText(item.impactLabel),
    toSearchText(item.filesChangedLabel),
    toSearchText(item.relatedCommitsLabel),
    toSearchText(item.committedRateLabel),
    toSearchText(item.tokensLabel),
    toSearchText(item.startedLabel),
    toSearchText(item.lastUpdatedLabel),
  ]
    .join(" ")
    .toLowerCase();

  return haystack.includes(normalizedQuery);
}

export const SessionTable: React.FC<SessionTableProps> = ({
  items,
  onSelect,
  className,
  rootClassName,
  surfaceVariant = "transparent",
  bodySurface,
  headerBorder = true,
  showSearch,
  fillHeight = false,
  maxHeight,
  pageSize,
  pageSizeOptions,
  columnVisibility,
  columnOverrides,
  ownerColumnLabel,
}) => {
  const { t } = useTranslation(["sessions", "common"]);
  const [searchQuery, setSearchQuery] = useState("");
  const shouldShowSearch = showSearch ?? true;
  const hasRowActions = items.some((item) => item.rowAction != null);

  const columns = useMemo<SettingsTableColumn<SessionTableItem>[]>(() => {
    const availableColumns: Array<
      SettingsTableColumn<SessionTableItem> & { key: SessionTableColumnKey }
    > = [
      {
        key: "name",
        label: t("common:labels.name"),
        width: "250px",
        sorter: (left, right) => compareSessionText(left.title, right.title),
        renderCell: (item) => (
          <div className="flex max-w-[250px] min-w-0 items-center gap-2">
            <span className="min-w-0 truncate font-medium text-text-1">
              {item.title}
            </span>
          </div>
        ),
      },
      {
        key: "status",
        label: t("common:labels.status"),
        width: "95px",
        renderCell: (item) => (
          <div className="flex min-w-0 items-center gap-2 text-text-2">
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{
                backgroundColor: item.statusColor ?? "var(--color-fill-4)",
              }}
            />
            <span className="truncate">{item.statusLabel}</span>
          </div>
        ),
      },
      {
        key: "owner",
        label: ownerColumnLabel ?? t("common:filters.member"),
        width: "140px",
        sorter: (left, right) =>
          compareSessionText(left.ownerLabel, right.ownerLabel),
        renderCell: (item) => (
          <div
            className="min-w-0 truncate text-text-2"
            title={
              typeof item.ownerLabel === "string" ? item.ownerLabel : undefined
            }
          >
            {truncateSessionOwnerLabel(item.ownerLabel) ?? EMPTY_CELL}
          </div>
        ),
      },
      {
        key: "agent",
        label: t("common:terminology.agent"),
        width: "130px",
        sorter: (left, right) =>
          compareSessionText(left.agentLabel, right.agentLabel),
        renderCell: (item) => (
          <div className="flex min-w-0 items-center gap-2 text-text-2">
            {item.agentIcon}
            <span className="min-w-0 truncate">
              {item.agentLabel ?? EMPTY_CELL}
            </span>
          </div>
        ),
      },
      {
        key: "model",
        label: t("common:labels.model"),
        width: "130px",
        sorter: (left, right) =>
          compareSessionText(left.modelLabel, right.modelLabel),
        renderCell: (item) => (
          <div className="flex min-w-0 items-center gap-2 text-text-2">
            {item.modelIcon}
            <span className="min-w-0 truncate">
              {item.modelLabel ?? EMPTY_CELL}
            </span>
          </div>
        ),
      },
      {
        key: "workspace",
        label: t("common:selectors.shared.workspace"),
        width: "130px",
        renderCell: (item) => (
          <div className="truncate text-text-3" title={item.workspaceTitle}>
            {item.workspaceLabel ?? EMPTY_CELL}
          </div>
        ),
      },
      {
        key: "impact",
        label: t("common:aiImpact.lines"),
        width: "110px",
        renderCell: (item) => (
          <div className="truncate text-text-3">
            {item.impactLabel ?? EMPTY_CELL}
          </div>
        ),
      },
      {
        key: "filesChanged",
        label: t("common:labels.files"),
        width: "80px",
        renderCell: (item) => (
          <div className="truncate text-text-3">
            {item.filesChangedLabel ?? EMPTY_CELL}
          </div>
        ),
      },
      {
        key: "relatedCommits",
        label: t("common:labels.commits"),
        width: "90px",
        renderCell: (item) => (
          <div className="truncate text-text-3">
            {item.relatedCommitsLabel ?? EMPTY_CELL}
          </div>
        ),
      },
      {
        key: "committedRate",
        label: t("common:labels.committedRate"),
        width: "105px",
        sorter: (left, right) =>
          (left.committedRateValue ?? -1) - (right.committedRateValue ?? -1),
        renderCell: (item) => (
          <div className="flex min-w-0 items-center gap-2 text-text-3">
            <div className="h-1.5 w-12 overflow-hidden rounded-full bg-fill-3">
              <div
                className="h-full rounded-full bg-success-6"
                style={{ width: `${item.committedRateValue ?? 0}%` }}
              />
            </div>
            <span className="truncate">
              {item.committedRateLabel ?? EMPTY_CELL}
            </span>
          </div>
        ),
      },
      {
        key: "tokens",
        label: t("common:labels.tokens"),
        width: "90px",
        sorter: (left, right) =>
          (left.tokensValue ?? -1) - (right.tokensValue ?? -1),
        renderCell: (item) => (
          <div className="truncate text-text-3">
            {item.tokensLabel ?? EMPTY_CELL}
          </div>
        ),
      },
      {
        key: "started",
        label: t("sessions:kanban.list.started"),
        width: "115px",
        renderCell: (item) => (
          <div className="truncate text-text-3">
            {item.startedLabel ?? EMPTY_CELL}
          </div>
        ),
      },
      {
        key: "lastUpdated",
        label: t("sessions:kanban.list.lastUpdated"),
        width: "115px",
        renderCell: (item) => (
          <div className="truncate text-text-3">
            {item.lastUpdatedLabel ?? EMPTY_CELL}
          </div>
        ),
      },
      ...(hasRowActions
        ? [
            {
              key: "actions" as const,
              label: "",
              width: "140px",
              renderCell: (item: SessionTableItem) =>
                item.rowAction != null ? (
                  // Stop propagation so the action does not double as a row
                  // click (row click = select/replay, action = its own verb).
                  <div
                    className="flex items-center justify-end"
                    onClick={(event) => event.stopPropagation()}
                  >
                    {item.rowAction}
                  </div>
                ) : null,
            },
          ]
        : []),
    ];

    return availableColumns
      .filter(
        (column) =>
          columnVisibility?.[column.key] ??
          DEFAULT_COLUMN_VISIBILITY[column.key]
      )
      .map((column) => ({
        ...column,
        ...columnOverrides?.[column.key],
      }));
  }, [t, hasRowActions, columnVisibility, columnOverrides, ownerColumnLabel]);

  const filteredItems = useMemo(() => {
    if (!shouldShowSearch) return items;
    return items.filter((item) => matchesSessionSearch(item, searchQuery));
  }, [items, searchQuery, shouldShowSearch]);

  const hasSearchFilter = shouldShowSearch && searchQuery.trim().length > 0;

  return (
    <SettingsTable<SessionTableItem>
      columns={columns}
      rows={filteredItems}
      getRowKey={(item) => item.id}
      hover
      headerBorder={headerBorder}
      stickyHeader
      stickyFirstColumn
      surfaceVariant={surfaceVariant}
      bodySurface={bodySurface}
      fillHeight={fillHeight}
      maxHeight={maxHeight}
      pageSize={pageSize}
      pageSizeOptions={pageSizeOptions}
      className={["table-settings-page-list-hover", className]
        .filter(Boolean)
        .join(" ")}
      rootClassName={rootClassName}
      emptyTitle={hasSearchFilter ? t("common:status.noResults") : undefined}
      searchBar={
        shouldShowSearch
          ? {
              searchValue: searchQuery,
              searchPlaceholder: t("common:actions.search"),
              onSearchChange: setSearchQuery,
              onSearchClear: () => setSearchQuery(""),
              searchCountText:
                hasSearchFilter && filteredItems.length !== items.length
                  ? `${filteredItems.length} / ${items.length}`
                  : undefined,
            }
          : undefined
      }
      rowClassName={(item) =>
        [
          item.active && surfaceVariant !== "transparent" ? "bg-fill-1" : "",
          item.disabled ? "cursor-default opacity-60" : "",
        ]
          .filter(Boolean)
          .join(" ")
      }
      rowDataTestId={(item) => item.testId}
      rowDataAttributes={(item) => item.dataAttributes}
      onRowClick={(item) => {
        if (item.disabled) return;
        onSelect?.(item);
      }}
    />
  );
};

export default SessionTable;
