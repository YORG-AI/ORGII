/**
 * DatabaseLayout Configuration
 *
 * Constants and configuration for the Database Manager layout.
 */
import type { TFunction } from "i18next";

import { getShortcutKeys } from "@src/config/keyboard/shortcutDisplay";
import type { QuickAction } from "@src/modules/WorkStation/shared";

// ============================================
// Types
// ============================================

export interface DatabaseQuickActionsOptions {
  t: TFunction;
  onOpenSpotlight: () => void;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
}

// ============================================
// Quick Actions
// ============================================

/**
 * Creates quick actions for the database manager placeholder.
 * Factory function to inject spotlight dependency.
 */
export function createDatabaseQuickActions(
  options: DatabaseQuickActionsOptions
): QuickAction[] {
  const { t, onOpenSpotlight, sidebarCollapsed, onToggleSidebar } = options;

  return [
    {
      id: "connections",
      label: t("commands.connections"),
      shortcut: getShortcutKeys("db_connections"),
    },
    {
      id: "run-query",
      label: t("commands.runQuery"),
      shortcut: getShortcutKeys("db_run_query"),
    },
    {
      id: "search-files",
      label: t("commands.searchFiles"),
      shortcut: getShortcutKeys("quick_open"),
      onAction: onOpenSpotlight,
    },
    {
      id: "toggle-sidebar",
      label: sidebarCollapsed
        ? t("commands.showPrimarySidebar")
        : t("commands.hidePrimarySidebar"),
      shortcut: getShortcutKeys("db_sidebar"),
      onAction: onToggleSidebar,
    },
  ];
}
