/**
 * Menu From Routes Utility
 *
 * Converts route configurations to navigation menu items
 * Single source of truth for deriving menu items from routes
 */
import type { LucideIcon } from "lucide-react";

import { ICON_NAME_MAP } from "@src/config/iconMapping";
import type { RouteInfo } from "@src/config/routes";

import type { NavigationMenuItem } from "../components/NavigationMenu/config";

/**
 * Options for customizing menu item conversion
 */
interface RouteToMenuItemOptions {
  /** Override the icon from the route */
  icon?: LucideIcon;
  /** Override the icon key used by hover animation mapping */
  iconName?: string;
  /** Override the label from the route */
  label?: string;
}

/**
 * Convert a route to a navigation menu item
 */
export function routeToMenuItem(
  route: RouteInfo,
  options?: RouteToMenuItemOptions
): NavigationMenuItem {
  const label =
    options?.label ??
    (typeof route.label === "string" ? route.label : route.label({}));
  const icon =
    options?.icon ?? (route.icon ? ICON_NAME_MAP[route.icon] : undefined);
  const iconName = options?.iconName ?? route.icon;

  return {
    id: route.path,
    key: route.path,
    label,
    icon: icon as LucideIcon | string | undefined,
    iconName,
    routePath: route.path,
  };
}
