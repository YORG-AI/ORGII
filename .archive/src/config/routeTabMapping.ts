/**
 * Route-Tab Type Mapping
 *
 * This module serves as a bridge between routes and tab types,
 * breaking the circular dependency between routes.ts and tabTypes.ts
 *
 * Dependency Order:
 * types/routing.ts -> routeTabMapping.ts -> tabTypes.ts -> routes.ts
 */
import type { ViewModeType } from "./viewModeTypes";

// ============================================================================
// SHARED TYPES
// ============================================================================

/** Context for dynamic labels */
export interface RouteLabelContext {
  repoId?: string;
  repoName?: string;
  workItemId?: string;
  workItemName?: string;
  [key: string]: string | undefined;
}

/** Route metadata */
export interface RouteInfo {
  /** The route path */
  path: string;
  /** Display label - static or dynamic */
  label: string | ((context: RouteLabelContext) => string);
  /** View mode for this route */
  viewMode: ViewModeType;
  /** Associated tab type (matches TabType in tabTypes.ts) */
  tabType: string;
  /** Description for documentation */
  description?: string;
  /** Icon name (lucide lowercase-hyphen format, e.g., "git-compare-arrows") */
  icon?: string;
}

// ============================================================================
// VIEW MODE MAPPING - Single Source of Truth
// ============================================================================

/**
 * Determine which view mode a tab type belongs to
 * This is the SINGLE SOURCE OF TRUTH for tab type → view mode mapping
 *
 * Tab types mapped to view mode:
 * - mainApp: default (e.g. app)
 * - workStation: workstation, editor
 */
export function getViewModeForTabType(tabType: string): ViewModeType {
  // Workstation view mode
  if (tabType === "editor" || tabType === "workstation") {
    return "workStation";
  }
  // mainApp view mode (default)
  return "mainApp";
}

// ============================================================================
// DEFAULT ROUTES - Re-exported from routes.ts
// ============================================================================
