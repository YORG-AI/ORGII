/**
 * DatabaseManager Configuration
 *
 * Centralized configuration for icons, constants, and settings.
 */
import { Database, History } from "lucide-react";

import { WORK_STATION_PRIMARY_SIDEBAR } from "@src/config/workStationPrimarySidebar";

// ============================================
// Sidebar Tab Configuration
// ============================================

/** Sidebar tab config - label values are i18n keys, resolve with t() at render time */
export const SIDEBAR_TABS = {
  connections: {
    key: "connections",
    label: "tabs.connections",
    icon: Database,
  },
  history: {
    key: "history",
    label: "tabs.queryHistory",
    icon: History,
  },
} as const;

// ============================================
// Layout Constants
// ============================================

export const SIDEBAR_CONFIG = {
  defaultWidth: WORK_STATION_PRIMARY_SIDEBAR.defaultWidth,
  minWidth: WORK_STATION_PRIMARY_SIDEBAR.minWidth,
  maxWidth: WORK_STATION_PRIMARY_SIDEBAR.maxWidth,
} as const;

// ============================================
// View Modes
// ============================================

export const VIEW_MODES = {
  table: "table",
  sql: "sql",
} as const;

export type ViewMode = (typeof VIEW_MODES)[keyof typeof VIEW_MODES];
