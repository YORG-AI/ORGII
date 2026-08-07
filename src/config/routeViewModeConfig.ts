/**
 * Route-Level ViewMode Configuration
 *
 * This file provides ViewMode lookup for routes.
 * The primary source of truth is the route (location.pathname).
 *
 * ## Usage
 *
 * For React components, use the hook:
 * ```tsx
 * const viewMode = useRouteViewMode();
 * ```
 *
 * For non-React code, use the function:
 * ```ts
 * const viewMode = getViewModeForRoute(pathname);
 * ```
 *
 * ## Architecture
 *
 * Route (pathname) is the SINGLE SOURCE OF TRUTH for viewMode.
 * - useRouteViewMode(): Canonical hook for React components
 * - getViewModeForRoute(): Underlying function for derivation
 * - viewModeAtom: Internal only - used by ViewModeSync for bidirectional sync
 */
import { useMemo } from "react";
import { useLocation } from "react-router-dom";

import { findRouteByPath } from "./routes";
import type { AppModeType, ViewModeType } from "./viewModeTypes";

export type { ViewModeType, AppModeType };

/**
 * Route pattern configuration with ViewMode
 * Used for prefix/regex matching when exact route lookup fails
 */
export interface RoutePatternConfig {
  /** Route path pattern (supports exact match, prefix, or regex) */
  pattern: string | RegExp;
  /** Matching strategy */
  match: "exact" | "prefix" | "regex";
  /** ViewMode for this route */
  viewMode: ViewModeType;
  /** Optional: Should this route save to previousRoute when navigating away? */
  saveToPreviousRoute?: boolean;
  /** Optional: Description for documentation */
  description?: string;
}

/**
 * Additional route patterns for prefix/regex matching
 * These are fallbacks when the exact route lookup in routes.ts doesn't match.
 * Most routes are now defined in routes.ts, so this is minimal.
 *
 * Order matters! Routes are matched from top to bottom.
 * Put more specific patterns before general ones.
 */
export const ROUTE_VIEW_MODE_PATTERNS: RoutePatternConfig[] = [
  {
    pattern: "/orgii/workstation",
    match: "prefix",
    viewMode: "workStation",
    saveToPreviousRoute: false,
    description:
      "Workstation view mode routes (Code Editor, Database, Browser, Chat, Project Manager)",
  },
  {
    // Settings shares WorkStation chrome so the WorkStation surface stays
    // visible behind the slot — see APP_SETTINGS_ROUTE for the canonical entry.
    pattern: "/orgii/app/settings",
    match: "prefix",
    viewMode: "workStation",
    saveToPreviousRoute: false,
    description: "Settings — rendered as a slot occupant over WorkStation",
  },
  {
    pattern: "/orgii/",
    match: "prefix",
    viewMode: "mainApp",
    saveToPreviousRoute: true,
    description: "Default fallback for all /orgii routes",
  },
];

/**
 * Get ViewMode configuration for a given pathname
 * First tries exact match from routes.ts, then falls back to pattern matching.
 *
 * @param pathname - Current route pathname (from location.pathname)
 * @returns Route configuration or null if no match
 */
export function getRouteConfig(pathname: string): RoutePatternConfig | null {
  // First try exact route lookup from routes.ts
  const routeInfo = findRouteByPath(pathname);
  if (routeInfo) {
    return {
      pattern: routeInfo.path,
      match: "exact",
      viewMode: routeInfo.viewMode,
      saveToPreviousRoute: routeInfo.viewMode !== "workStation",
      description: routeInfo.description,
    };
  }

  // Fall back to pattern matching
  for (const config of ROUTE_VIEW_MODE_PATTERNS) {
    const matches = matchRoute(pathname, config.pattern, config.match);
    if (matches) {
      return config;
    }
  }

  return null;
}

/**
 * Get ViewMode for a given pathname
 * Uses routes.ts as primary source, with pattern fallback.
 *
 * @param pathname - Current route pathname
 * @returns ViewMode for this route, defaults to 'mainApp' if no match
 */
export function getViewModeForRoute(pathname: string): ViewModeType {
  // Primary: Use routes.ts lookup
  const routeInfo = findRouteByPath(pathname);
  if (routeInfo) {
    return routeInfo.viewMode;
  }

  // Fallback: Prefix matching for dynamic paths
  if (pathname.startsWith("/orgii/workstation")) {
    return "workStation";
  }
  if (pathname.startsWith("/orgii/app/settings")) {
    return "workStation";
  }

  return "mainApp";
}

/**
 * React hook to get ViewMode from current route.
 *
 * This is the CANONICAL way to read viewMode in React components.
 * It derives viewMode synchronously from location.pathname, preventing
 * flash/layout issues that occur with async atom updates.
 *
 * @returns Current ViewMode based on route
 *
 * @example
 * ```tsx
 * const viewMode = useRouteViewMode();
 * // viewMode is "mainApp" | "workStation"
 * ```
 */
export function useRouteViewMode(): ViewModeType {
  const location = useLocation();
  return useMemo(
    () => getViewModeForRoute(location.pathname),
    [location.pathname]
  );
}

/**
 * Check if route should save to previousRoute when navigating away
 *
 * @param pathname - Current route pathname
 * @returns true if should save to previousRoute
 */
export function shouldSaveToPreviousRoute(pathname: string): boolean {
  const config = getRouteConfig(pathname);
  return config?.saveToPreviousRoute ?? true;
}

/**
 * Match a pathname against a route pattern
 */
function matchRoute(
  pathname: string,
  pattern: string | RegExp,
  matchType: "exact" | "prefix" | "regex"
): boolean {
  if (pattern instanceof RegExp) {
    return pattern.test(pathname);
  }

  switch (matchType) {
    case "exact":
      return pathname === pattern;
    case "prefix":
      return pathname.startsWith(pattern);
    case "regex":
      return new RegExp(pattern).test(pathname);
    default:
      return false;
  }
}

/**
 * Get human-readable description of current route's ViewMode
 *
 * @param pathname - Current route pathname
 * @returns Description or null
 */
export function getRouteDescription(pathname: string): string | null {
  const config = getRouteConfig(pathname);
  return config?.description ?? null;
}

// ============================================================================
// APP MODE (Workstation sub-navigation)
// ============================================================================

/**
 * Get AppMode for a given pathname within Workstation view.
 * Returns the app mode based on route, or "code" as default.
 *
 * @param pathname - Current route pathname
 * @returns AppMode for Workstation
 */
export function getAppModeForRoute(pathname: string): AppModeType {
  if (pathname.startsWith("/orgii/workstation/browser")) {
    return "browser";
  }
  if (pathname.startsWith("/orgii/workstation/chat")) {
    return "chat";
  }
  if (pathname.startsWith("/orgii/workstation/project")) {
    return "project";
  }
  return "code";
}

/**
 * React hook to get AppMode from current route.
 * Use this in Workstation components to determine which app to show.
 *
 * @returns Current AppMode based on route
 *
 * @example
 * ```tsx
 * const appMode = useRouteAppMode();
 * // appMode is "code" | "browser" | "chat" | "project"
 * ```
 */
export function useRouteAppMode(): AppModeType {
  const location = useLocation();
  return useMemo(
    () => getAppModeForRoute(location.pathname),
    [location.pathname]
  );
}
