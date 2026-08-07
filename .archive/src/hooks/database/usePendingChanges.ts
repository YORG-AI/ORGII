/**
 * usePendingChanges Hook
 *
 * Manages pending CRUD changes for a database table.
 * Changes are tracked locally until saved to the database.
 *
 * Features:
 * - Track cell updates, row inserts, row deletes
 * - Merge multiple edits to the same row
 * - Undo individual changes or all changes
 * - Apply changes to database on save
 */
import { useCallback, useMemo, useState } from "react";

import {
  type ColumnInfo,
  DatabaseServiceFactory,
} from "@src/engines/DatabaseCore";
import {
  type PendingChange,
  type PendingChangeType,
  generateChangeId,
} from "@src/store/workstation/database";

// ============================================
// Types
// ============================================

export interface UsePendingChangesOptions {
  connectionId: string;
  tableName: string;
  schema: ColumnInfo[];
  onSaveSuccess?: () => void;
  onSaveError?: (error: string) => void;
}

export interface UsePendingChangesReturn {
  /** List of pending changes */
  changes: PendingChange[];
  /** Whether there are unsaved changes */
  hasChanges: boolean;
  /** Count of changes by type */
  changeCount: { inserts: number; updates: number; deletes: number };
  /** Currently editing cell */
  editingCell: { rowIndex: number; column: string } | null;
  /** Selected row indices for bulk operations */
  selectedRows: Set<number>;
  /** Whether save is in progress */
  saving: boolean;

  // Actions
  /** Start editing a cell */
  startEdit: (rowIndex: number, column: string) => void;
  /** Cancel editing */
  cancelEdit: () => void;
  /** Update a cell value */
  updateCell: (
    rowIndex: number,
    column: string,
    originalRow: Record<string, unknown>,
    newValue: unknown
  ) => void;
  /** Mark a row for deletion */
  deleteRow: (rowIndex: number, rowData: Record<string, unknown>) => void;
  /** Add a new row */
  insertRow: (data: Record<string, unknown>) => void;
  /** Toggle row selection */
  toggleRowSelection: (rowIndex: number) => void;
  /** Select/deselect all rows */
  selectAllRows: (rowCount: number, selected: boolean) => void;
  /** Delete selected rows */
  deleteSelectedRows: (
    getRowData: (index: number) => Record<string, unknown>
  ) => void;
  /** Undo a specific change */
  undoChange: (changeId: string) => void;
  /** Discard all changes */
  discardAll: () => void;
  /** Save all changes to database */
  saveChanges: () => Promise<void>;
  /** Get change type for a row (for visual indicators) */
  getRowChangeType: (rowIndex: number) => PendingChangeType | null;
  /** Check if a cell was modified */
  isCellModified: (rowIndex: number, column: string) => boolean;
  /** Get the pending value for a cell (if modified) */
  getPendingValue: (rowIndex: number, column: string) => unknown | undefined;
}

// ============================================
// Hook
// ============================================

