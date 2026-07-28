/**
 * AppGrid Configuration
 *
 * Defines the apps displayed in the home page Launchpad grid.
 * Icons derived from central routes (src/config/routes.ts) where the app
 * maps to a route; otherwise from ICON_CONFIG.
 */
import {
  ChartNoAxesGantt,
  ChevronsLeftRightEllipsis,
  Code2,
  Columns3,
  Database,
  Github,
  Globe,
  Info,
  ListTodo,
  Network,
  Play,
  Puzzle,
  Settings,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import {
  buildAgentOrgsPath,
  buildExternalSkillsetsPath,
  buildIntegrationsPath,
} from "@src/config/mainAppPaths";
import { ROUTES } from "@src/config/routes";

// ============================================
// Icon Config
// ============================================

export const ICON_CONFIG = {
  projects: ListTodo,
  dbManager: Database,
  changelog: ChartNoAxesGantt,
  kanban: Columns3,
  startSession: Play,
  integrations: ChevronsLeftRightEllipsis,
  dashboard: Info,
  agentOrgs: Network,
  plugins: Puzzle,
  browser: Globe,
  editor: Code2,
  settings: Settings,
  openSourceRepo: Github,
} as const;

// ============================================
// Types
// ============================================

export interface AppItem {
  /** Unique identifier */
  id: string;
  /** Full i18n key for the app label */
  labelKey: string;
  /** Lucide icon component (from ICON_CONFIG) */
  icon: LucideIcon;
  /** Lucide icon name for hover animation strategy lookup */
  iconName: string;
  /** Action identifier for optional ActionSystem dispatch */
  action: string;
  /** Route path used by fallback navigation and generic ActionSystem navigation */
  routePath: string;
  /**
   * External URL to open in the system browser. When set, the tile opens this
   * link instead of navigating an in-app route (routePath is left empty).
   */
  externalUrl?: string;
}

// ============================================
// App Grid Items
// ============================================

/** External URL for the ORGII open-source repository. */
export const OPEN_SOURCE_REPO_URL = "https://github.com/yorgai/ORG2";

export const APP_GRID_ITEMS: AppItem[] = [
  // ========== Row 1 ==========
  {
    id: "changelog",
    labelKey: "navigation:routes.changelog",
    icon: ICON_CONFIG.changelog,
    iconName: "chart-no-axes-gantt",
    action: "changelog",
    routePath: ROUTES.app.home.changelog.path,
  },
  {
    id: "open-source-repo",
    labelKey: "navigation:labels.openSourceRepo",
    icon: ICON_CONFIG.openSourceRepo,
    iconName: "github",
    action: "open-source-repo",
    routePath: "",
    externalUrl: OPEN_SOURCE_REPO_URL,
  },
  {
    // Keep the legacy id/action so customized app-grid ordering persists.
    id: "launchpad",
    labelKey: "navigation:launchpad.dashboard",
    icon: ICON_CONFIG.dashboard,
    iconName: "info",
    action: "launchpad",
    // Dashboard is no longer a standalone Workstation host — its workspace
    // and per-repo views are pinned tabs inside the Code Editor surface.
    // The start-page tile lands the user on the editor route, where the
    // dashboard tab is the first fixture.
    routePath: ROUTES.workStation.code.path,
  },

  // ========== Row 2 (5 items - center row) ==========
  {
    id: "integrations",
    labelKey: "navigation:labels.integrations",
    icon: ICON_CONFIG.integrations,
    iconName: "chevrons-left-right-ellipsis",
    action: "integrations",
    routePath: buildIntegrationsPath({ category: "models" }),
  },
  {
    id: "plugins",
    labelKey: "Plugin",
    icon: ICON_CONFIG.plugins,
    iconName: "puzzle",
    action: "plugins",
    routePath: buildExternalSkillsetsPath({ tab: "skills" }),
  },
  {
    id: "kanban",
    labelKey: "sessions:simulator.tabs.kanban",
    icon: ICON_CONFIG.kanban,
    iconName: "columns-3",
    action: "kanban",
    routePath: ROUTES.workStation.base.path,
  },
  {
    id: "create-session",
    labelKey: "navigation:routes.startSession",
    icon: ICON_CONFIG.startSession,
    iconName: "play",
    action: "create-session",
    routePath: ROUTES.workStation.base.path,
  },
  {
    id: "agent-orgs",
    labelKey: "navigation:labels.agentOrgs",
    icon: ICON_CONFIG.agentOrgs,
    iconName: "network",
    action: "agent-orgs",
    routePath: buildAgentOrgsPath({ tab: "agents" }),
  },
  {
    id: "settings",
    labelKey: "common:tabs.settings",
    icon: ICON_CONFIG.settings,
    iconName: "settings",
    action: "settings",
    routePath: ROUTES.app.settings.path,
  },

  // ========== Row 3 (4 items) ==========
  {
    id: "editor",
    labelKey: "navigation:labels.editor",
    icon: ICON_CONFIG.editor,
    iconName: "code-2",
    action: "editor",
    routePath: ROUTES.workStation.code.path,
  },
  {
    id: "browser",
    labelKey: "navigation:labels.browser",
    icon: ICON_CONFIG.browser,
    iconName: "globe",
    action: "browser",
    routePath: ROUTES.workStation.browser.path,
  },
  {
    id: "projects",
    labelKey: "navigation:labels.projects",
    icon: ICON_CONFIG.projects,
    iconName: "chart-no-axes-gantt",
    action: "projects",
    routePath: ROUTES.workStation.project.path,
  },
];
