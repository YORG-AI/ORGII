/**
 * useDatabaseSidebarState Hook
 *
 * Manages shared state for the database sidebar sections:
 * - Added Connections: opened database connections
 * - Pending Connections: discovered SQLite files not yet opened
 *
 * Handles scanning, connection management, and state coordination.
 */
import { invoke } from "@tauri-apps/api/core";
import {
  type MouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

import type { DatabaseConnectionConfig } from "@src/engines/DatabaseCore";
import { useDatabaseConnections } from "@src/hooks/database";

import type { SqliteFile } from "../types";

// ============================================
// Types
// ============================================

export interface UseDatabaseSidebarStateProps {
  repoPath: string;
  selectedConnectionId: string | null;
  onSelectConnection: (connectionId: string | null) => void;
  onSelectTable: (connectionId: string, tableName: string) => void;
  onConnectionClose?: (connectionId: string) => void;
  scanPath?: string | null;
  onScanPathProcessed?: () => void;
}

export interface UseDatabaseSidebarStateReturn {
  // Connections
  connections: ReturnType<typeof useDatabaseConnections>["connections"];
  connectionError: string | null;

  // Discovered files
  discoveredFiles: SqliteFile[];
  isScanning: boolean;
  scanError: string | null;

  // Actions
  handleToggleConnection: (connectionId: string) => void;
  handleSelectTable: (connectionId: string, tableName: string) => void;
  handleRefreshConnection: (event: MouseEvent, connectionId: string) => void;
  handleCloseConnection: (event: MouseEvent, connectionId: string) => void;
  handleOpenFile: (file: SqliteFile) => Promise<void>;
  handleAddConnection: (config: DatabaseConnectionConfig) => Promise<string>;
}

// ============================================
// Hook
// ============================================

export function useDatabaseSidebarState({
  repoPath,
  selectedConnectionId,
  onSelectConnection,
  onSelectTable,
  onConnectionClose,
  scanPath,
  onScanPathProcessed,
}: UseDatabaseSidebarStateProps): UseDatabaseSidebarStateReturn {
  // Database connections hook
  const {
    connections,
    error: connectionError,
    addConnection,
    removeConnection,
    refreshTables,
    toggleConnection,
  } = useDatabaseConnections();

  // Discovered SQLite files (not yet opened).
  // isScanning starts true so the UI shows "Scanning..." immediately
  // instead of flashing "No files found" before the deferred scan kicks in.
  const [discoveredFiles, setDiscoveredFiles] = useState<SqliteFile[]>([]);
  const [isScanning, setIsScanning] = useState(!!repoPath);
  const [scanError, setScanError] = useState<string | null>(null);

  // Helper to scan a directory for SQLite files.
  // Uses file extensions only — no header validation.
  // Reading entire files just to check 16 bytes of header blocks the main
  // thread and triggers the macOS beach-ball on large databases.
  const scanDirectory = useCallback(
    async (directory: string): Promise<SqliteFile[]> => {
      try {
        const files = await invoke<string[]>("find_files_by_extension", {
          directory,
          extensions: ["sqlite", "sqlite3", "db"],
        });

        return files.map((filePath) => {
          const name = filePath.split("/").pop() || filePath;
          return { path: filePath, name };
        });
      } catch {
        return [];
      }
    },
    []
  );

  // Scan for SQLite files in repository
  const scanForDatabases = useCallback(async () => {
    if (!repoPath) return;

    setIsScanning(true);
    setScanError(null);

    try {
      const repoFiles = await scanDirectory(repoPath);
      setDiscoveredFiles(repoFiles);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setScanError(message);
      setDiscoveredFiles([]);
    } finally {
      setIsScanning(false);
    }
  }, [repoPath, scanDirectory]);

  // Auto-scan on mount, deferred until browser is idle so UI renders first.
  // Uses requestIdleCallback with a fallback timeout for browsers that don't support it.
  useEffect(() => {
    let cancelled = false;

    const scheduleIdle =
      typeof requestIdleCallback === "function"
        ? requestIdleCallback
        : (cb: () => void) => setTimeout(cb, 300);

    const cancelIdle =
      typeof cancelIdleCallback === "function"
        ? cancelIdleCallback
        : clearTimeout;

    const handle = scheduleIdle(() => {
      if (!cancelled) scanForDatabases();
    });

    return () => {
      cancelled = true;
      cancelIdle(handle as number);
    };
  }, [scanForDatabases]);

  // Handle scanPath from DatabasePalette (file or folder)
  useEffect(() => {
    if (!scanPath) return;

    const processScanPath = async () => {
      setIsScanning(true);
      setScanError(null);

      try {
        // Check if it's a file by extension (avoids reading entire file)
        const lowerPath = scanPath.toLowerCase();
        const isSqliteFile =
          lowerPath.endsWith(".sqlite") ||
          lowerPath.endsWith(".sqlite3") ||
          lowerPath.endsWith(".db");

        if (isSqliteFile) {
          // It's a valid SQLite file - open it directly
          const name = scanPath.split("/").pop() || scanPath;
          const config: DatabaseConnectionConfig = {
            id: `sqlite:${scanPath}`,
            name: name.replace(/\.[^.]+$/, ""),
            type: "sqlite",
            filePath: scanPath,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };

          const connectionId = await addConnection(config);
          onSelectConnection(connectionId);
        } else {
          // It's a folder - scan for SQLite files and add to discovered
          const folderFiles = await scanDirectory(scanPath);
          if (folderFiles.length > 0) {
            setDiscoveredFiles((prev) => {
              const existingPaths = new Set(prev.map((file) => file.path));
              const newFiles = folderFiles.filter(
                (file) => !existingPaths.has(file.path)
              );
              return [...prev, ...newFiles];
            });
          } else {
            setScanError(`No SQLite files found in ${scanPath}`);
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setScanError(message);
      } finally {
        setIsScanning(false);
        onScanPathProcessed?.();
      }
    };

    processScanPath();
  }, [
    scanPath,
    scanDirectory,
    addConnection,
    onSelectConnection,
    onScanPathProcessed,
  ]);

  // Filter discovered files to exclude already-open connections
  const filteredDiscoveredFiles = useMemo(() => {
    const openPaths = new Set(connections.map((conn) => conn.path));
    return discoveredFiles.filter((file) => !openPaths.has(file.path));
  }, [discoveredFiles, connections]);

  // Handle adding a connection
  const handleAddConnection = useCallback(
    async (config: DatabaseConnectionConfig): Promise<string> => {
      const connectionId = await addConnection(config);
      onSelectConnection(connectionId);

      // Remove from discovered files if it was a SQLite file
      if (config.type === "sqlite") {
        setDiscoveredFiles((prev) =>
          prev.filter((file) => file.path !== config.filePath)
        );
      }

      return connectionId;
    },
    [addConnection, onSelectConnection]
  );

  // Open a discovered SQLite file
  const handleOpenFile = useCallback(
    async (file: SqliteFile) => {
      const config: DatabaseConnectionConfig = {
        id: `sqlite:${file.path}`,
        name: file.name.replace(/\.[^.]+$/, ""),
        type: "sqlite",
        filePath: file.path,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      await handleAddConnection(config);
    },
    [handleAddConnection]
  );

  // Close a connection
  const handleCloseConnection = useCallback(
    (event: MouseEvent, connectionId: string) => {
      event.stopPropagation();
      removeConnection(connectionId);
      onConnectionClose?.(connectionId);
      if (selectedConnectionId === connectionId) {
        onSelectConnection(null);
      }
    },
    [
      removeConnection,
      selectedConnectionId,
      onSelectConnection,
      onConnectionClose,
    ]
  );

  // Refresh connection tables
  const handleRefreshConnection = useCallback(
    async (event: MouseEvent, connectionId: string) => {
      event.stopPropagation();
      await refreshTables(connectionId);
    },
    [refreshTables]
  );

  // Toggle connection expansion
  const handleToggleConnection = useCallback(
    (connectionId: string) => {
      toggleConnection(connectionId);
      onSelectConnection(connectionId);
    },
    [toggleConnection, onSelectConnection]
  );

  // Select a table - opens a tab
  const handleSelectTable = useCallback(
    (connectionId: string, tableName: string) => {
      onSelectConnection(connectionId);
      onSelectTable(connectionId, tableName);
    },
    [onSelectConnection, onSelectTable]
  );

  return {
    connections,
    connectionError,
    discoveredFiles: filteredDiscoveredFiles,
    isScanning,
    scanError,
    handleToggleConnection,
    handleSelectTable,
    handleRefreshConnection,
    handleCloseConnection,
    handleOpenFile,
    handleAddConnection,
  };
}

export default useDatabaseSidebarState;
