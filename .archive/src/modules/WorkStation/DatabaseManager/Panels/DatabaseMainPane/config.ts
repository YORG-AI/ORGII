/**
 * DatabaseMainPane Configuration
 *
 * View mode constants and settings.
 */
import { Code, Table } from "lucide-react";

// ============================================
// View Modes
// ============================================

export const VIEW_MODES = {
  table: "table",
  sql: "sql",
} as const;

export type ViewMode = (typeof VIEW_MODES)[keyof typeof VIEW_MODES];

// ============================================
// View Mode Icons
// ============================================

export const VIEW_MODE_ICONS = {
  table: Table,
  sql: Code,
} as const;
