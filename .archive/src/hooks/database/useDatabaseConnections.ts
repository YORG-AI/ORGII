/**
 * useDatabaseConnections Hook
 *
 * React hook for managing database connections across all provider types.
 * Supports SQLite, Supabase, and Turso databases using the unified
 * IDatabaseService interface.
 *
 * Usage:
 * ```typescript
 * const { connections, addConnection, removeConnection } = useDatabaseConnections();
 *
 * // Add a new connection
 * await addConnection(config);
 *
 * // Remove a connection
 * removeConnection(connectionId);
 * ```
 */
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useRef } from "react";

import {
  type ColumnInfo,
  type DatabaseConnectionConfig,
  DatabaseServiceFactory,
  type QueryResult,
  type TableInfo,
  getConnectionPath,
} from "@src/engines/DatabaseCore";
import { createLogger } from "@src/hooks/logger";
import {
  type DatabaseConnection,
  addConnectionConfig,
  databaseConnectionsAtom,
  databaseErrorAtom,
  databaseLoadingAtom,
  loadConnectionConfigs,
  removeConnectionConfig,
} from "@src/store/workstation/database";

const log = createLogger("useDatabaseConnections");

// ============================================
// Types
// ============================================

export interface UseDatabaseConnectionsReturn {
  // Connections state
  connections: DatabaseConnection[];
  isLoading: boolean;
  error: string | null;

  // Connection management
  addConnection: (config: DatabaseConnectionConfig) => Promise<string>;
  removeConnection: (connectionId: string) => void;
  refreshTables: (connectionId: string) => Promise<void>;
  toggleConnection: (connectionId: string) => void;

  // Query operations (via factory)
  query: (connectionId: string, sql: string) => Promise<QueryResult>;
  getTableData: (
    connectionId: string,
    tableName: string,
    options?: { page?: number; pageSize?: number }
  ) => Promise<QueryResult>;
  getTableSchema: (
    connectionId: string,
    tableName: string
  ) => Promise<ColumnInfo[]>;

  // Save (for SQLite)
  saveDatabase: (connectionId: string) => Promise<void>;
}

// ============================================
// Hook
// ============================================

