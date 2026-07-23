/**
 * Global Spotlight Navigation Destinations Registry
 *
 * Single source of truth for every destination the spotlight's
 * "Navigate to a page" action can reach. Every destination is a plain
 * URL — nested state for sub-tabs is encoded in the path itself (see
 * `buildAgentOrgsPath` / `buildSettingsPath`) and detail selection is
 * encoded as query parameters. There is no `location.state` fallback.
 *
 * Labels, descriptions, and icons are derived automatically from the
 * path via `buildBreadcrumbLabels` + `getPathIcon` (backed by
 * `SEGMENT_REGISTRY` in `mainAppPaths.ts`). Sidebars, breadcrumbs and
 * spotlight entries always show the same glyph and name for a given
 * URL — no duplicated icon-imports per surface.
 *
 * INTEGRATIONS and ACTIONS destination groups live in
 * navDestinationGroups.ts to keep this file within the config line limit.
 * Search utilities live in navDestinationsSearch.ts.
 */
import type { LucideIcon } from "lucide-react";
import type { ComponentType } from "react";

import {
  buildAgentOrgsPath,
  buildBreadcrumbLabels,
  buildSettingsPath,
  getPathIcon,
} from "@src/config/mainAppPaths";
import { ROUTES } from "@src/config/routes";

import { ACTIONS, INTEGRATIONS } from "./navDestinationGroups";
import type {
  NavDestination,
  NavDestinationGroup,
} from "./navDestinationsTypes";

export type { NavDestination, NavDestinationGroup };

// ============================================================================
// Helpers
// ============================================================================

/**
 * Resolve a destination's icon from the central registry based on its
 * URL path. Callers may override by supplying `overrideIcon` (used
 * sparingly for the few entries that need a custom glyph — e.g. MCP).
 */
function resolveIcon(path: string, overrideIcon?: LucideIcon): LucideIcon {
  if (overrideIcon) return overrideIcon;
  const icon = getPathIcon(path);
  if (!icon) {
    throw new Error(
      `NavDestinations: no SEGMENT_REGISTRY icon for path "${path}" ` +
        `— add an entry in SEGMENT_REGISTRY or pass an override.`
    );
  }
  return icon;
}

function dest(
  id: string,
  path: string,
  group: NavDestinationGroup,
  opts: {
    overrideIcon?: LucideIcon;
    keywords?: string[];
    labelKey?: string;
    descriptionSuffixKey?: string;
    searchable?: boolean;
  } = {}
): NavDestination {
  return {
    id,
    path,
    icon: resolveIcon(path, opts.overrideIcon) as unknown as ComponentType<
      Record<string, unknown>
    >,
    keywords: opts.keywords,
    group,
    labelKey: opts.labelKey,
    descriptionSuffixKey: opts.descriptionSuffixKey,
    searchable: opts.searchable,
  };
}

// ============================================================================
// Pages group
// ============================================================================

const PAGES: NavDestination[] = [
  dest("nav-changelog", ROUTES.app.changelog.path, "pages", {
    keywords: ["updates", "changes", "release notes"],
  }),
  dest("nav-code-editor", ROUTES.workStation.code.path, "pages", {
    keywords: ["editor", "files", "ide"],
  }),
  dest("nav-browser", ROUTES.workStation.browser.path, "pages", {
    keywords: ["web", "devtools", "preview"],
  }),
  dest("nav-project", ROUTES.workStation.project.path, "pages", {
    keywords: ["projects", "work items", "tasks"],
  }),
  dest("nav-agents", buildAgentOrgsPath(), "pages", {
    keywords: ["automation", "agent teams", "team"],
  }),
];

// ============================================================================
// Settings group
// ============================================================================

const SETTINGS: NavDestination[] = [
  dest(
    "nav-settings-general",
    buildSettingsPath({ section: "general" }),
    "settings",
    {
      keywords: ["settings", "general", "preferences"],
    }
  ),
  dest(
    "nav-settings-notifications",
    buildSettingsPath({ section: "general", tab: "notifications" }),
    "settings",
    {
      keywords: ["alerts", "notifications", "toasts"],
    }
  ),
  dest(
    "nav-settings-shortcuts",
    buildSettingsPath({ section: "general", tab: "shortcuts" }),
    "settings",
    {
      keywords: ["shortcuts", "keybindings", "keyboard", "hotkeys"],
    }
  ),
  dest(
    "nav-settings-appearance",
    buildSettingsPath({ section: "appearance" }),
    "settings",
    {
      keywords: ["theme", "background", "layout", "sidebar", "chat appearance"],
    }
  ),
  dest(
    "nav-settings-editor",
    buildSettingsPath({ section: "editor", tab: "editor" }),
    "settings",
    {
      keywords: [
        "code editor",
        "editor",
        "workspace",
        "terminal",
        "git",
        "external ide",
      ],
    }
  ),
  dest(
    "nav-settings-index",
    buildSettingsPath({ section: "editor", tab: "index" }),
    "settings",
    {
      keywords: [
        "index",
        "indexing",
        "code search",
        "embedding",
        "semantic",
        "workspace",
      ],
    }
  ),
  dest(
    "nav-settings-monitor",
    buildSettingsPath({ section: "monitor" }),
    "settings",
    {
      keywords: ["monitor", "resources", "network", "storage"],
    }
  ),
];

// ============================================================================
// Registry + describe
// ============================================================================

/**
 * Flat, ordered registry of all spotlight navigation destinations.
 * Order within the array determines display order inside a group.
 */
const OSS_SPOTLIGHT_ACTIONS = ACTIONS.filter(
  (destination) => !destination.path.startsWith("/orgii/app/market")
);

const OSS_PAGE_DESTINATIONS = PAGES.filter(
  (destination) =>
    destination.path !== "/orgii/app/login" &&
    destination.path !== "/orgii/app/walkthrough" &&
    !destination.path.startsWith("/orgii/app/market")
);

export const NAV_DESTINATIONS: NavDestination[] = [
  ...OSS_PAGE_DESTINATIONS,
  ...SETTINGS,
  ...INTEGRATIONS,
  ...OSS_SPOTLIGHT_ACTIONS,
];

/**
 * Derive the user-visible label + description for a destination from
 * its `path`. Label is the leaf segment (e.g. "MCP"); description is
 * the full breadcrumb trail (e.g. "Agents › Integrations › MCP").
 * Both always mirror the URL hierarchy — no parallel translation table.
 *
 * Wizard-action destinations (`group === "actions"`) carry an explicit
 * `labelKey` because their visible name ("Add MCP Server") is not the
 * host-page's breadcrumb leaf ("MCP"). In that case the host-page
 * breadcrumb is rendered as the description.
 */
export function describeNavDestination(
  dest: NavDestination,
  translate: (key: string) => string
): { label: string; description: string } {
  const { label, path } = buildBreadcrumbLabels(dest.path, translate);
  const description = dest.descriptionSuffixKey
    ? `${path} › ${translate(dest.descriptionSuffixKey)}`
    : path;
  if (dest.labelKey) {
    return { label: translate(dest.labelKey), description };
  }
  return { label, description };
}
