/**
 * Route group constants — extracted from routes.ts to keep it within the
 * config line limit. All exports are re-exported from routes.ts.
 */
import { ROUTE_PATHS } from "./routePaths";
import type { RouteInfo, RouteLabelContext } from "./routeTabMapping";
import type { ViewModeType } from "./viewModeTypes";

/** Helper to create route info — duplicated locally to avoid circular dep. */
function route(
  path: string,
  label: string | ((context: RouteLabelContext) => string),
  viewMode: ViewModeType,
  tabType: string,
  icon?: string,
  description?: string
): RouteInfo {
  return { path, label, viewMode, tabType, icon, description };
}

// ============================================================================
// WORKSTATION ROUTES: /orgii/workstation/*
// ============================================================================

export const WORK_STATION_ROUTES = {
  base: route(
    "/orgii/workstation",
    "Workstation",
    "workStation",
    "workstation",
    "wrench",
    "Workstation - Code Editor, Database Manager, Browser"
  ),
  code: route(
    "/orgii/workstation/code",
    (ctx) => ctx.repoName || "Code Editor",
    "workStation",
    "workstation",
    "code",
    "Code editing with file tree and terminal"
  ),
  browser: route(
    "/orgii/workstation/browser",
    "Browser",
    "workStation",
    "workstation",
    "globe",
    "Browser with DevTools and designer"
  ),
  chat: route(
    "/orgii/workstation/chat",
    "Chat",
    "workStation",
    "workstation",
    "messages-square",
    "Chat panel as a Human Tool"
  ),
  project: route(
    "/orgii/workstation/project",
    "Project Manager",
    "workStation",
    "workstation",
    "list-todo",
    "Project and work item management"
  ),
} as const;

// ============================================================================
// APP HOME ROUTES: /orgii/app/*
// ============================================================================

export const APP_HOME_ROUTES = {
  selectRepo: route(
    "/orgii/app/select-repo",
    "Select Repo",
    "mainApp",
    "navigation",
    "folder",
    "Select a repo to continue"
  ),
  start: route(
    ROUTE_PATHS.startPage,
    "Start Page",
    "mainApp",
    "app",
    "home",
    "Start Page - home landing"
  ),
  changelog: route(
    "/orgii/app/changelog",
    "Changelog",
    "mainApp",
    "app",
    "chart-no-axes-gantt",
    "Monthly and daily summaries of product changes"
  ),
  // `agentOrgs` route points at the Agent Teams settings namespace while
  // remaining on `APP_HOME_ROUTES` for existing route consumers.
  // viewMode MUST be `workStation` to match the rest of `/settings/*`.
  agentOrgs: route(
    "/orgii/app/settings/agent-orgs/agents",
    "Agents",
    "workStation",
    "app",
    "infinity",
    "Agent definitions \u2014 built-in, custom, and CLI agents"
  ),
} as const;

// ============================================================================
// AUTH ROUTES
// ============================================================================

export const AUTH_ROUTES = {
  login: route(
    "/orgii/app/login",
    "Login",
    "mainApp",
    "navigation",
    "app",
    "User authentication login page"
  ),
  setup: route(
    "/orgii/app/walkthrough",
    "Setup",
    "mainApp",
    "navigation",
    "settings",
    "First-time setup walkthrough wizard"
  ),
} as const;

// ============================================================================
// SETTINGS ROUTE
// ============================================================================

// Settings shares the WorkStation view-mode so the route renders with the
// WorkStation chrome and surface available to the right of the slot. The
// slot itself swaps in `SettingsSlot` whenever
// the URL starts with `/orgii/app/settings/*` (see `AppShell`); the route
// entries in `routeGroups.tsx` exist purely so the URL is deeplinkable.
export const APP_SETTINGS_ROUTE = route(
  "/orgii/app/settings",
  "Settings",
  "workStation",
  "app",
  "settings",
  "Unified Settings surface \u2014 Core (app settings + integrations), Agent, and Team"
);

// ============================================================================
// JOURNEY ROUTES
// ============================================================================

// Dev Record (journey/record) has been retired. The route group is kept as an
// empty object so `ROUTES.app.journey` and its re-exports remain valid.
export const APP_JOURNEY_ROUTES = {} as const;

// ============================================================================
// IDEA ROUTES
// ============================================================================

export const APP_IDEA_ROUTES = {
  area: route(
    "/orgii/app/ideas",
    "Idea Area",
    "mainApp",
    "app",
    "lightbulb",
    "Share and preview trending ideas for apps"
  ),
} as const;

// ============================================================================
// MARKET ROUTES
// ============================================================================

export const APP_MARKET_ROUTES = {
  wallet: route(
    "/orgii/app/market/wallet",
    "Wallet",
    "mainApp",
    "app",
    "wallet",
    "Wallet and transactions"
  ),
  earnings: route(
    "/orgii/app/market/earnings",
    "Earnings",
    "mainApp",
    "app",
    "circle-dollar-sign",
    "Provider earnings and payouts"
  ),
  boost: route(
    "/orgii/app/market/boost",
    "Boost",
    "mainApp",
    "app",
    "rocket",
    "Promotional boosts for your listings"
  ),
  tokenMarket: route(
    "/orgii/app/market/tokens",
    "Token Market",
    "mainApp",
    "app",
    "fuel",
    "Browse token market listings - shared by buyers and sellers"
  ),
  serviceMarket: route(
    "/orgii/app/market/services",
    "Service Market",
    "mainApp",
    "app",
    "package-check",
    "Browse and find services in the market"
  ),
  profile: route(
    "/orgii/app/market/profile",
    "My Profile",
    "mainApp",
    "app",
    "id-card",
    "View and edit your profile information"
  ),
  publicProfile: route(
    "/orgii/app/market/profile/:userId",
    "Profile",
    "mainApp",
    "app",
    "user",
    "View another user's public profile"
  ),
  callback: route(
    "/orgii/marketplace/callback",
    "Signing in...",
    "mainApp",
    "app",
    "loader",
    "Supabase OAuth callback for hosted-service login"
  ),
  agentApps: route(
    "/orgii/app/market/agent-apps",
    "Agent Market",
    "mainApp",
    "app",
    "infinity",
    "Browse and discover agent app services"
  ),
  agentAppDetail: route(
    "/orgii/app/market/agent-apps/:agentId",
    "Agent App",
    "mainApp",
    "app",
    "infinity",
    "View agent app details and reputation"
  ),
  agentStudio: route(
    "/orgii/app/market/agent-studio",
    "Agent Studio",
    "mainApp",
    "app",
    "wand-2",
    "Publish and manage your agent apps"
  ),
  delegationHistory: route(
    "/orgii/app/market/delegation-history",
    "Delegation History",
    "mainApp",
    "app",
    "history",
    "View past delegation results and outcomes"
  ),
} as const;