export function useDatabaseConnections(): UseDatabaseConnectionsReturn {
  // Use Jotai atoms for global state
  const [connections, setConnections] = useAtom(databaseConnectionsAtom);
  const isLoading = useAtomValue(databaseLoadingAtom);
  const setIsLoading = useSetAtom(databaseLoadingAtom);
  const error = useAtomValue(databaseErrorAtom);
  const setError = useSetAtom(databaseErrorAtom);

  // Track if we've restored persisted connections
  const hasRestoredRef = useRef(false);

  // Populate connection list from localStorage on mount — synchronous,
  // zero I/O. No WASM loading, no file reads, no network calls.
  // Heavy work (connect + getTables) is deferred until the user actually
  // expands a connection (see toggleConnection).
  useEffect(() => {
    if (hasRestoredRef.current) return;
    hasRestoredRef.current = true;

    const configs = loadConnectionConfigs();
    if (configs.length === 0) return;

    const openIds = new Set(connections.map((conn) => conn.id));
    const configsToRestore = configs.filter(
      (config) => !openIds.has(config.id)
    );
    if (configsToRestore.length === 0) return;

    const entries: DatabaseConnection[] = configsToRestore.map((config) => ({
      id: config.id,
      name: config.name,
      type: config.type,
      path: getConnectionPath(config),
      tables: [],
      isExpanded: false,
      isLoading: false,
      error: undefined,
    }));

    setConnections((prev) => {
      const existingIds = new Set(prev.map((conn) => conn.id));
      const newEntries = entries.filter((conn) => !existingIds.has(conn.id));
      return newEntries.length > 0 ? [...prev, ...newEntries] : prev;
    });
  }, [connections, setConnections]);

  // Add a new connection
  const addConnection = useCallback(
    async (config: DatabaseConnectionConfig): Promise<string> => {
      setIsLoading(true);
      setError(null);

      try {
        // Save config to localStorage
        addConnectionConfig(config);

        // Create service and connect (async — providers are lazily loaded)
        const service = await DatabaseServiceFactory.create(config);
        await service.connect();

        // Get tables
        let tables: TableInfo[] = [];
        try {
          tables = await service.getTables();
        } catch {
          // Some connections may not support getTables immediately
        }

        // Add to state
        setConnections((prev) => {
          // Check if already exists
          if (prev.find((conn) => conn.id === config.id)) {
            return prev.map((conn) =>
              conn.id === config.id ? { ...conn, tables } : conn
            );
          }
          return [
            ...prev,
            {
              id: config.id,
              name: config.name,
              type: config.type,
              path: getConnectionPath(config),
              tables,
              isExpanded: true,
              isLoading: false,
            },
          ];
        });

        return config.id;
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

  // Remove a connection
  const removeConnection = useCallback(
    (connectionId: string) => {
      // Remove from factory (disconnects)
      DatabaseServiceFactory.remove(connectionId);

      // Remove from localStorage
      removeConnectionConfig(connectionId);

      // Remove from state
      setConnections((prev) => prev.filter((conn) => conn.id !== connectionId));
    },
    [setConnections]
  );

  // Refresh tables for a connection
  const refreshTables = useCallback(
    async (connectionId: string) => {
      setConnections((prev) =>
        prev.map((conn) =>
          conn.id === connectionId ? { ...conn, isLoading: true } : conn
        )
      );

      try {
        const service = DatabaseServiceFactory.get(connectionId);
        if (!service) {
          throw new Error("Connection not found");
        }

        // Reconnect if needed
        if (!service.isConnected()) {
          await service.connect();
        }

        const tables = await service.getTables();
        setConnections((prev) =>
          prev.map((conn) =>
            conn.id === connectionId
              ? { ...conn, tables, isLoading: false, error: undefined }
              : conn
          )
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        setConnections((prev) =>
          prev.map((conn) =>
            conn.id === connectionId
              ? { ...conn, isLoading: false, error: message }
              : conn
          )
        );
      }
    },
    [setConnections, setError]
  );

  // Toggle connection expanded state.
  // Lazy-connects on first expand: loads the provider, reads the file,
  // and fetches tables only when the user explicitly interacts.
  const toggleConnection = useCallback(
    (connectionId: string) => {
      setConnections((prev) => {
        const conn = prev.find((conn) => conn.id === connectionId);
        if (!conn) return prev;

        const willExpand = !conn.isExpanded;

        // If expanding for the first time and no tables loaded yet,
        // kick off a lazy connect in the background.
        if (willExpand && conn.tables.length === 0 && !conn.isLoading) {
          // Mark as loading, then connect asynchronously
          const lazyConnect = async () => {
            try {
              const configs = loadConnectionConfigs();
              const config = configs.find((cfg) => cfg.id === connectionId);
              if (!config) return;

              const service = await DatabaseServiceFactory.create(config);
              await service.connect();
              const tables = await service.getTables();

              setConnections((current) =>
                current.map((item) =>
                  item.id === connectionId
                    ? { ...item, tables, isLoading: false, error: undefined }
                    : item
                )
              );
            } catch (err) {
              log.debug(`Lazy connect failed: ${connectionId}`, err);
              setConnections((current) =>
                current.map((item) =>
                  item.id === connectionId
                    ? {
                        ...item,
                        isLoading: false,
                        error:
                          err instanceof Error
                            ? err.message
                            : "Connection failed",
                      }
                    : item
                )
              );
            }
          };

          // Fire-and-forget; state updates happen inside
          lazyConnect();

          return prev.map((item) =>
            item.id === connectionId
              ? { ...item, isExpanded: true, isLoading: true }
              : item
          );
        }

        return prev.map((item) =>
          item.id === connectionId ? { ...item, isExpanded: willExpand } : item
        );
      });
    },
    [setConnections]
  );

  // Execute a query
  const query = useCallback(
    async (connectionId: string, sql: string): Promise<QueryResult> => {
      const service = DatabaseServiceFactory.get(connectionId);
      if (!service) {
        throw new Error("Connection not found");
      }
      return service.query(sql);
    },
    []
  );

  // Get table data
  const getTableData = useCallback(
    async (
      connectionId: string,
      tableName: string,
      options?: { page?: number; pageSize?: number }
    ): Promise<QueryResult> => {
      const service = DatabaseServiceFactory.get(connectionId);
      if (!service) {
        throw new Error("Connection not found");
      }
      return service.getTableData(tableName, options);
    },
    []
  );

  // Get table schema
  const getTableSchema = useCallback(
    async (connectionId: string, tableName: string): Promise<ColumnInfo[]> => {
      const service = DatabaseServiceFactory.get(connectionId);
      if (!service) {
        throw new Error("Connection not found");
      }
      return service.getTableSchema(tableName);
    },
    []
  );

  // Save database (SQLite only)
  const saveDatabase = useCallback(
    async (connectionId: string): Promise<void> => {
      const service = DatabaseServiceFactory.get(connectionId);
      if (!service) {
        throw new Error("Connection not found");
      }
      if (service.save) {
        await service.save();
      }
    },
    []
  );

  return {
    connections,
    isLoading,
    error,
    addConnection,
    removeConnection,
    refreshTables,
    toggleConnection,
    query,
    getTableData,
    getTableSchema,
    saveDatabase,
  };
}

export default useDatabaseConnections;
