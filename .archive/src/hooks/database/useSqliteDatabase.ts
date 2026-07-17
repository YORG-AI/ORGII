/**
 * useSqliteDatabase Hook
 *
 * React hook for managing SQLite database connections and operations.
 * Uses Rust Tauri commands (db_open, db_query, etc.) — no WASM sql.js.
 *
 * STATE PERSISTENCE:
 * - Uses Jotai atoms for global state (survives component remounts)
 * - Persists connection paths to localStorage (survives app restart)
 *
 * Usage:
 * ```typescript
 * const { openDatabase, tables, query, loading, error } = useSqliteDatabase();
 * const connectionId = await openDatabase("/path/to/db.sqlite");
 * const result = await query(connectionId, "SELECT * FROM users");
 * ```
 */
import { invoke } from "@tauri-apps/api/core";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useCallback } from "react";

import type { ColumnInfo, QueryResult } from "@src/engines/DatabaseCore";
import { createLogger } from "@src/hooks/logger";
import {
  type DatabaseConnection,
  databaseConnectionsAtom,
  databaseErrorAtom,
  databaseLoadingAtom,
  removeConnectionConfig,
} from "@src/store/workstation/database";

const log = createLogger("useSqliteDatabase");

// ============================================
// Types (re-export for convenience)
// ============================================

export type { DatabaseConnection } from "@src/store/workstation/database";

interface RustTableInfo {
  name: string;
  type: string;
  rowCount?: number;
}

interface RustColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
  defaultValue: string | null;
  autoIncrement: boolean;
}

export interface UseSqliteDatabaseReturn {
  connections: DatabaseConnection[];
  isLoading: boolean;
  error: string | null;

  openDatabase: (filePath: string) => Promise<string>;
  closeDatabase: (connectionId: string) => void;
  refreshTables: (connectionId: string) => Promise<void>;
  toggleConnection: (connectionId: string) => void;

  query: (connectionId: string, sql: string) => Promise<QueryResult>;
  getTableData: (
    connectionId: string,
    tableName: string,
    options?: { limit?: number; offset?: number }
  ) => Promise<QueryResult>;
  getTableSchema: (
    connectionId: string,
    tableName: string
  ) => Promise<ColumnInfo[]>;

  insertRow: (
    connectionId: string,
    tableName: string,
    data: Record<string, unknown>
  ) => Promise<void>;
  updateRow: (
    connectionId: string,
    tableName: string,
    data: Record<string, unknown>,
    where: Record<string, unknown>
  ) => Promise<void>;
  deleteRow: (
    connectionId: string,
    tableName: string,
    where: Record<string, unknown>
  ) => Promise<void>;

  saveDatabase: (connectionId: string) => Promise<void>;
}

// ============================================
// Hook
// ============================================

