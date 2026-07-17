/**
 * App Navigation Actions
 *
 * App-level routing and view mode switching.
 * Uses React Router navigate() under the hood via the global Jotai store.
 *
 * Category: "app"
 */
import { z } from "zod";

import { ACTION_ID } from "@src/ActionSystem/actionIds";
import { defineAppActionRegistration } from "@src/ActionSystem/schema/actionRegistration";
import { defineZodAction } from "@src/ActionSystem/schema/defineZodAction";
import {
  WIZARD_IDS,
  buildIntegrationsPath,
  buildWizardPath,
} from "@src/config/mainAppPaths";
import { ROUTES } from "@src/config/routes";
import {
  activeSessionIdAtom,
  workstationActiveSessionIdAtom,
} from "@src/store/session";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";

// ============================================
// Helpers
// ============================================

/**
 * Navigate using the app's router.
 * Since we can't use React hooks outside components, we dispatch
 * a custom event that the AppShell listens for.
 */
function appNavigate(path: string, replace = false): void {
  window.dispatchEvent(
    new CustomEvent("action-system-navigate", {
      detail: { path, replace },
    })
  );
}

function defineRouteNavigationAction(
  id: string,
  description: string,
  path: string,
  successMessage: string,
  examples: string[]
) {
  return defineZodAction(
    {
      id,
      category: "app",
      description,
      params: z.object({}),
      layer: "gui",
      examples,
    },
    async () => {
      appNavigate(path);
      return { success: true, message: successMessage };
    }
  );
}

// ============================================
// Actions
// ============================================

const appNavigateAction = defineZodAction(
  {
    id: ACTION_ID.APP_NAVIGATE,
    category: "app",
    description: "Navigate to any app route by path",
    params: z.object({
      path: z.string().describe("Route path (e.g. /orgii/app/settings)"),
      title: z.string().optional().describe("Route title metadata"),
      icon: z.string().optional().describe("Route icon metadata"),
      replace: z.boolean().optional().describe("Replace current history entry"),
    }),
    layer: "gui",
    examples: [
      "navigate to settings",
      "go to the market",
      "open the start page",
    ],
  },
  async ({ path, replace }) => {
    appNavigate(path, replace);
    return { success: true, message: `Navigated to ${path}` };
  }
);

const appGoToSettings = defineRouteNavigationAction(
  ACTION_ID.APP_GO_TO_SETTINGS,
  "Open the Settings page",
  ROUTES.app.settings.path,
  "Opened settings",
  ["open settings"]
);

const appGoToEditor = defineRouteNavigationAction(
  ACTION_ID.APP_GO_TO_EDITOR,
  "Switch to the Code Editor (Workstation)",
  ROUTES.workStation.code.path,
  "Switched to Code Editor",
  ["open the code editor", "switch to editor"]
);

const appGoToBrowser = defineRouteNavigationAction(
  ACTION_ID.APP_GO_TO_BROWSER,
  "Switch to the Browser (Workstation)",
  ROUTES.workStation.browser.path,
  "Switched to Browser",
  ["open the browser", "switch to browser"]
);

const appGoToChat = defineRouteNavigationAction(
  ACTION_ID.APP_GO_TO_CHAT,
  "Switch to Chat (Workstation)",
  ROUTES.workStation.chat.path,
  "Switched to Chat",
  ["open chat", "switch to chat", "show chat"]
);

const appGoToStartPage = defineRouteNavigationAction(
  ACTION_ID.APP_GO_TO_START_PAGE,
  "Navigate to the Start Page",
  ROUTES.app.home.start.path,
  "Opened Start Page",
  ["go home", "open start page"]
);

const appGoToMarket = defineRouteNavigationAction(
  ACTION_ID.APP_GO_TO_MARKET,
  "Open the Token Market page",
  ROUTES.app.market.tokenMarket.path,
  "Opened Token Market",
  ["open the market", "go to token market"]
);

const appGoToProjects = defineRouteNavigationAction(
  ACTION_ID.APP_GO_TO_STORIES,
  "Switch to the Project Manager",
  ROUTES.workStation.project.path,
  "Switched to Project Manager",
  ["open projects", "open project manager"]
);

const appGoToChangelog = defineRouteNavigationAction(
  ACTION_ID.APP_GO_TO_CHANGELOG,
  "Open the Changelog",
  ROUTES.app.home.changelog.path,
  "Opened Changelog",
  ["open changelog", "show changes"]
);

