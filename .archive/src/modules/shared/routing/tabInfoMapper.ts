/**
 * Tab Info Mapper
 *
 * Maps route paths to tab information (type, title, path, etc.)
 * Derives from routes.ts instead of duplicating logic.
 *
 * Global route tab types (from routes.ts tabType):
 * - mainApp strip: app
 * - Workstation: workstation, editor
 */
import { findRouteByPath } from "@src/config/routes";
import i18n from "@src/i18n";

/** Path-to-labelKey map for routes where static label does not match route key */
const PATH_TO_LABEL_KEY: Record<string, string> = {};

/**
 * Resolve a localized tab title from navigation namespace.
 * Tries labels.* first (canonical), then routes.*, then static fallback.
 */
function resolveLocalizedTitle(staticLabel: string, path?: string): string {
  const labelKey =
    path && PATH_TO_LABEL_KEY[path]
      ? PATH_TO_LABEL_KEY[path]
      : staticLabel
          .split(/\s+/)
          .map((word, idx) =>
            idx === 0
              ? word.charAt(0).toLowerCase() + word.slice(1)
              : word.charAt(0).toUpperCase() + word.slice(1)
          )
          .join("");

  const fromLabels = i18n.t(`navigation:labels.${labelKey}`, {
    defaultValue: "",
  }) as string;
  if (fromLabels) return fromLabels;

  const fromRoutes = i18n.t(`navigation:routes.${labelKey}`, {
    defaultValue: "",
  }) as string;
  return fromRoutes || staticLabel;
}

/**
 * Tab info returned by the mapper
 */
export interface TabInfo {
  type: "app" | "workstation";
  title: string;
  path: string;
  icon?: string;
}

/**
 * Get tab information from route path
 * Derives from routes.ts configuration
 */
export function getTabInfoFromPath(
  path: string,
  _search?: string
): TabInfo | null {
  // Special cases that don't create tabs
  if (path === "/orgii/marketplace/callback") {
    return null;
  }

  // Derive from routes.ts
  const routeInfo = findRouteByPath(path);
  if (routeInfo) {
    const staticLabel =
      typeof routeInfo.label === "function"
        ? routeInfo.label({})
        : routeInfo.label;
    return {
      type: routeInfo.tabType as TabInfo["type"],
      title: resolveLocalizedTitle(staticLabel, path),
      path: routeInfo.path,
      icon: routeInfo.icon,
    };
  }

  return null;
}
