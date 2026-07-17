/**
 * DatabaseMainPane Component
 *
 * Main content pane for Database Manager showing:
 * - Table data viewer with DataGrid
 * - CRUD operations (insert, update, delete)
 * - SQL query editor with execution
 * - Query results display
 */
import React, {
  Suspense,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

import {
  type ColumnInfo,
  DatabaseServiceFactory,
  type QueryResult,
} from "@src/engines/DatabaseCore";
import { usePendingChanges, useQueryHistory } from "@src/hooks/database";
import { FileHeader, UnsavedChangesBar } from "@src/modules/WorkStation/shared";
import { Placeholder } from "@src/modules/shared/layouts/blocks";

import DataGrid from "./components/DataGrid";
import ActionBar from "./components/DataGrid/ActionBar";
import InsertRowModal from "./components/DataGrid/InsertRowModal";
import { VIEW_MODES, type ViewMode } from "./config";
import type { DatabaseMainPaneProps } from "./types";

// Lazy-load CodeMirror-based SQL components to avoid parsing ~200KB+ on initial load
const SqlQueryEditor = React.lazy(
  () => import("@src/features/CodeMirror/SqlEditor")
);
const QueryResults = React.lazy(
  () => import("@src/features/CodeMirror/SqlEditor/QueryResults")
);

// ============================================
// Component
// ============================================

export const DatabaseMainPane: React.FC<DatabaseMainPaneProps> = memo(
  ({
    connectionId,
    tableName,
    repoPath: _repoPath,
    tables = [],
    onRegisterExecuteQuery,
  }) => {
    // View mode: table data or SQL query
    const [viewMode, setViewMode] = useState<ViewMode>(VIEW_MODES.table);

    // Table data state
    const [tableData, setTableData] = useState<QueryResult | null>(null);
    const [tableSchema, setTableSchema] = useState<ColumnInfo[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // SQL query state
    const [queryResult, setQueryResult] = useState<QueryResult | null>(null);
    const [queryError, setQueryError] = useState<string | null>(null);
    const [queryLoading, setQueryLoading] = useState(false);

    // Insert modal state
    const [showInsertModal, setShowInsertModal] = useState(false);

    // Query history
    const queryHistory = useQueryHistory(connectionId ?? "");

    // Pending changes management
    const pendingChanges = usePendingChanges({
      connectionId: connectionId ?? "",
      tableName: tableName ?? "",
      schema: tableSchema,
      onSaveSuccess: () => {
        // Reload data after successful save
        loadTableData();
      },
      onSaveError: (errorMsg) => {
        setError(`Save failed: ${errorMsg}`);
      },
    });

    // Load table data when connection/table changes
    const loadTableData = useCallback(async () => {
      if (!connectionId || !tableName) {
        setTableData(null);
        setTableSchema([]);
        return;
      }

      setIsLoading(true);
      setError(null);

      try {
        // Get the service for this connection (auto-reconnects after hot-reload)
        const service = await DatabaseServiceFactory.getOrReconnect(
          connectionId,
          () => []
        );
        if (!service) {
          throw new Error(`Connection not found: ${connectionId}`);
        }

        // Load schema and data in parallel
        const [schema, data] = await Promise.all([
          service.getTableSchema(tableName),
          service.getTableData(tableName, { pageSize: 500 }),
        ]);

        setTableSchema(schema);
        setTableData(data);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        setTableData(null);
        setTableSchema([]);
      } finally {
        setIsLoading(false);
      }
    }, [connectionId, tableName]);

    // Load data when table changes
    useEffect(() => {
      loadTableData();
      // Clear pending changes when switching tables
      pendingChanges.discardAll();
      // Switch to table view when table changes
      setViewMode(VIEW_MODES.table);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [loadTableData]);

    // Execute SQL query
    const handleExecuteQuery = useCallback(
      async (sql: string) => {
        if (!connectionId) return;

        setQueryLoading(true);
        setQueryError(null);

        const startTime = performance.now();

        try {
          // Get the service for this connection (auto-reconnects after hot-reload)
          const service = await DatabaseServiceFactory.getOrReconnect(
            connectionId,
            () => []
          );
          if (!service) {
            throw new Error(`Connection not found: ${connectionId}`);
          }

          const result = await service.query(sql);
          const duration = performance.now() - startTime;

          setQueryResult({ ...result, duration });
          setQueryError(null);

          // Add to history
          queryHistory.addQuery({
            sql,
            duration,
            success: true,
            rowCount: result.rowCount,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const duration = performance.now() - startTime;

          setQueryError(message);
          setQueryResult(null);

          // Add failed query to history
          queryHistory.addQuery({
            sql,
            duration,
            success: false,
            error: message,
          });
        } finally {
          setQueryLoading(false);
        }
      },
      [connectionId, queryHistory]
    );

    // Expose executeQuery to parent (for sidebar history "Run" button)
    useEffect(() => {
      onRegisterExecuteQuery?.(handleExecuteQuery);
    }, [onRegisterExecuteQuery, handleExecuteQuery]);

    // Get row data by index
    const getRowData = useCallback(
      (rowIndex: number): Record<string, unknown> => {
        if (!tableData?.columns || !tableData?.values?.[rowIndex]) return {};
        const obj: Record<string, unknown> = {};
        tableData.columns.forEach((col, idx) => {
          obj[col] = tableData.values[rowIndex][idx];
        });
        return obj;
      },
      [tableData]
    );

    // Handle insert row
    const handleInsert = useCallback(
      (data: Record<string, unknown>) => {
        pendingChanges.insertRow(data);
      },
      [pendingChanges]
    );

    // Handle delete selected rows
    const handleDeleteSelected = useCallback(() => {
      pendingChanges.deleteSelectedRows(getRowData);
    }, [pendingChanges, getRowData]);

    // Handle cell double-click to start editing
    const handleCellDoubleClick = useCallback(
      (_row: unknown[], column: string, rowIndex: number) => {
        pendingChanges.startEdit(rowIndex, column);
      },
      [pendingChanges]
    );

    // Toggle options for Table/SQL view mode
    const toggleOptions = useMemo(
      () => [
        {
          value: VIEW_MODES.table,
          label: "Table",
          title: tableName ? "Table view" : "Select a table first",
          disabled: !tableName,
        },
        {
          value: VIEW_MODES.sql,
          label: "SQL",
          title: "SQL query",
        },
      ],
      [tableName]
    );

    // Show SQL editor when in SQL mode (even without table selected)
    if (viewMode === VIEW_MODES.sql) {
      return (
        <div className="flex h-full flex-col">
          {/* Header with view mode toggle */}
          <FileHeader
            filePath="SQL Query"
            toggleOptions={toggleOptions}
            toggleValue={viewMode}
            onToggleChange={(value) => setViewMode(value as ViewMode)}
            onReload={loadTableData}
            loading={isLoading}
          />

          {/* SQL Editor and Results - split view (lazy-loaded) */}
          <Suspense
            fallback={
              <Placeholder
                variant="loading"
                placement="detail-panel"
                fillParentHeight
              />
            }
          >
            <div className="flex min-h-0 flex-1 flex-col">
              {/* Editor section */}
              <div className="h-[200px] min-h-[120px] border-b border-border-1">
                <SqlQueryEditor
                  defaultValue={
                    tableName ? `SELECT * FROM "${tableName}" LIMIT 100;` : ""
                  }
                  onExecute={handleExecuteQuery}
                  tables={tables}
                  loading={queryLoading}
                  history={queryHistory.history}
                  onHistorySelect={(sql) => handleExecuteQuery(sql)}
                />
              </div>

              {/* Results section */}
              <div className="min-h-0 flex-1 overflow-hidden">
                <QueryResults
                  result={queryResult}
                  error={queryError}
                  loading={queryLoading}
                />
              </div>
            </div>
          </Suspense>
        </div>
      );
    }

    // Table data view with DataGrid
    return (
      <div className="flex h-full flex-col">
        {/* Header with view mode toggle */}
        <FileHeader
          filePath={tableName ?? ""}
          toggleOptions={toggleOptions}
          toggleValue={viewMode}
          onToggleChange={(value) => setViewMode(value as ViewMode)}
          onReload={loadTableData}
          loading={isLoading}
        />

        {/* Action Bar for CRUD operations */}
        <ActionBar
          selectedCount={pendingChanges.selectedRows.size}
          changeCount={pendingChanges.changeCount}
          onInsert={() => setShowInsertModal(true)}
          onDeleteSelected={handleDeleteSelected}
          onDiscard={pendingChanges.discardAll}
        />

        {/* Content area - DataGrid */}
        <div className="min-h-0 flex-1 overflow-hidden">
          <DataGrid
            data={tableData}
            schema={tableSchema}
            loading={isLoading}
            error={error}
            tableName={tableName ?? undefined}
            editable={true}
            selectedRows={pendingChanges.selectedRows}
            editingCell={pendingChanges.editingCell}
            getRowChangeType={pendingChanges.getRowChangeType}
            isCellModified={pendingChanges.isCellModified}
            getPendingValue={pendingChanges.getPendingValue}
            onCellDoubleClick={handleCellDoubleClick}
            onRowSelect={pendingChanges.toggleRowSelection}
            onSelectAll={(selected) =>
              pendingChanges.selectAllRows(
                tableData?.values?.length ?? 0,
                selected
              )
            }
            onCellSave={pendingChanges.updateCell}
            onCellCancel={pendingChanges.cancelEdit}
          />
        </div>

        {/* Unsaved Changes Bar - reused from file editor */}
        {pendingChanges.hasChanges && (
          <UnsavedChangesBar
            message={`${pendingChanges.changes.length} pending change${pendingChanges.changes.length !== 1 ? "s" : ""}`}
            saving={pendingChanges.saving}
            onSave={pendingChanges.saveChanges}
            onDiscard={pendingChanges.discardAll}
          />
        )}

        {/* Insert Row Modal */}
        <InsertRowModal
          isOpen={showInsertModal}
          tableName={tableName ?? ""}
          schema={tableSchema}
          onInsert={handleInsert}
          onClose={() => setShowInsertModal(false)}
        />
      </div>
    );
  }
);

DatabaseMainPane.displayName = "DatabaseMainPane";

export default DatabaseMainPane;