const appGoToKanban = defineZodAction(
  {
    id: ACTION_ID.APP_GO_TO_KANBAN,
    category: "app",
    description: "Open Kanban",
    params: z.object({}),
    layer: "gui",
    examples: ["open kanban", "show kanban"],
  },
  async () => {
    const { WorkStationViewService } =
      await import("@src/services/workStation/WorkStationViewService");
    const success = await WorkStationViewService.openKanbanTab();
    return success
      ? { success: true, message: "Opened Kanban" }
      : { success: false, message: "Kanban is not available" };
  }
);

const appGoToAgentOrgs = defineRouteNavigationAction(
  ACTION_ID.APP_GO_TO_AGENT_ORGS,
  "Open Agent Teams",
  ROUTES.app.home.agentOrgs.path,
  "Opened Agent Teams",
  ["open agent teams", "show agents"]
);

const appGoToIntegrations = defineRouteNavigationAction(
  ACTION_ID.APP_GO_TO_INTEGRATIONS,
  "Open Agent Teams integrations",
  buildIntegrationsPath({ category: "models" }),
  "Opened integrations",
  ["open integrations", "manage models"]
);

const appGoToConnections = defineRouteNavigationAction(
  ACTION_ID.APP_GO_TO_CONNECTIONS,
  "Open integration connections",
  buildIntegrationsPath({ category: "connections" }),
  "Opened integration connections",
  ["open connections", "manage connections", "connect github"]
);

const appGoToModelKeys = defineRouteNavigationAction(
  ACTION_ID.APP_GO_TO_MODEL_KEYS,
  "Open model key accounts",
  `${buildIntegrationsPath({ category: "models" })}?modelsTab=my-accounts`,
  "Opened model key accounts",
  ["open model keys", "manage accounts", "manage keys"]
);

const appGoToHousekeeper = defineRouteNavigationAction(
  ACTION_ID.APP_GO_TO_HOUSEKEEPER,
  "Open the MiniCPM resident housekeeper settings",
  buildIntegrationsPath({ category: "housekeeper" }),
  "Opened MiniCPM housekeeper",
  ["open housekeeper", "open minicpm housekeeper", "configure minicpm"]
);

const appOpenAddModelApi = defineRouteNavigationAction(
  ACTION_ID.APP_OPEN_ADD_MODEL_API,
  "Open the Add API flow for model accounts",
  buildWizardPath(
    `${buildIntegrationsPath({ category: "models" })}?modelsTab=my-accounts&localRuntime=vllm_minicpm`,
    WIZARD_IDS.KEY_ADD
  ),
  "Opened add model API flow",
  ["add api", "add model api", "add local model api"]
);

const appGoToSession = defineZodAction(
  {
    id: ACTION_ID.APP_GO_TO_SESSION,
    category: "app",
    description: "Navigate to an agent session",
    params: z.object({
      sessionId: z
        .string()
        .optional()
        .describe("Session ID to open. Omit for new session."),
    }),
    layer: "gui",
    examples: ["start a new session", "open session abc123"],
  },
  async ({ sessionId }) => {
    const store = getInstrumentedStore();
    if (sessionId) {
      store.set(workstationActiveSessionIdAtom, sessionId);
      store.set(activeSessionIdAtom, sessionId);
      appNavigate(ROUTES.workStation.base.path);
      return { success: true, message: `Opened session ${sessionId}` };
    }
    store.set(workstationActiveSessionIdAtom, null);
    store.set(activeSessionIdAtom, null);
    appNavigate(ROUTES.workStation.base.path);
    return { success: true, message: "Opened new session" };
  }
);

// ============================================
// Export
// ============================================

export const appNavigationZodActions = [
  appNavigateAction,
  appGoToSettings,
  appGoToEditor,
  appGoToBrowser,
  appGoToChat,
  appGoToMarket,
  appGoToStartPage,
  appGoToProjects,
  appGoToChangelog,
  appGoToKanban,
  appGoToAgentOrgs,
  appGoToIntegrations,
  appGoToConnections,
  appGoToModelKeys,
  appGoToHousekeeper,
  appOpenAddModelApi,
  appGoToSession,
];

export const appNavigationActionRegistration = defineAppActionRegistration(
  appNavigationZodActions
);
