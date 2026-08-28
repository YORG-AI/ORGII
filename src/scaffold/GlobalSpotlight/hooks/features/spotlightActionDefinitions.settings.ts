/**
 * Spotlight Settings Action Builders
 *
 * State-dependent builder functions that produce spotlight action lists for
 * theme and chat-panel-layout settings. Each label/icon/actionId flips based
 * on the current setting value passed in by the caller. Split out of
 * `spotlightActionDefinitions.ts`.
 *
 * - `buildThemeActions`             — theme-switch actions (system/light/dark/high-contrast).
 * - `buildChatPanelSettingsActions` — chat panel position, pagination, and
 *   model-picker style toggles.
 */
import { ACTION_ID } from "@src/ActionSystem";
import {
  ArrowLeftBigIcon,
  ArrowRightBigIcon,
  ComputerSettingsIcon,
  ContrastIcon,
  LayoutTopIcon,
  Menu01Icon,
  MoonIcon,
  PanelLeftIcon,
  SparklesIcon,
  Sun01Icon,
} from "@src/icons";

import type { SpotlightStaticActionDefinition } from "./spotlightActionDefinitions.types";

export function buildThemeActions(
  currentThemeId: string
): SpotlightStaticActionDefinition[] {
  const actions: SpotlightStaticActionDefinition[] = [];

  if (currentThemeId !== "system") {
    actions.push({
      id: "set-system-theme",
      labelKey: "common:spotlightActions.switchToSystemTheme",
      icon: ComputerSettingsIcon,
      keywords: ["system theme", "follow system", "theme", "appearance"],
      actionId: ACTION_ID.THEME_SET_SYSTEM,
      payload: {},
      closeOnSuccess: false,
    });
  }

  if (currentThemeId !== "github-light") {
    actions.push({
      id: "set-light-theme",
      labelKey: "common:spotlightActions.switchToLightTheme",
      icon: Sun01Icon,
      keywords: ["light theme", "light mode", "theme", "appearance"],
      actionId: ACTION_ID.THEME_SET_LIGHT,
      payload: {},
      closeOnSuccess: false,
    });
  }

  if (currentThemeId !== "github-dark") {
    actions.push({
      id: "set-dark-theme",
      labelKey: "common:spotlightActions.switchToDarkTheme",
      icon: MoonIcon,
      keywords: ["dark theme", "dark mode", "theme", "appearance"],
      actionId: ACTION_ID.THEME_SET_DARK,
      payload: {},
      closeOnSuccess: false,
    });
  }

  if (currentThemeId !== "orgii-high-contrast") {
    actions.push({
      id: "set-high-contrast-theme",
      labelKey: "common:spotlightActions.switchToHighContrastTheme",
      icon: ContrastIcon,
      keywords: [
        "high contrast",
        "contrast theme",
        "accessibility theme",
        "theme",
        "appearance",
      ],
      actionId: ACTION_ID.THEME_SET_HIGH_CONTRAST,
      payload: {},
      closeOnSuccess: false,
    });
  }

  return actions;
}

export function buildChatPanelSettingsActions({
  myStationChatPosition,
  agentStationChatPosition,
  chatTurnPaginationEnabled,
  modelPickerStyle,
  workstationSidebarPosition,
}: {
  myStationChatPosition: "left" | "right";
  agentStationChatPosition: "left" | "right";
  chatTurnPaginationEnabled: boolean;
  modelPickerStyle: "spotlight" | "dropdown";
  workstationSidebarPosition: "left" | "right";
}): SpotlightStaticActionDefinition[] {
  const actions: SpotlightStaticActionDefinition[] = [];

  actions.push({
    id:
      myStationChatPosition === "left"
        ? "set-my-station-chat-right"
        : "set-my-station-chat-left",
    labelKey:
      myStationChatPosition === "left"
        ? "common:spotlightActions.moveMyStationChatRight"
        : "common:spotlightActions.moveMyStationChatLeft",
    icon:
      myStationChatPosition === "left" ? ArrowRightBigIcon : ArrowLeftBigIcon,
    keywords: [
      "my station chat",
      "chat panel location",
      "chat left",
      "chat right",
    ],
    actionId:
      myStationChatPosition === "left"
        ? ACTION_ID.CHAT_PANEL_SET_MY_STATION_RIGHT
        : ACTION_ID.CHAT_PANEL_SET_MY_STATION_LEFT,
    payload: {},
    closeOnSuccess: false,
  });

  actions.push({
    id:
      agentStationChatPosition === "left"
        ? "set-agent-station-chat-right"
        : "set-agent-station-chat-left",
    labelKey:
      agentStationChatPosition === "left"
        ? "common:spotlightActions.moveAgentStationChatRight"
        : "common:spotlightActions.moveAgentStationChatLeft",
    icon:
      agentStationChatPosition === "left"
        ? ArrowRightBigIcon
        : ArrowLeftBigIcon,
    keywords: [
      "agent station chat",
      "agent chat location",
      "chat panel location",
    ],
    actionId:
      agentStationChatPosition === "left"
        ? ACTION_ID.CHAT_PANEL_SET_AGENT_STATION_RIGHT
        : ACTION_ID.CHAT_PANEL_SET_AGENT_STATION_LEFT,
    payload: {},
    closeOnSuccess: false,
  });

  actions.push({
    id: chatTurnPaginationEnabled
      ? "disable-chat-pagination"
      : "enable-chat-pagination",
    labelKey: chatTurnPaginationEnabled
      ? "common:spotlightActions.disableChatPagination"
      : "common:spotlightActions.enableChatPagination",
    icon: LayoutTopIcon,
    keywords: ["chat pagination", "turn pagination", "chat rounds"],
    actionId: chatTurnPaginationEnabled
      ? ACTION_ID.CHAT_PANEL_DISABLE_PAGINATION
      : ACTION_ID.CHAT_PANEL_ENABLE_PAGINATION,
    payload: {},
    closeOnSuccess: false,
  });

  actions.push({
    id:
      modelPickerStyle === "spotlight"
        ? "use-model-picker-dropdown"
        : "use-model-picker-spotlight",
    labelKey:
      modelPickerStyle === "spotlight"
        ? "common:spotlightActions.useModelPickerDropdown"
        : "common:spotlightActions.useModelPickerSpotlight",
    icon: modelPickerStyle === "spotlight" ? Menu01Icon : SparklesIcon,
    keywords: ["model picker", "model menu", "model spotlight", "picker"],
    actionId:
      modelPickerStyle === "spotlight"
        ? ACTION_ID.CHAT_PANEL_USE_MODEL_PICKER_DROPDOWN
        : ACTION_ID.CHAT_PANEL_USE_MODEL_PICKER_SPOTLIGHT,
    payload: {},
    closeOnSuccess: false,
  });

  actions.push({
    id:
      workstationSidebarPosition === "left"
        ? "set-workstation-sidebar-right"
        : "set-workstation-sidebar-left",
    labelKey:
      workstationSidebarPosition === "left"
        ? "common:spotlightActions.moveWorkstationSidebarRight"
        : "common:spotlightActions.moveWorkstationSidebarLeft",
    icon: PanelLeftIcon,
    keywords: [
      "workstation sidebar",
      "sidebar position",
      "left sidebar",
      "right sidebar",
    ],
    actionId:
      workstationSidebarPosition === "left"
        ? ACTION_ID.WORKSTATION_SET_SIDEBAR_RIGHT
        : ACTION_ID.WORKSTATION_SET_SIDEBAR_LEFT,
    payload: {},
    closeOnSuccess: false,
  });

  return actions;
}
