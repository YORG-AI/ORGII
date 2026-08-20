import type { TableInfo } from "@src/engines/DatabaseCore";

export const DB_PREVIEW_PAGE_SIZE = 200;

export type DbPreviewSortDirection = "asc" | "desc";

export interface DbPreviewSortState {
  columnId: string | null;
  direction: DbPreviewSortDirection;
}

export interface DbPreviewPageRange {
  firstRowNumber: number;
  lastRowNumber: number;
  totalPages: number;
  label: string;
}

export function getDbPreviewPageRange(
  page: number,
  pageSize: number,
  totalCount: number
): DbPreviewPageRange {
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const firstRowNumber = totalCount === 0 ? 0 : (page - 1) * pageSize + 1;
  const lastRowNumber = Math.min(page * pageSize, totalCount);

  return {
    firstRowNumber,
    lastRowNumber,
    totalPages,
    label: `${firstRowNumber}-${lastRowNumber} / ${totalCount.toLocaleString()}`,
  };
}

export function getNextDbPreviewSortState(
  currentSortColumn: string | null,
  currentSortDirection: DbPreviewSortDirection,
  columnName: string
): DbPreviewSortState {
  return {
    columnId: columnName,
    direction:
      currentSortColumn === columnName && currentSortDirection === "asc"
        ? "desc"
        : "asc",
  };
}

export function withUpdatedDbPreviewTableRowCount(
  tables: TableInfo[],
  tableName: string,
  totalCount: number | undefined
): TableInfo[] {
  if (totalCount == null) return tables;

  return tables.map((table) =>
    table.name === tableName ? { ...table, rowCount: totalCount } : table
  );
}
