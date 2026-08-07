/**
 * DatabasePrimarySidebar Configuration
 *
 * Icons, constants, and settings for the sidebar.
 */
import { Cloud, Database, History, Plus } from "lucide-react";

// ============================================
// Tab Icons
// ============================================

export const SIDEBAR_ICONS = {
  connections: Database,
  history: History,
  addRemote: Cloud,
  addSqlite: Plus,
} as const;

// ============================================
// Tab Keys
// ============================================

export const SIDEBAR_TAB_KEYS = {
  connections: "connections",
  history: "history",
} as const;

export type SidebarTabKey =
  (typeof SIDEBAR_TAB_KEYS)[keyof typeof SIDEBAR_TAB_KEYS];
