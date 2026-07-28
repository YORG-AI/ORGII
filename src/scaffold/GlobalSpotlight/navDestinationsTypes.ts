/**
 * Leaf type module for the Global Spotlight navigation destinations.
 *
 * Lives apart from `navDestinations.ts` so that
 * `navDestinationGroups.ts` and `navDestinationsSearch.ts` can share
 * the type definitions without importing the destination registry
 * itself (which would create a cycle).
 */
import type { ComponentType } from "react";

export type NavDestinationGroup =
  | "pages"
  | "settings"
  | "integrations"
  | "market"
  | "actions";

export interface NavDestination {
  /** Stable id used as React key and for spotlight item id. */
  id: string;
  /** Target route path (fully qualified — includes any nested segments
   *  and `?query` for detail selection). Label, description, and
   *  icon are all derived from this path via the central
   *  `SEGMENT_REGISTRY` so spotlight entries never diverge from the
   *  sidebar / breadcrumb / page-title labels. */
  path: string;
  /** Icon (resolved from `SEGMENT_REGISTRY` via the path at
   *  construction time — never set manually in the destination
   *  arrays; use the `dest()` helper in `navDestinations.ts`). */
  icon: ComponentType<Record<string, unknown>>;
  /** Additional search terms (besides label / path). */
  keywords?: string[];
  /** Visual group for headered rendering. */
  group: NavDestinationGroup;
  /** Optional namespaced i18n key (e.g. `"integrations:addOptions.addMcp"`)
   *  that overrides the auto-derived breadcrumb leaf label. Used by
   *  wizard-action entries where the visible name ("Add MCP Server")
   *  differs from the host page's breadcrumb leaf ("MCP"). */
  labelKey?: string;
  /** Optional breadcrumb suffix for query-param backed tabs. */
  descriptionSuffixKey?: string;
  /** Whether this destination should appear in Spotlight search results. */
  searchable?: boolean;
  /** Hide this destination unless the app's Dev Mode setting is enabled. */
  devOnly?: boolean;
}