export function usePendingChanges({
  connectionId,
  tableName,
  schema,
  onSaveSuccess,
  onSaveError,
}: UsePendingChangesOptions): UsePendingChangesReturn {
  const [changes, setChanges] = useState<PendingChange[]>([]);
  const [editingCell, setEditingCell] = useState<{
    rowIndex: number;
    column: string;
  } | null>(null);
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);

  // Derived state
  const hasChanges = changes.length > 0;

  const changeCount = useMemo(
    () => ({
      inserts: changes.filter((change) => change.type === "insert").length,
      updates: changes.filter((change) => change.type === "update").length,
      deletes: changes.filter((change) => change.type === "delete").length,
    }),
    [changes]
  );

  // Get primary key columns for WHERE clauses
  const primaryKeyColumns = useMemo(
    () => schema.filter((col) => col.primaryKey).map((col) => col.name),
    [schema]
  );

  // Start editing a cell
  const startEdit = useCallback((rowIndex: number, column: string) => {
    setEditingCell({ rowIndex, column });
  }, []);

  // Cancel editing
  const cancelEdit = useCallback(() => {
    setEditingCell(null);
  }, []);

  // Update a cell value
  const updateCell = useCallback(
    (
      rowIndex: number,
      column: string,
      originalRow: Record<string, unknown>,
      newValue: unknown
    ) => {
      setChanges((prev) => {
        // Check if there's already a change for this row
        const existingIdx = prev.findIndex(
          (change) => change.rowIndex === rowIndex && change.type === "update"
        );

        if (existingIdx >= 0) {
          // Merge with existing update
          const existing = prev[existingIdx];
          const updatedChange: PendingChange = {
            ...existing,
            newData: {
              ...existing.newData,
              [column]: newValue,
            },
          };
          return [
            ...prev.slice(0, existingIdx),
            updatedChange,
            ...prev.slice(existingIdx + 1),
          ];
        }

        // Create new update change
        const newChange: PendingChange = {
          id: generateChangeId(),
          type: "update",
          rowIndex,
          originalData: originalRow,
          newData: { [column]: newValue },
          changedColumn: column,
        };
        return [...prev, newChange];
      });
      setEditingCell(null);
    },
    []
  );

  // Mark a row for deletion
  const deleteRow = useCallback(
    (rowIndex: number, rowData: Record<string, unknown>) => {
      setChanges((prev) => {
        // Check if this row is already marked for deletion
        if (
          prev.some(
            (change) => change.rowIndex === rowIndex && change.type === "delete"
          )
        ) {
          return prev;
        }

        // If it's a pending insert, just remove the insert
        const insertIdx = prev.findIndex(
          (change) => change.rowIndex === rowIndex && change.type === "insert"
        );
        if (insertIdx >= 0) {
          return [...prev.slice(0, insertIdx), ...prev.slice(insertIdx + 1)];
        }

        // Remove any pending updates for this row
        const withoutUpdates = prev.filter(
          (change) =>
            !(change.rowIndex === rowIndex && change.type === "update")
        );

        // Add delete change
        const deleteChange: PendingChange = {
          id: generateChangeId(),
          type: "delete",
          rowIndex,
          originalData: rowData,
        };
        return [...withoutUpdates, deleteChange];
      });
    },
    []
  );

  // Add a new row
  const insertRow = useCallback((data: Record<string, unknown>) => {
    setChanges((prev) => {
      // Use negative indices for new rows to distinguish from existing
      const newRowIndex =
        -1 - prev.filter((change) => change.type === "insert").length;

      const insertChange: PendingChange = {
        id: generateChangeId(),
        type: "insert",
        rowIndex: newRowIndex,
        newData: data,
      };
      return [...prev, insertChange];
    });
  }, []);

  // Toggle row selection
  const toggleRowSelection = useCallback((rowIndex: number) => {
    setSelectedRows((prev) => {
      const next = new Set(prev);
      if (next.has(rowIndex)) {
        next.delete(rowIndex);
      } else {
        next.add(rowIndex);
      }
      return next;
    });
  }, []);

  // Select/deselect all rows
  const selectAllRows = useCallback((rowCount: number, selected: boolean) => {
    if (selected) {
      setSelectedRows(new Set(Array.from({ length: rowCount }, (_, i) => i)));
    } else {
      setSelectedRows(new Set());
    }
  }, []);

  // Delete selected rows
  const deleteSelectedRows = useCallback(
    (getRowData: (index: number) => Record<string, unknown>) => {
      selectedRows.forEach((rowIndex) => {
        const rowData = getRowData(rowIndex);
        deleteRow(rowIndex, rowData);
      });
      setSelectedRows(new Set());
    },
    [selectedRows, deleteRow]
  );

  // Undo a specific change
  const undoChange = useCallback((changeId: string) => {
    setChanges((prev) => prev.filter((change) => change.id !== changeId));
  }, []);

  // Discard all changes
  const discardAll = useCallback(() => {
    setChanges([]);
    setEditingCell(null);
    setSelectedRows(new Set());
  }, []);

  // Save all changes to database
  const saveChanges = useCallback(async () => {
    if (!hasChanges) return;

    setSaving(true);

    try {
      // Build WHERE clause from primary key or all columns
      const buildWhereClause = (
        data: Record<string, unknown>
      ): Record<string, unknown> => {
        if (primaryKeyColumns.length > 0) {
          const where: Record<string, unknown> = {};
          primaryKeyColumns.forEach((col) => {
            where[col] = data[col];
          });
          return where;
        }
        // No primary key - use all columns (risky but only option)
        return data;
      };

      // Get the service for this connection (auto-reconnects after hot-reload)
      const service = await DatabaseServiceFactory.getOrReconnect(
        connectionId,
        () => []
      );
      if (!service) {
        throw new Error(`Connection not found: ${connectionId}`);
      }

      // Apply changes in order: deletes first, then updates, then inserts
      const deletes = changes.filter((change) => change.type === "delete");
      const updates = changes.filter((change) => change.type === "update");
      const inserts = changes.filter((change) => change.type === "insert");

      // Execute deletes
      for (const change of deletes) {
        if (change.originalData) {
          const where = buildWhereClause(change.originalData);
          const result = await service.delete(tableName, where);
          if (!result.success) {
            throw new Error(result.error ?? "Delete failed");
          }
        }
      }

      // Execute updates
      for (const change of updates) {
        if (change.originalData && change.newData) {
          const where = buildWhereClause(change.originalData);
          const result = await service.update(tableName, change.newData, where);
          if (!result.success) {
            throw new Error(result.error ?? "Update failed");
          }
        }
      }

      // Execute inserts
      for (const change of inserts) {
        if (change.newData) {
          const result = await service.insert(tableName, change.newData);
          if (!result.success) {
            throw new Error(result.error ?? "Insert failed");
          }
        }
      }

      // Save to file (for SQLite only, other providers auto-persist)
      if (service.save) {
        await service.save();
      }

      // Clear changes on success
      setChanges([]);
      setSelectedRows(new Set());
      onSaveSuccess?.();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      onSaveError?.(message);
    } finally {
      setSaving(false);
    }
  }, [
    hasChanges,
    changes,
    connectionId,
    tableName,
    primaryKeyColumns,
    onSaveSuccess,
    onSaveError,
  ]);

  // Get change type for a row
  const getRowChangeType = useCallback(
    (rowIndex: number): PendingChangeType | null => {
      const change = changes.find(
        (pendingChange) => pendingChange.rowIndex === rowIndex
      );
      return change?.type ?? null;
    },
    [changes]
  );

  // Check if a cell was modified
  const isCellModified = useCallback(
    (rowIndex: number, column: string): boolean => {
      const change = changes.find(
        (pendingChange) =>
          pendingChange.rowIndex === rowIndex && pendingChange.type === "update"
      );
      return change?.newData?.[column] !== undefined;
    },
    [changes]
  );

  // Get the pending value for a cell
  const getPendingValue = useCallback(
    (rowIndex: number, column: string): unknown | undefined => {
      const change = changes.find(
        (pendingChange) =>
          pendingChange.rowIndex === rowIndex && pendingChange.type === "update"
      );
      return change?.newData?.[column];
    },
    [changes]
  );

  return {
    changes,
    hasChanges,
    changeCount,
    editingCell,
    selectedRows,
    saving,
    startEdit,
    cancelEdit,
    updateCell,
    deleteRow,
    insertRow,
    toggleRowSelection,
    selectAllRows,
    deleteSelectedRows,
    undoChange,
    discardAll,
    saveChanges,
    getRowChangeType,
    isCellModified,
    getPendingValue,
  };
}

export default usePendingChanges;
