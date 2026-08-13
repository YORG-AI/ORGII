import { RefreshCw } from "lucide-react";
import React, { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import Select, { type SelectOption } from "@src/components/Select";
import { useRefreshSpin } from "@src/hooks/ui";
import {
  DB_PREVIEW_PAGE_SIZE,
  getDbPreviewPageRange,
} from "@src/hooks/workStation/database/dbPreviewUtils";
import { useDbPreview } from "@src/hooks/workStation/database/useDbPreview";
import {
  TableSurface,
  type TableSurfaceColumn,
  type TableSurfaceRow,
} from "@src/modules/WorkStation/shared/TableSurface";
import { Placeholder } from "@src/modules/shared/layouts/blocks";

export interface DbPreviewViewProps {
  filePath: string;
  className?: string;
}

export const DbPreviewView: React.FC<DbPreviewViewProps> = memo(
  ({ filePath, className = "" }) => {
    const { t } = useTranslation();
    const {
      tables,
      selectedTable,
      schema,
      tableData,
      connecting,
      loading,
      error,
      page,
      sortColumn,
      sortDirection,
      selectTable,
      loadPage,
      toggleSort,
      refresh,
    } = useDbPreview(filePath);
    const { spinClass, handleClick: handleRefreshClick } = useRefreshSpin(
      refresh,
      loading
    );

    const tableOptions = useMemo<SelectOption[]>(
      () =>
        tables.map((table) => ({
          value: table.name,
          label:
            table.rowCount == null
              ? `${table.name} · ${table.type}`
              : `${table.name} · ${table.type} · ${table.rowCount.toLocaleString()}`,
          triggerLabel: table.name,
        })),
      [tables]
    );

    const columns = useMemo<TableSurfaceColumn[]>(() => {
      return (tableData?.columns ?? []).map((columnName) => {
        const columnSchema = schema.find((item) => item.name === columnName);
        return {
          id: columnName,
          label: columnName,
          metaLabel: columnSchema?.type,
          badge: columnSchema?.primaryKey ? "PK" : columnSchema?.type,
        };
      });
    }, [schema, tableData?.columns]);

    const rows = useMemo<TableSurfaceRow[]>(
      () =>
        (tableData?.values ?? []).map((row, rowIndex) => ({
          id: `db-row-${page}-${rowIndex}`,
          cells: row,
        })),
      [page, tableData?.values]
    );

    if (connecting) {
      return (
        <Placeholder
          variant="loading"
          placement="detail-panel"
          title={t("placeholders.connectingDatabase")}
          fillParentHeight
          className={className}
        />
      );
    }

    if (error) {
      return (
        <Placeholder
          variant="error"
          placement="detail-panel"
          title={t("placeholders.invalidDatabase")}
          subtitle={error}
          onRetry={refresh}
          fillParentHeight
          className={className}
        />
      );
    }

    if (tables.length === 0) {
      return (
        <Placeholder
          variant="empty"
          placement="detail-panel"
          title={t("placeholders.noTables")}
          fillParentHeight
          className={className}
        />
      );
    }

    const totalCount = tableData?.totalCount ?? 0;
    const { totalPages, label: rangeLabel } = getDbPreviewPageRange(
      page,
      DB_PREVIEW_PAGE_SIZE,
      totalCount
    );
    const showPagination =
      selectedTable !== null && tableData?.totalCount != null;

    const toolbarLeading = (
      <Select
        value={selectedTable ?? ""}
        onChange={(value) => {
          if (Array.isArray(value)) return;
          selectTable(String(value));
        }}
        options={tableOptions}
        size="small"
        appearance="ghost"
        radius="lg"
        showSearch
        dropdownMinWidth={220}
        dropdownWidthMode="match"
        placeholder={t("placeholders.selectTable")}
      />
    );

    const toolbarTrailing = (
      <>
        <span className="text-[11px] text-text-2">
          {tables.length} {tables.length === 1 ? "table" : "tables"}
        </span>
        <button
          type="button"
          onClick={handleRefreshClick}
          className="rounded p-1 text-text-3 transition-colors hover:bg-fill-2 hover:text-text-1"
        >
          <RefreshCw size={13} className={spinClass} />
        </button>
        {showPagination && (
          <div className="ml-auto flex items-center gap-1.5 text-[11px] text-text-2">
            <Button
              htmlType="button"
              variant="tertiary"
              size="small"
              iconOnly
              disabled={page <= 1 || loading}
              onClick={() => loadPage(page - 1)}
              icon={<span className="text-xs leading-none">←</span>}
            />
            <span className="tabular-nums">{rangeLabel}</span>
            <Button
              htmlType="button"
              variant="tertiary"
              size="small"
              iconOnly
              disabled={page >= totalPages || loading}
              onClick={() => loadPage(page + 1)}
              icon={<span className="text-xs leading-none">→</span>}
            />
          </div>
        )}
      </>
    );

    if (!selectedTable) {
      return (
        <div className={`flex flex-1 flex-col overflow-hidden ${className}`}>
          <TableSurface
            columns={[]}
            rows={[]}
            toolbarLeading={toolbarLeading}
            toolbarTrailing={toolbarTrailing}
            showFormulaBar={false}
            emptyTitle={t("placeholders.selectTable")}
          />
        </div>
      );
    }

    if (loading && !tableData) {
      return (
        <div className={`flex flex-1 flex-col overflow-hidden ${className}`}>
          <TableSurface
            columns={[]}
            rows={[]}
            toolbarLeading={toolbarLeading}
            toolbarTrailing={toolbarTrailing}
            showFormulaBar={false}
            emptyTitle={t("common:status.loading")}
          />
        </div>
      );
    }

    return (
      <div className={`flex flex-1 flex-col overflow-hidden ${className}`}>
        <TableSurface
          columns={columns}
          rows={rows}
          mode="readonly"
          toolbarLeading={toolbarLeading}
          toolbarTrailing={toolbarTrailing}
          showFormulaBar={false}
          sortState={{ columnId: sortColumn, direction: sortDirection }}
          onSortColumn={toggleSort}
          emptyTitle={t("placeholders.noData")}
        />
      </div>
    );
  }
);

DbPreviewView.displayName = "DbPreviewView";

export default DbPreviewView;
