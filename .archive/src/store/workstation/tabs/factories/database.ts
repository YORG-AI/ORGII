/**
 * Database Tab Factories
 *
 * Tab factories for the database explorer using defineTabFactory.
 */
import { defineTabFactory } from "../tabFactory";
import type { WorkStationTab } from "../types";

// ============================================
// Table Tab
// ============================================

export interface TableTabData {
  connectionId: string;
  tableName: string;
  connectionName?: string;
}

export const tableTabFactory = defineTabFactory<TableTabData>({
  tabType: "table",
  idStrategy: {
    type: "keyed",
    prefix: "table",
    getKey: (data) => `${data.connectionId}:${data.tableName}`,
  },
  getTitle: (data) => data.tableName,
});

export function createTableTab(
  connectionId: string,
  tableName: string,
  connectionName?: string
): WorkStationTab {
  return tableTabFactory({ connectionId, tableName, connectionName });
}

// ============================================
// Query Tab (unique per instance)
// ============================================

export interface QueryTabData {
  connectionId: string;
  connectionName?: string;
  queryText: string;
}

export const queryTabFactory = defineTabFactory<QueryTabData>({
  tabType: "query",
  idStrategy: { type: "unique", prefix: "query" },
  getTitle: (data) =>
    data.connectionName ? `Query - ${data.connectionName}` : "Query",
});

export function createQueryTab(
  connectionId: string,
  connectionName?: string,
  initialQuery?: string
): WorkStationTab {
  return queryTabFactory({
    connectionId,
    connectionName,
    queryText: initialQuery || "",
  });
}

// ============================================
// Schema Tab
// ============================================

export interface SchemaTabData {
  connectionId: string;
  connectionName?: string;
}

export const schemaTabFactory = defineTabFactory<SchemaTabData>({
  tabType: "schema",
  idStrategy: {
    type: "keyed",
    prefix: "schema",
    getKey: (data) => data.connectionId,
  },
  getTitle: (data) =>
    data.connectionName ? `Schema - ${data.connectionName}` : "Schema",
});

export function createSchemaTab(
  connectionId: string,
  connectionName?: string
): WorkStationTab {
  return schemaTabFactory({ connectionId, connectionName });
}

// ============================================
// Add Connection Tab (unique)
// ============================================

export const addConnectionTabFactory = defineTabFactory<Record<string, never>>({
  tabType: "add-connection",
  idStrategy: { type: "unique", prefix: "add-connection" },
  getTitle: () => "Add",
  icon: "Plus",
});

export function createAddConnectionTab(): WorkStationTab {
  const tab = addConnectionTabFactory({});
  return { ...tab, hasUnsavedChanges: false };
}
