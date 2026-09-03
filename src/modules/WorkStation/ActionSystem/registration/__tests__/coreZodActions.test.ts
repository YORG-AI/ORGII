/**
 * WorkStation core Zod actions: schema uniqueness, LLM tool JSON, and registry wiring.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { ZodTypeAny } from "zod";

import { ACTION_ID } from "@src/ActionSystem/actionIds";
import {
  guiControlZodActions,
  guiExecuteAction,
} from "@src/ActionSystem/actions/guiControlActions.zod";
import { settingsZodActions } from "@src/ActionSystem/actions/languageActions.zod";
import { spotlightZodActions } from "@src/ActionSystem/actions/spotlightActions.zod";
import { appZoomZodActions } from "@src/ActionSystem/actions/zoomActions.zod";
import { collectAppZodActions } from "@src/ActionSystem/collectAppActions";
import {
  type ZodAction,
  zodActionToLLMTool,
} from "@src/ActionSystem/schema/defineZodAction";
import { zodActionRegistry } from "@src/ActionSystem/schema/zodRegistry";
import {
  AGENT_SESSION_ACTIONS,
  APP_ACTIONS,
  EDITOR_ACTIONS,
  ORGANIZATION_ACTIONS,
  QUICK_NAVIGATION_ACTIONS,
  STATION_MODE_ACTIONS,
  WORKSPACE_ACTIONS,
  buildChatPanelSettingsActions,
  buildViewActions,
} from "@src/scaffold/GlobalSpotlight/hooks/features/spotlightActionDefinitions";

import {
  getAllCoreZodActions,
  registerCoreActions,
} from "../registerCoreActions";

const TEST_REPO = "/tmp/orgii-action-system-test-repo";

const SPOTLIGHT_EDITOR_ACTION_IDS = {
  "go-to-editor-file": ACTION_ID.SPOTLIGHT_OPEN_EDITOR_FILE,
  "run-editor-command": ACTION_ID.SPOTLIGHT_OPEN_EDITOR_COMMAND,
  "go-to-editor-symbol": ACTION_ID.SPOTLIGHT_OPEN_EDITOR_SYMBOL,
} as const;

function getRepresentativeSpotlightActionIds(): Set<string> {
  return new Set([
    ...AGENT_SESSION_ACTIONS.map((action) => action.actionId),
    ...WORKSPACE_ACTIONS.map((action) => action.actionId),
    ...ORGANIZATION_ACTIONS.map((action) => action.actionId),
    ...buildChatPanelSettingsActions({
      chatPanelPosition: "left",
      chatTurnPaginationEnabled: true,
      modelPickerStyle: "spotlight",
      workstationSidebarPosition: "left",
    }).map((action) => action.actionId),
    ...buildChatPanelSettingsActions({
      chatPanelPosition: "right",
      chatTurnPaginationEnabled: false,
      modelPickerStyle: "dropdown",
      workstationSidebarPosition: "right",
    }).map((action) => action.actionId),
    ...STATION_MODE_ACTIONS.map((action) => action.actionId),
    ...QUICK_NAVIGATION_ACTIONS.map((action) => action.actionId),
    ...APP_ACTIONS.map((action) => action.actionId),
    ...buildViewActions(true, true, true, true, true, true, true, true).map(
      (action) => action.actionId
    ),
    ...buildViewActions(
      false,
      true,
      true,
      true,
      false,
      false,
      false,
      false
    ).map((action) => action.actionId),
    ...EDITOR_ACTIONS.map((action) => SPOTLIGHT_EDITOR_ACTION_IDS[action.id]),
  ]);
}

describe("getAllCoreZodActions", () => {
  it("returns unique action ids", () => {
    const actions = getAllCoreZodActions(TEST_REPO);
    const ids = actions.map((action) => action.meta.id);
    expect(ids.length).toBeGreaterThan(30);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("produces OpenAI-style LLM tool definitions for every action without throwing", () => {
    const actions = getAllCoreZodActions(TEST_REPO);

    for (const action of actions) {
      const tool = zodActionToLLMTool(action);
      expect(tool.type).toBe("function");
      expect(tool.function.name).toBe(action.meta.id.replace(/\./g, "_"));
      expect(tool.function.description.length).toBeGreaterThan(0);
      expect(tool.function.parameters).toBeDefined();
    }
  });

  it("includes representative WorkStation and git action ids", () => {
    const ids = new Set(
      getAllCoreZodActions(TEST_REPO).map((action) => action.meta.id)
    );
    expect(ids.has("terminal.execute")).toBe(true);
    expect(ids.has("panel.showPrimary")).toBe(true);
    expect(ids.has("file.open")).toBe(true);
    expect(ids.has("git.status")).toBe(true);
    expect(ids.has(ACTION_ID.SIDEBAR_TOGGLE)).toBe(true);
    expect(ids.has(ACTION_ID.AGENT_STATION_CREATE_SESSION)).toBe(true);
    expect(ids.has(ACTION_ID.WORKSTATION_TOGGLE_CHAT_FOCUS)).toBe(true);
    expect(ids.has(ACTION_ID.WORKSTATION_TOGGLE_CHAT_PANEL_VISIBILITY)).toBe(
      true
    );
    expect(ids.has(ACTION_ID.WORKSTATION_TOGGLE_SIDEBAR)).toBe(true);
    expect(ids.has(ACTION_ID.WORKSTATION_OPEN_MY_STATION)).toBe(true);
    expect(ids.has(ACTION_ID.WORKSTATION_OPEN_AGENT_STATION)).toBe(true);
    expect(ids.has(ACTION_ID.WORKSTATION_OPEN_KANBAN)).toBe(true);
    expect(ids.has(ACTION_ID.WORKSTATION_OPEN_FILE_FOLDER_TAB)).toBe(true);
    expect(ids.has(ACTION_ID.WORKSTATION_OPEN_SOURCE_CONTROL_TAB)).toBe(true);
    expect(ids.has(ACTION_ID.WORKSTATION_OPEN_TERMINAL_TAB)).toBe(true);
  });
});

describe("collectAppZodActions", () => {
  it("auto-discovers app action registrations from feature-owned action files", () => {
    const ids = new Set(collectAppZodActions().map((action) => action.meta.id));

    expect(ids.has(ACTION_ID.GUI_INSPECT)).toBe(true);
    expect(ids.has(ACTION_ID.SIDEBAR_TOGGLE)).toBe(true);
    expect(ids.has(ACTION_ID.SPOTLIGHT_OPEN)).toBe(true);
    expect(ids.has(ACTION_ID.APP_ZOOM_IN)).toBe(true);
    expect(ids.has(ACTION_ID.APP_CHECK_FOR_UPDATES)).toBe(true);
    expect(ids.has(ACTION_ID.SETTINGS_SET_LANGUAGE)).toBe(true);
  });
});

describe("app-level guiControlZodActions", () => {
  it("includes GUI inspect and execute manifest actions", () => {
    const ids = new Set(guiControlZodActions.map((action) => action.meta.id));
    expect(ids.has(ACTION_ID.GUI_INSPECT)).toBe(true);
    expect(ids.has(ACTION_ID.GUI_EXECUTE)).toBe(true);
  });

  it("refuses to launder session.replyComment through gui.execute", async () => {
    const result = await guiExecuteAction.execute({
      targetKind: "action",
      actionId: ACTION_ID.SESSION_REPLY_COMMENT,
      params: {
        commentId: "victim-thread",
        body: "forged",
        localSessionId: "ls-victim",
      },
    });
    expect(result.success).toBe(false);
    expect(result.message).toContain("cannot be run through gui.execute");
  });

  it("produces OpenAI-style LLM tool definitions for GUI control actions", () => {
    for (const action of guiControlZodActions) {
      const genericAction: ZodAction<ZodTypeAny> = action;
      const tool = zodActionToLLMTool(genericAction);
      expect(tool.type).toBe("function");
      expect(tool.function.name).toBe(action.meta.id.replace(/\./g, "_"));
      expect(tool.function.description.length).toBeGreaterThan(0);
      expect(tool.function.parameters).toBeDefined();
    }
  });
});

describe("app-level settingsZodActions", () => {
  it("includes a GUI-safe language setter", () => {
    const ids = new Set(settingsZodActions.map((action) => action.meta.id));
    expect(ids.has(ACTION_ID.SETTINGS_SET_LANGUAGE)).toBe(true);
  });

  it("produces an OpenAI-style LLM tool definition for the language action", () => {
    const languageAction = settingsZodActions.find(
      (action) => action.meta.id === ACTION_ID.SETTINGS_SET_LANGUAGE
    );
    expect(languageAction).toBeDefined();
    if (!languageAction) return;

    const tool = zodActionToLLMTool(languageAction);
    expect(tool.type).toBe("function");
    expect(tool.function.name).toBe("settings_language_set");
    expect(tool.function.parameters).toBeDefined();
  });
});

describe("app-level zoomZodActions", () => {
  it("registers zoom actions under the View category", () => {
    const actionsById = new Map(
      appZoomZodActions.map((action) => [action.meta.id, action])
    );

    expect(actionsById.get(ACTION_ID.APP_ZOOM_IN)?.meta.category).toBe("view");
    expect(actionsById.get(ACTION_ID.APP_ZOOM_OUT)?.meta.category).toBe("view");
    expect(actionsById.get(ACTION_ID.APP_ZOOM_RESET)?.meta.category).toBe(
      "view"
    );
  });
});

describe("app-level spotlightZodActions", () => {
  it("includes Spotlight UI flow actions", () => {
    const ids = new Set(spotlightZodActions.map((action) => action.meta.id));
    expect(ids.has(ACTION_ID.SPOTLIGHT_OPEN_WORKSPACE_PICKER)).toBe(true);
    expect(ids.has(ACTION_ID.SPOTLIGHT_OPEN_BRANCH_PICKER)).toBe(true);
    expect(ids.has(ACTION_ID.SPOTLIGHT_OPEN_EDITOR_FILE)).toBe(true);
    expect(ids.has(ACTION_ID.SPOTLIGHT_OPEN_EDITOR_COMMAND)).toBe(true);
    expect(ids.has(ACTION_ID.SPOTLIGHT_OPEN_EDITOR_SYMBOL)).toBe(true);
    expect(ids.has(ACTION_ID.SPOTLIGHT_OPEN_COLLAB_ORG)).toBe(true);
  });

  it("accepts only valid organization create and join contexts", () => {
    const action = spotlightZodActions.find(
      (candidate) => candidate.meta.id === ACTION_ID.SPOTLIGHT_OPEN_COLLAB_ORG
    );

    expect(action).toBeDefined();
    expect(action?.meta.params.safeParse({ mode: "create" }).success).toBe(
      true
    );
    expect(
      action?.meta.params.safeParse({ mode: "create", source: "local" }).success
    ).toBe(true);
    expect(action?.meta.params.safeParse({ mode: "join" }).success).toBe(true);
    expect(
      action?.meta.params.safeParse({ mode: "join", source: "local" }).success
    ).toBe(false);
  });

  it("covers every representative Spotlight static action with a registered Zod action", () => {
    const registeredIds = new Set(
      [...collectAppZodActions(), ...getAllCoreZodActions(TEST_REPO)].map(
        (action) => action.meta.id
      )
    );

    for (const actionId of getRepresentativeSpotlightActionIds()) {
      expect(registeredIds.has(actionId)).toBe(true);
    }
  });

  it("produces OpenAI-style LLM tool definitions for Spotlight actions", () => {
    for (const action of spotlightZodActions) {
      const tool = zodActionToLLMTool(action);
      expect(tool.type).toBe("function");
      expect(tool.function.name).toBe(action.meta.id.replace(/\./g, "_"));
      expect(tool.function.description.length).toBeGreaterThan(0);
      expect(tool.function.parameters).toBeDefined();
    }
  });
});

describe("registerCoreActions", () => {
  let cleanup: (() => void) | undefined;

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });

  it("registers all core actions on the global registry and clears on cleanup", () => {
    expect(zodActionRegistry.getActionIds().length).toBe(0);

    cleanup = registerCoreActions(TEST_REPO);
    const registered = zodActionRegistry.getActionIds();
    expect(registered.length).toBe(getAllCoreZodActions(TEST_REPO).length);

    cleanup();
    cleanup = undefined;
    expect(zodActionRegistry.getActionIds().length).toBe(0);
  });
});
