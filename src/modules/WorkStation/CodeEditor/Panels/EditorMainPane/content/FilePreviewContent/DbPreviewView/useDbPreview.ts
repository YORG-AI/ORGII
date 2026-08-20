/**
 * useDbPreview Hook
 *
 * Manages SQLite database preview lifecycle for the code editor.
 * Opens a .db file read-only via SqliteProvider, lists tables,
 * and loads table data on demand using the existing DataGrid-compatible format.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import type {
  ColumnInfo,
  QueryOptions,
  QueryResult,
  SqliteConnectionConfig,
  TableInfo,
} from "@src/engines/DatabaseCore";

import {
  DB_PREVIEW_PAGE_SIZE,
  type DbPreviewSortDirection,
  getNextDbPreviewSortState,
  withUpdatedDbPreviewTableRowCount,
} from "./dbPreviewUtils";

interface DbPreviewState {
  tables: TableInfo[];
  selectedTable: string | null;
  schema: ColumnInfo[];
  tableData: QueryResult | null;
  connecting: boolean;
  loading: boolean;
  error: string | null;
  page: number;
  sortColumn: string | null;
  sortDirection: DbPreviewSortDirection;
}

const INITIAL_STATE: DbPreviewState = {
  tables: [],
  selectedTable: null,
  schema: [],
  tableData: null,
  connecting: true,
  loading: false,
  error: null,
  page: 1,
  sortColumn: null,
  sortDirection: "asc",
};

export interface UseDbPreviewReturn extends DbPreviewState {
  selectTable: (tableName: string) => void;
  loadPage: (page: number) => void;
  toggleSort: (columnName: string) => void;
  refresh: () => void;
}

interface SqliteService {
  getTables: () => Promise<TableInfo[]>;
  getTableSchema: (name: string) => Promise<ColumnInfo[]>;
  getTableData: (name: string, opts?: QueryOptions) => Promise<QueryResult>;
  disconnect: () => Promise<void>;
}

export function useDbPreview(filePath: string): UseDbPreviewReturn {
  const [state, setState] = useState<DbPreviewState>(INITIAL_STATE);
  const serviceRef = useRef<SqliteService | null>(null);
  const filePathRef = useRef(filePath);
  const selectedTableRef = useRef<string | null>(null);
  const sortColumnRef = useRef<string | null>(null);
  const sortDirectionRef = useRef<DbPreviewSortDirection>("asc");

  useEffect(() => {
    selectedTableRef.current = state.selectedTable;
    sortColumnRef.current = state.sortColumn;
    sortDirectionRef.current = state.sortDirection;
  }, [state.selectedTable, state.sortColumn, state.sortDirection]);

  const loadTableData = useCallback(
    async (
      tableName: string,
      page: number,
      sortColumn?: string | null,
      sortDirection?: DbPreviewSortDirection
    ) => {
      const service = serviceRef.current;
      if (!service) return;

      const nextSortColumn =
        sortColumn === undefined ? sortColumnRef.current : sortColumn;
      const nextSortDirection = sortDirection ?? sortDirectionRef.current;

      setState((prev) => ({ ...prev, loading: true }));

      try {
        const [schema, tableData] = await Promise.all([
          service.getTableSchema(tableName),
          service.getTableData(tableName, {
            page,
            pageSize: DB_PREVIEW_PAGE_SIZE,
            orderBy: nextSortColumn ?? undefined,
            orderDirection: nextSortColumn ? nextSortDirection : undefined,
          }),
        ]);

        setState((prev) => ({
          ...prev,
          loading: false,
          schema,
          tableData,
          selectedTable: tableName,
          tables: withUpdatedDbPreviewTableRowCount(
            prev.tables,
            tableName,
            tableData.totalCount
          ),
          page,
          sortColumn: nextSortColumn,
          sortDirection: nextSortDirection,
        }));
      } catch (err) {
        setState((prev) => ({
          ...prev,
          loading: false,
          error:
            err instanceof Error ? err.message : "Failed to load table data",
        }));
      }
    },
    []
  );

  const selectTable = useCallback(
    (tableName: string) => {
      loadTableData(tableName, 1, null, "asc");
    },
    [loadTableData]
  );

  const loadPage = useCallback(
    (page: number) => {
      const table = selectedTableRef.current;
      if (table) {
        loadTableData(table, page);
      }
    },
    [loadTableData]
  );

  const toggleSort = useCallback(
    (columnName: string) => {
      const table = selectedTableRef.current;
      if (!table) return;
      const nextSortState = getNextDbPreviewSortState(
        sortColumnRef.current,
        sortDirectionRef.current,
        columnName
      );
      loadTableData(table, 1, nextSortState.columnId, nextSortState.direction);
    },
    [loadTableData]
  );

  const connect = useCallback(async (path: string) => {
    setState((_prev) => ({
      ...INITIAL_STATE,
      connecting: true,
    }));

    try {
      const { SqliteProvider } =
        await import("@src/engines/DatabaseCore/providers");
      const { isValidSqliteFile } =
        await import("@src/engines/DatabaseCore/providers/isValidSqliteFile");

      const valid = await isValidSqliteFile(path);
      if (!valid) {
        setState((prev) => ({
          ...prev,
          connecting: false,
          error: "Not a valid SQLite database file",
        }));
        return;
      }

      const config: SqliteConnectionConfig = {
        id: `preview-${Date.now()}`,
        name: path.split("/").pop() || "database",
        type: "sqlite",
        filePath: path,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const provider = new SqliteProvider(config);
      await provider.connect();

      serviceRef.current = provider;

      const tables = await provider.getTables();
      const firstTable = tables[0];
      if (!firstTable) {
        setState((prev) => ({
          ...prev,
          connecting: false,
          tables,
          selectedTable: null,
        }));
        return;
      }

      const [schema, tableData] = await Promise.all([
        provider.getTableSchema(firstTable.name),
        provider.getTableData(firstTable.name, {
          page: 1,
          pageSize: DB_PREVIEW_PAGE_SIZE,
        }),
      ]);

      setState((prev) => ({
        ...prev,
        connecting: false,
        loading: false,
        tables: withUpdatedDbPreviewTableRowCount(
          tables,
          firstTable.name,
          tableData.totalCount
        ),
        selectedTable: firstTable.name,
        schema,
        tableData,
        page: 1,
        sortColumn: null,
        sortDirection: "asc",
      }));
    } catch (err) {
      setState((prev) => ({
        ...prev,
        connecting: false,
        error: err instanceof Error ? err.message : "Failed to open database",
      }));
    }
  }, []);

  const refresh = useCallback(() => {
    serviceRef.current?.disconnect();
    serviceRef.current = null;
    connect(filePathRef.current);
  }, [connect]);

  useEffect(() => {
    filePathRef.current = filePath;
    connect(filePath);

    return () => {
      serviceRef.current?.disconnect();
      serviceRef.current = null;
    };
  }, [filePath, connect]);

  return {
    ...state,
    selectTable,
    loadPage,
    toggleSort,
    refresh,
  };
}