export function useSqliteDatabase(): UseSqliteDatabaseReturn {
  const [connections, setConnections] = useAtom(databaseConnectionsAtom);
  const isLoading = useAtomValue(databaseLoadingAtom);
  const setIsLoading = useSetAtom(databaseLoadingAtom);
  const error = useAtomValue(databaseErrorAtom);
  const setError = useSetAtom(databaseErrorAtom);

  const openDatabase = useCallback(
    async (filePath: string): Promise<string> => {
      setIsLoading(true);
      setError(null);
      try {
        const connectionId = await invoke<string>("db_open", { filePath });
        const tables = await invoke<RustTableInfo[]>("db_get_tables", {
          connectionId,
        });
        const fileName = filePath.split("/").pop() || filePath;

        setConnections((prev) => {
          if (prev.find((conn) => conn.id === connectionId)) {
            return prev.map((conn) =>
              conn.id === connectionId
                ? {
                    ...conn,
                    tables: tables.map((t) => ({
                      name: t.name,
                      type: t.type as "table" | "view",
                      rowCount: t.rowCount,
                    })),
                  }
                : conn
            );
          }
          return [
            ...prev,
            {
              id: connectionId,
              name: fileName,
              type: "sqlite" as const,
              path: filePath,
              tables: tables.map((t) => ({
                name: t.name,
                type: t.type as "table" | "view",
                rowCount: t.rowCount,
              })),
              isExpanded: true,
              isLoading: false,
            },
          ];
        });

        return connectionId;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        throw err;
      } finally {
        setIsLoading(false);
      }
    },
    [setConnections, setError, setIsLoading]
  );

  const closeDatabase = useCallback(
    (connectionId: string) => {
      invoke("db_close", { connectionId }).catch(log.error);
      removeConnectionConfig(connectionId);
      setConnections((prev) => prev.filter((conn) => conn.id !== connectionId));
    },
    [setConnections]
  );

  const refreshTables = useCallback(
    async (connectionId: string) => {
      setConnections((prev) =>
        prev.map((conn) =>
          conn.id === connectionId ? { ...conn, isLoading: true } : conn
        )
      );
      try {
        const tables = await invoke<RustTableInfo[]>("db_get_tables", {
          connectionId,
        });
        setConnections((prev) =>
          prev.map((conn) =>
            conn.id === connectionId
              ? {
                  ...conn,
                  tables: tables.map((t) => ({
                    name: t.name,
                    type: t.type as "table" | "view",
                    rowCount: t.rowCount,
                  })),
                  isLoading: false,
                }
              : conn
          )
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        setConnections((prev) =>
          prev.map((conn) =>
            conn.id === connectionId ? { ...conn, isLoading: false } : conn
          )
        );
      }
    },
    [setConnections, setError]
  );

  const toggleConnection = useCallback(
    (connectionId: string) => {
      setConnections((prev) =>
        prev.map((conn) =>
          conn.id === connectionId
            ? { ...conn, isExpanded: !conn.isExpanded }
            : conn
        )
      );
    },
    [setConnections]
  );

  const query = useCallback(
    async (connectionId: string, sql: string): Promise<QueryResult> => {
      return invoke<QueryResult>("db_query", { connectionId, sql });
    },
    []
  );

  const getTableData = useCallback(
    async (
      connectionId: string,
      tableName: string,
      options?: { limit?: number; offset?: number }
    ): Promise<QueryResult> => {
      return invoke<QueryResult>("db_get_table_data", {
        connectionId,
        tableName,
        options: options
          ? { pageSize: options.limit, page: options.offset }
          : undefined,
      });
    },
    []
  );

  const getTableSchema = useCallback(
    async (connectionId: string, tableName: string): Promise<ColumnInfo[]> => {
      const cols = await invoke<RustColumnInfo[]>("db_get_table_schema", {
        connectionId,
        tableName,
      });
      return cols.map((col) => ({
        name: col.name,
        type: col.type,
        nullable: col.nullable,
        primaryKey: col.primaryKey,
        defaultValue: col.defaultValue,
        autoIncrement: col.autoIncrement,
      }));
    },
    []
  );

  const insertRow = useCallback(
    async (
      connectionId: string,
      tableName: string,
      data: Record<string, unknown>
    ): Promise<void> => {
      await invoke("db_insert", { connectionId, tableName, data });
    },
    []
  );

  const updateRow = useCallback(
    async (
      connectionId: string,
      tableName: string,
      data: Record<string, unknown>,
      where: Record<string, unknown>
    ): Promise<void> => {
      await invoke("db_update", {
        connectionId,
        tableName,
        data,
        whereClause: where,
      });
    },
    []
  );

  const deleteRow = useCallback(
    async (
      connectionId: string,
      tableName: string,
      where: Record<string, unknown>
    ): Promise<void> => {
      await invoke("db_delete", {
        connectionId,
        tableName,
        whereClause: where,
      });
    },
    []
  );

  const saveDatabase = useCallback(
    async (_connectionId: string): Promise<void> => {
      // Rust writes directly to the file — no explicit save step needed.
    },
    []
  );

  return {
    connections,
    isLoading,
    error,
    openDatabase,
    closeDatabase,
    refreshTables,
    toggleConnection,
    query,
    getTableData,
    getTableSchema,
    insertRow,
    updateRow,
    deleteRow,
    saveDatabase,
  };
}

export default useSqliteDatabase;
