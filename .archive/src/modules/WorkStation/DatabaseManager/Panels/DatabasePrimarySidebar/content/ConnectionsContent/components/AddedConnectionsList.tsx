/**
 * AddedConnectionsList Component
 *
 * Renders the list of opened/added database connections.
 * Used in the "Added Connections" section of the sidebar.
 */
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Table,
  X,
} from "lucide-react";
import React, { memo } from "react";
import { useTranslation } from "react-i18next";

import { TreeRowBase, type TreeRowNode } from "@src/components/TreeRow";
import { useRefreshSpin } from "@src/hooks/ui";
import { HUMANTOOLS_TEXT_KEYS } from "@src/modules/WorkStation/shared";
import { HEADER_BUTTON } from "@src/modules/WorkStation/shared/tokens";
import { Placeholder } from "@src/modules/shared/layouts/blocks";
import type { DatabaseConnection } from "@src/store/workstation/database";

// ============================================
// Types
// ============================================

export interface AddedConnectionsListProps {
  connections: DatabaseConnection[];
  selectedConnectionId: string | null;
  selectedTable: string | null;
  error?: string | null;
  onToggleConnection: (connectionId: string) => void;
  onSelectTable: (connectionId: string, tableName: string) => void;
  onRefreshConnection: (event: React.MouseEvent, connectionId: string) => void;
  onCloseConnection: (event: React.MouseEvent, connectionId: string) => void;
}

// ============================================
// Connection Refresh Button (per-row useRefreshSpin)
// ============================================

const ConnectionRefreshButton: React.FC<{
  connectionId: string;
  isLoading: boolean;
  onRefreshConnection: (event: React.MouseEvent, connectionId: string) => void;
}> = memo(({ connectionId, isLoading, onRefreshConnection }) => {
  const { t } = useTranslation();
  const { spinClass, handleClick } = useRefreshSpin(
    () =>
      onRefreshConnection(
        {
          stopPropagation: () => {},
          preventDefault: () => {},
        } as React.MouseEvent,
        connectionId
      ),
    isLoading
  );
  return (
    <button
      className={`${HEADER_BUTTON.actionTreeRow} hidden shrink-0 group-focus-within/item:flex group-hover/item:flex`}
      onClick={(e) => {
        e.stopPropagation();
        handleClick();
      }}
      title={t("tooltips.refreshTables")}
    >
      <RefreshCw
        size={14}
        strokeWidth={1.75}
        className={`text-text-2 ${spinClass ?? ""}`}
      />
    </button>
  );
});
ConnectionRefreshButton.displayName = "ConnectionRefreshButton";

// ============================================
// Component
// ============================================

export const AddedConnectionsList: React.FC<AddedConnectionsListProps> = memo(
  ({
    connections,
    selectedConnectionId,
    selectedTable,
    error,
    onToggleConnection,
    onSelectTable,
    onRefreshConnection,
    onCloseConnection,
  }) => {
    const { t } = useTranslation();
    return (
      <div className="flex h-full flex-col overflow-y-auto scrollbar-hide">
        {/* Error message */}
        {error && <Placeholder variant="error" title={error} />}

        {/* Connection list */}
        {connections.map((connection) => {
          const node: TreeRowNode = {
            id: connection.id,
            name: connection.name,
            path: connection.path,
            type: "directory",
            expanded: connection.isExpanded,
            icon: connection.isExpanded ? (
              <ChevronDown
                size={14}
                strokeWidth={1.75}
                className="text-text-2"
              />
            ) : (
              <ChevronRight
                size={14}
                strokeWidth={1.75}
                className="text-text-2"
              />
            ),
          };

          return (
            <div key={connection.id}>
              <TreeRowBase
                node={node}
                depth={0}
                isSelected={
                  selectedConnectionId === connection.id && !selectedTable
                }
                onClick={() => onToggleConnection(connection.id)}
              >
                {/* Error indicator */}
                {connection.error && (
                  <span className="mr-1 text-danger-6" title={connection.error}>
                    <AlertCircle size={14} strokeWidth={1.75} />
                  </span>
                )}

                {/* Refresh button (on hover) */}
                <ConnectionRefreshButton
                  connectionId={connection.id}
                  isLoading={connection.isLoading}
                  onRefreshConnection={onRefreshConnection}
                />

                {/* Close button (on hover) */}
                <button
                  className={`group/close ${HEADER_BUTTON.danger} hidden shrink-0 group-focus-within/item:flex group-hover/item:flex`}
                  onClick={(event) => onCloseConnection(event, connection.id)}
                  title={t("tooltips.closeConnection")}
                >
                  <X
                    size={14}
                    strokeWidth={1.75}
                    className="text-text-2 group-hover/close:text-danger-6"
                  />
                </button>
              </TreeRowBase>

              {/* Tables */}
              {connection.isExpanded && (
                <>
                  {connection.isLoading ? (
                    <Placeholder variant="loading" />
                  ) : connection.tables.length === 0 ? (
                    <Placeholder
                      variant={connection.error ? "error" : "empty"}
                      title={
                        connection.error
                          ? t(HUMANTOOLS_TEXT_KEYS.placeholders.connectionError)
                          : t(HUMANTOOLS_TEXT_KEYS.placeholders.noTables)
                      }
                    />
                  ) : (
                    connection.tables.map((table) => {
                      const tableNode: TreeRowNode = {
                        id: `${connection.id}:${table.name}`,
                        name: table.name,
                        path: table.name,
                        type: "file",
                        icon: (
                          <Table
                            size={14}
                            strokeWidth={1.75}
                            className="text-text-2"
                          />
                        ),
                      };
                      return (
                        <TreeRowBase
                          key={table.name}
                          node={tableNode}
                          depth={1}
                          isSelected={
                            selectedConnectionId === connection.id &&
                            selectedTable === table.name
                          }
                          onClick={() =>
                            onSelectTable(connection.id, table.name)
                          }
                        >
                          {table.rowCount !== undefined && (
                            <span className="shrink-0 text-[10px] text-text-4">
                              {table.rowCount.toLocaleString()}
                            </span>
                          )}
                        </TreeRowBase>
                      );
                    })
                  )}
                </>
              )}
            </div>
          );
        })}

        {/* Empty state */}
        {connections.length === 0 && (
          <Placeholder
            variant="empty"
            title={t(HUMANTOOLS_TEXT_KEYS.placeholders.noConnections)}
          />
        )}
      </div>
    );
  }
);

AddedConnectionsList.displayName = "AddedConnectionsList";

export default AddedConnectionsList;
