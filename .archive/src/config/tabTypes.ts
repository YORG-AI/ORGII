/**
 * TAB_TYPE_CONFIG - Global Tab Type Registry
 *
 * 1 tab type for the mainApp view mode:
 * - mainApp: app
 *
 * Note: WorkStation (Editor) has its own internal tab system (file, git-diff, terminal, browser, etc.)
 * defined in src/store/workStationTabs/types.ts - those are NOT global tabs.
 *
 * @property label - Default display name for the tab type
 * @property icon - Lucide icon name (lowercase, hyphenated)
 * @property iconComponent - Lucide icon component
 * @property color - CSS color value using design tokens
 * @property singleton - If true, only one tab of this type can exist
 * @property defaultTitle - Default title when creating a new tab
 * @property defaultRoute - Default route path for this tab type
 * @property canClose - If false, tab cannot be closed (default: true)
 * @property description - Brief description of the tab type
 */
import { Home, type LucideIcon } from "lucide-react";

import { getViewModeForTabType } from "./routeTabMapping";
import { ROUTES } from "./routes";

export { getViewModeForTabType };

// ============================================================================
// START PAGE CONSTANTS - Single source of truth
// ============================================================================

export const START_PAGE = {
  type: "app" as const,
  title: "Start Page",
  route: ROUTES.app.home.start.path,
  icon: "home",
  iconComponent: Home,
} as const;

// ============================================================================
// TAB TYPE CONFIGURATION - 4 Types
// ============================================================================

export const TAB_TYPE_CONFIG = {
  // ---------------------------------------------------------------------------
  // mainApp View Mode
  // ---------------------------------------------------------------------------

  /**
   * App tab - General pages in mainApp view
   * Covers: Start Page, Settings, Files, Explore, Market, Shortcuts, Code Search, Git Status, etc.
   * Note: canClose=true here, but isTabClosable() handles Start Page special case
   */
  app: {
    label: "App",
    icon: "home",
    iconComponent: Home,
    color: "var(--color-primary-6)",
    singleton: true, // Singleton by routePath, not by type
    defaultTitle: START_PAGE.title,
    defaultRoute: START_PAGE.route,
    canClose: true, // Individual app tabs can close; Start Page handled by isTabClosable()
    description: "General app pages - settings, files, explore, market, etc.",
  },
} as const;

// ============================================================================
// DERIVED TYPES
// ============================================================================

/**
 * Union type of all valid tab types (6 types)
 */
export type TabType = keyof typeof TAB_TYPE_CONFIG;

/**
 * Configuration type for a single tab
 */
export type TabTypeConfig = (typeof TAB_TYPE_CONFIG)[TabType];

/**
 * Tab types that are singletons
 */
export type SingletonTabType = {
  [K in TabType]: (typeof TAB_TYPE_CONFIG)[K]["singleton"] extends true
    ? K
    : never;
}[TabType];

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Get configuration for a specific tab type
 */
export function getTabConfig(type: TabType): TabTypeConfig {
  return TAB_TYPE_CONFIG[type];
}

/**
 * Check if a tab type is a singleton
 */
export function isSingletonType(type: TabType): boolean {
  return TAB_TYPE_CONFIG[type]?.singleton ?? false;
}

/**
 * Get the icon component for a tab type
 */
export function getTabIcon(type: TabType): LucideIcon | null {
  return TAB_TYPE_CONFIG[type]?.iconComponent ?? null;
}

/**
 * Get the color for a tab type
 */
export function getTabColor(type: TabType): string {
  return TAB_TYPE_CONFIG[type]?.color ?? "var(--color-neutral-6)";
}

/**
 * Get the label for a tab type
 */
export function getTabLabel(type: TabType): string {
  return TAB_TYPE_CONFIG[type]?.label ?? type;
}

/**
 * Get the default title for a tab type
 */
export function getDefaultTabTitle(type: TabType): string {
  return TAB_TYPE_CONFIG[type]?.defaultTitle ?? type;
}

/**
 * Get the default route for a tab type
 */
export function getDefaultTabRoute(type: TabType): string | undefined {
  return TAB_TYPE_CONFIG[type]?.defaultRoute;
}

/**
 * Check if a tab type can be closed (basic check)
 */
export function canTabTypeClose(type: TabType): boolean {
  return TAB_TYPE_CONFIG[type]?.canClose ?? true;
}

/**
 * Check if a tab is the Start Page
 */
export function isStartPage(tab: { type: string; title: string }): boolean {
  return tab.type === START_PAGE.type && tab.title === START_PAGE.title;
}

/**
 * Check if a tab can be closed (context-aware)
 *
 * Rules:
 * - Start Page: Can close only if there are other tabs (it's the fallback)
 * - Other tabs: Check canClose from config
 */
export function isTabClosable(
  tab: { type: string; title: string },
  tabsInViewMode: number
): boolean {
  // Start Page: Can close only if there are other tabs
  if (isStartPage(tab)) {
    return tabsInViewMode > 1;
  }

  // Other tabs: check config
  return canTabTypeClose(tab.type as TabType);
}

/**
 * Create a new Start Page tab object
 */
export function createStartPageTab(id: string, order: number = 0) {
  return {
    id,
    type: START_PAGE.type,
    title: START_PAGE.title,
    status: "idle" as const,
    hasUnsavedChanges: false,
    order,
    icon: START_PAGE.icon,
    routePath: START_PAGE.route,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/**
 * Get all tab types
 */
export function getAllTabTypes(): TabType[] {
  return Object.keys(TAB_TYPE_CONFIG) as TabType[];
}

/**
 * Check if a string is a valid tab type
 */
export function isValidTabType(type: string): type is TabType {
  return type in TAB_TYPE_CONFIG;
}

// ============================================================================
// TAB CATEGORY LABELS (for UI display)
// ============================================================================

export function getTabCategoryLabels(): Record<
  string,
  { label: string; color: string }
> {
  const labels: Record<string, { label: string; color: string }> = {};
  for (const [type, config] of Object.entries(TAB_TYPE_CONFIG)) {
    labels[type] = {
      label: config.label,
      color: config.color,
    };
  }
  return labels;
}

export const TAB_CATEGORY_LABELS = getTabCategoryLabels();

// ============================================================================
// ICON NAME MAPPING
// ============================================================================

export { ICON_NAME_MAP, getIconByName } from "./iconMapping";
