/**
 * Route group constants — extracted from routes.ts to keep it within the
 * config line limit. All exports are re-exported from routes.ts.
 */
import type { RouteInfo, RouteLabelContext } from "./routeTypes";

/** Helper to create route info — duplicated locally to avoid circular dep. */
function route(
  path: string,
  label: string | ((context: RouteLabelContext) => string),
  icon?: string,
  description?: string
): RouteInfo {
  return { path, label, icon, description };
}

// ============================================================================
// WORKSTATION ROUTES: /orgii/workstation/*
export const WORK_STATION_ROUTES = {
  base: route(
    "/orgii/workstation",
    "Workstation",
    "wrench",
    "Workstation - Code Editor, Browser, Chat, and Project Manager"
  ),
  code: route(
    "/orgii/workstation/code",
    (ctx) => ctx.repoName || "Code Editor",
    "content-writing",
    "Code editing with file tree and terminal"
  ),
  browser: route(
    "/orgii/workstation/browser",
    "Browser",
    "globe",
    "Browser with DevTools and preview tools"
  ),
  chat: route(
    "/orgii/workstation/chat",
    "Chat",
    "messages-square",
    "Chat panel as a Human Tool"
  ),
  project: route(
    "/orgii/workstation/project",
    "Project Manager",
    "list-todo",
    "Project and work item management"
  ),
} as const;

// ============================================================================
// APP ENTRY ROUTES: /orgii/app/*
export const APP_SELECT_REPO_ROUTE = route(
  "/orgii/app/select-repo",
  "Select Repo",
  "folder",
  "Select a repo to continue"
);

export const APP_AGENT_ORGS_ROUTE = route(
  "/orgii/app/settings/agent-orgs/agents",
  "Agents",
  "infinity",
  "Agent definitions \u2014 built-in, custom, and CLI agents"
);

// ============================================================================
// AUTH ROUTES
export const AUTH_ROUTES = {
  login: route(
    "/orgii/app/login",
    "Login",
    "app",
    "User authentication login page"
  ),
} as const;

// ============================================================================
// SETTINGS ROUTE
// Settings renders inside the Workbench shell. The slot swaps in
// `SettingsSlot` whenever
// the URL starts with `/orgii/app/settings/*` (see `AppShell`); the route
// entries in `routeGroups.tsx` exist purely so the URL is deeplinkable.
export const APP_SETTINGS_ROUTE = route(
  "/orgii/app/settings",
  "Settings",
  "settings",
  "Unified Settings surface \u2014 Core (app settings + integrations), Agent, and Team"
);

// ============================================================================
// IDEA ROUTES
// ============================================================================
export const APP_IDEA_ROUTES = {
  area: route(
    "/orgii/app/ideas",
    "Idea Area",
    "lightbulb",
    "Share and preview trending ideas for apps"
  ),
} as const;
