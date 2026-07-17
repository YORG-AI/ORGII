/**
 * Spotlight Action Definitions
 *
 * Static action constants and their typed definitions for the spotlight
 * palette. Each constant is a pure data table — no React, no hooks.
 *
 * - `AGENT_SESSION_ACTIONS` — top-level agent/session entry points.
 * - `WORKSPACE_ACTIONS`     — workspace / repo switching and management.
 * - `EDITOR_ACTIONS`        — editor palette modes (file / command / symbol).
 * - `QUICK_NAVIGATION_ACTIONS` — work-station tab switchers (terminal, SCM).
 * - `buildViewActions`      — view-toggle actions whose label flips based on
 *   the current collapsed state of each sidebar/panel.
 */
import {
  ArrowBigLeft,
  ArrowBigRight,
  Box,
  Columns3,
  Contrast,
  Dock,
  DraftingCompass,
  FolderPlus,
  FolderTree,
  GitBranch,
  GitPullRequest,
  LayoutPanelTop,
  List,
  Menu,
  MessageCircle,
  MonitorCog,
  Moon,
  PanelBottom,
  PanelLeft,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  Sparkles,
  SquarePen,
  SquareTerminal,
  Sun,
  ZoomIn,
  ZoomOut,
} from "lucide-react";

import { ACTION_ID, type ActionId } from "@src/ActionSystem";
import { getShortcutKeys } from "@src/config/keyboard/shortcutDisplay";

import type { SpotlightItem } from "../../types";

// ============================================
// Types
// ============================================

export type SpotlightStaticActionId =
  | "open-session-creator"
  | "create-project"
  | "create-work-item"
  | "search-agent-sessions"
  | "search-all-sessions"
  | "open-agent-control"
  | "switch-workspace"
  | "switch-branch"
  | "add-workspace"
  | "create-multi-repo-workspace"
  | "toggle-sidebar"
  | "set-system-theme"
  | "set-light-theme"
  | "set-dark-theme"
  | "set-high-contrast-theme"
  | "set-my-station-chat-left"
  | "set-my-station-chat-right"
  | "set-agent-station-chat-left"
  | "set-agent-station-chat-right"
  | "enable-chat-pagination"
  | "disable-chat-pagination"
  | "use-model-picker-spotlight"
  | "use-model-picker-dropdown"
  | "set-workstation-sidebar-left"
  | "set-workstation-sidebar-right"
  | "enable-dock-auto-hide"
  | "disable-dock-auto-hide"
  | "open-my-station"
  | "open-agent-station"
  | "open-kanban"
  | "zoom-in"
  | "zoom-out"
  | "zoom-reset"
  | "toggle-workstation-sidebar"
  | "toggle-bottom-panel"
  | "toggle-workstation-chat-focus"
  | "toggle-workstation-chat-panel"
  | "open-search-sidebar"
  | "open-source-control-tab"
  | "open-terminal-tab"
  | "detect-update";

export type SpotlightStaticActionFallback =
  | "open-session-creator"
  | "create-project"
  | "create-work-item"
  | "search-agent-sessions"
  | "search-all-sessions"
  | "agent-control"
  | "workspace-switch"
  | "workspace-add"
  | "workspace-create"
  | "branch-picker"
  | "toggle-sidebar"
  | "zoom-in"
  | "zoom-out"
  | "zoom-reset"
  | "toggle-workstation-sidebar"
  | "toggle-bottom-panel"
  | "toggle-chat-focus"
  | "toggle-chat-panel"
  | "open-my-station"
  | "open-agent-station"
  | "open-kanban"
  | "open-search-sidebar"
  | "open-source-control-tab"
  | "open-terminal-tab"
  | "detect-update";

export type SpotlightEditorActionId =
  | "go-to-editor-file"
  | "run-editor-command"
  | "go-to-editor-symbol";

export interface SpotlightStaticActionDefinition {
  id: SpotlightStaticActionId;
  labelKey: string;
  icon: SpotlightItem["icon"];
  keywords: string[];
  shortcut?: string;
  actionId: ActionId;
  payload: Record<string, unknown>;
  fallback?: SpotlightStaticActionFallback;
  opensSecondLevel?: boolean;
  closeOnSuccess: boolean;
}

export interface SpotlightEditorActionDefinition {
  id: SpotlightEditorActionId;
  modeKey: "file" | "command" | "symbol";
  labelKey: "label" | "hintLabel";
  prefix: string;
  shortcut: string;
}

// ============================================
// Static action tables
// ============================================

export const AGENT_SESSION_ACTIONS = [
  {
    id: "open-agent-control",
    labelKey: "common:adeManager.menuToggle",
    icon: DraftingCompass,
    keywords: [
      "ade manager",
      "agent control",
      "gui control",
      "control gui",
      "control app",
      "automation",
      "manage agents",
      "manage workspaces",
    ],
    shortcut: getShortcutKeys("toggle_ade_manager"),
    actionId: ACTION_ID.SPOTLIGHT_OPEN_AGENT_CONTROL,
    payload: {},
    fallback: "agent-control",
    opensSecondLevel: true,
    closeOnSuccess: false,
  },
  {
    id: "open-session-creator",
    labelKey: "selectors.spotlight.actions.openSessionCreator.label",
    icon: Play,
    keywords: [
      "new session",
      "create session",
      "agent station",
      "start agent",
      "open session creator",
    ],
    shortcut: getShortcutKeys("new_session"),
    actionId: ACTION_ID.SPOTLIGHT_OPEN_SESSION_CREATOR,
    payload: {},
    fallback: "open-session-creator",
    opensSecondLevel: true,
    closeOnSuccess: false,
  },
  {
    id: "create-project",
    labelKey: "selectors.spotlight.actions.createProject.label",
    icon: Box,
    keywords: ["create project", "new project", "add project", "project"],
    actionId: ACTION_ID.WORKSTATION_CREATE_PROJECT,
    payload: {},
    fallback: "create-project",
    closeOnSuccess: true,
  },
  {
    id: "create-work-item",
    labelKey: "selectors.spotlight.actions.createWorkItem.label",
    icon: SquarePen,
    keywords: [
      "create work item",
      "new work item",
      "add work item",
      "new task",
      "task",
      "work item",
    ],
    actionId: ACTION_ID.WORKSTATION_CREATE_WORK_ITEM,
    payload: {},
    fallback: "create-work-item",
    closeOnSuccess: true,
  },
  {
    id: "search-agent-sessions",
    labelKey: "selectors.spotlight.actions.searchAgentSessions.label",
    icon: Search,
    keywords: [
      "search session",
      "search sessions",
      "agent sessions",
      "open session",
      "find session",
      "session history",
    ],
    shortcut: getShortcutKeys("agent_session_search"),
    actionId: ACTION_ID.SPOTLIGHT_OPEN_AGENT_SESSION_SEARCH,
    payload: {},
    fallback: "search-agent-sessions",
    opensSecondLevel: true,
    closeOnSuccess: false,
  },
  {
    id: "search-all-sessions",
    labelKey: "selectors.spotlight.actions.searchAllSessions.label",
    icon: Search,
    keywords: [
      "full text search",
      "search content",
      "search transcripts",
      "search all sessions",
      "grep sessions",
    ],
    actionId: ACTION_ID.SPOTLIGHT_OPEN_ALL_SESSIONS_SEARCH,
    payload: {},
    fallback: "search-all-sessions",
    opensSecondLevel: true,
    closeOnSuccess: false,
  },
] satisfies SpotlightStaticActionDefinition[];

export const WORKSPACE_ACTIONS = [
  {
    id: "switch-workspace",
    labelKey: "selectors.spotlight.actions.switchWorkspace.label",
    icon: FolderTree,
    keywords: ["switch workspace", "workspace", "repo", "repository", "folder"],
    actionId: ACTION_ID.SPOTLIGHT_OPEN_WORKSPACE_PICKER,
    payload: { mode: "switch" },
    fallback: "workspace-switch",
    opensSecondLevel: true,
    closeOnSuccess: false,
  },
  {
    id: "switch-branch",
    labelKey: "selectors.spotlight.actions.switchBranch.label",
    icon: GitBranch,
    keywords: ["switch branch", "checkout branch", "branch", "git branch"],
    actionId: ACTION_ID.SPOTLIGHT_OPEN_BRANCH_PICKER,
    payload: {},
    fallback: "branch-picker",
    opensSecondLevel: true,
    closeOnSuccess: false,
  },
  {
    id: "add-workspace",
    labelKey: "selectors.spotlight.actions.addWorkspace.label",
    icon: FolderPlus,
    keywords: ["add workspace", "add repo", "add folder", "import workspace"],
    actionId: ACTION_ID.SPOTLIGHT_OPEN_WORKSPACE_PICKER,
    payload: { mode: "add" },
    fallback: "workspace-add",
    opensSecondLevel: true,
    closeOnSuccess: false,
  },
  {
    id: "create-multi-repo-workspace",
    labelKey: "selectors.spotlight.actions.createMultiRepoWorkspace.label",
    icon: FolderTree,
    keywords: [
      "create workspace",
      "multi repo workspace",
      "Multi-repo Workspace",
      "workspace group",
    ],
    actionId: ACTION_ID.SPOTLIGHT_OPEN_WORKSPACE_PICKER,
    payload: { mode: "create" },
    fallback: "workspace-create",
    opensSecondLevel: true,
    closeOnSuccess: false,
  },
] satisfies SpotlightStaticActionDefinition[];

export function buildThemeActions(
  currentThemeId: string
): SpotlightStaticActionDefinition[] {
  const actions: SpotlightStaticActionDefinition[] = [];

  if (currentThemeId !== "system") {
    actions.push({
      id: "set-system-theme",
      labelKey: "common:spotlightActions.switchToSystemTheme",
      icon: MonitorCog,
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
      icon: Sun,
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
      icon: Moon,
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
      icon: Contrast,
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

export const STATION_MODE_ACTIONS = [
  {
    id: "open-my-station",
    labelKey: "common:spotlightActions.openMyStation",
    icon: Dock,
    keywords: ["my station", "workstation", "work station", "coding", "tools"],
    actionId: ACTION_ID.WORKSTATION_OPEN_MY_STATION,
    payload: {},
    fallback: "open-my-station",
    closeOnSuccess: true,
  },
  {
    id: "open-agent-station",
    labelKey: "common:spotlightActions.openAgentStation",
    icon: Sparkles,
    keywords: ["agent station", "agent", "simulator", "replay"],
    actionId: ACTION_ID.WORKSTATION_OPEN_AGENT_STATION,
    payload: {},
    fallback: "open-agent-station",
    closeOnSuccess: true,
  },
  {
    id: "open-kanban",
    labelKey: "common:spotlightActions.openKanban",
    icon: Columns3,
    keywords: ["kanban", "project", "work items"],
    shortcut: getShortcutKeys("open_kanban"),
    actionId: ACTION_ID.WORKSTATION_OPEN_KANBAN,
    payload: {},
    fallback: "open-kanban",
    closeOnSuccess: true,
  },
] satisfies SpotlightStaticActionDefinition[];

export const APP_ACTIONS = [
  {
    id: "detect-update",
    labelKey: "common:spotlightActions.detectUpdate",
    icon: RefreshCw,
    keywords: [
      "detect update",
      "check for update",
      "check for updates",
      "update",
      "app update",
      "software update",
      "upgrade",
      "new version",
    ],
    actionId: ACTION_ID.APP_CHECK_FOR_UPDATES,
    payload: {},
    fallback: "detect-update",
    closeOnSuccess: true,
  },
] satisfies SpotlightStaticActionDefinition[];

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
    icon: myStationChatPosition === "left" ? ArrowBigRight : ArrowBigLeft,
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
    icon: agentStationChatPosition === "left" ? ArrowBigRight : ArrowBigLeft,
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
    icon: LayoutPanelTop,
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
    icon: modelPickerStyle === "spotlight" ? Menu : Sparkles,
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
    icon: PanelLeft,
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

export const EDITOR_ACTIONS = [
  {
    id: "go-to-editor-file",
    modeKey: "file",
    labelKey: "label",
    prefix: "",
    shortcut: getShortcutKeys("quick_open"),
  },
  {
    id: "run-editor-command",
    modeKey: "command",
    labelKey: "label",
    prefix: ">",
    shortcut: ">",
  },
  {
    id: "go-to-editor-symbol",
    modeKey: "symbol",
    labelKey: "label",
    prefix: "@",
    shortcut: getShortcutKeys("go_to_symbol"),
  },
] satisfies SpotlightEditorActionDefinition[];

export const QUICK_NAVIGATION_ACTIONS = [
  {
    id: "open-search-sidebar",
    labelKey: "selectors.spotlight.actions.searchInFiles.label",
    icon: Search,
    keywords: [
      "search files",
      "show search",
      "open search",
      "find in files",
      "code search",
      "code editor",
    ],
    shortcut: getShortcutKeys("search_files"),
    actionId: ACTION_ID.WORKSTATION_OPEN_SEARCH_SIDEBAR,
    payload: {},
    fallback: "open-search-sidebar",
    closeOnSuccess: true,
  },
  {
    id: "open-source-control-tab",
    labelKey: "selectors.spotlight.actions.showSourceControl.label",
    icon: GitPullRequest,
    keywords: [
      "source control",
      "show source control",
      "open source control",
      "git changes",
      "changes",
      "code editor",
    ],
    shortcut: getShortcutKeys("open_source_control_tab"),
    actionId: ACTION_ID.WORKSTATION_OPEN_SOURCE_CONTROL_TAB,
    payload: {},
    fallback: "open-source-control-tab",
    closeOnSuccess: true,
  },
  {
    id: "open-terminal-tab",
    labelKey: "selectors.spotlight.actions.showTerminal.label",
    icon: SquareTerminal,
    keywords: [
      "terminal",
      "show terminal",
      "open terminal",
      "shell",
      "command line",
      "code editor",
    ],
    shortcut: getShortcutKeys("open_terminal_tab"),
    actionId: ACTION_ID.WORKSTATION_OPEN_TERMINAL_TAB,
    payload: {},
    fallback: "open-terminal-tab",
    closeOnSuccess: true,
  },
] satisfies SpotlightStaticActionDefinition[];

// ============================================
// View action builder (state-dependent)
// ============================================

export function buildViewActions(
  isSidebarCollapsed: boolean,
  showWorkstationSidebarAction: boolean,
  showBottomPanelAction: boolean,
  showWorkStationChatFocusAction: boolean,
  isWorkstationSidebarCollapsed: boolean,
  isBottomPanelCollapsed: boolean,
  isChatPanelMaximized: boolean,
  isChatPanelVisible: boolean
): SpotlightStaticActionDefinition[] {
  const actions: SpotlightStaticActionDefinition[] = [
    {
      id: "toggle-sidebar",
      labelKey: isSidebarCollapsed
        ? "selectors.spotlight.actions.showAppSidebar.label"
        : "selectors.spotlight.actions.hideAppSidebar.label",
      icon: PanelLeft,
      keywords: [
        "show app sidebar",
        "hide app sidebar",
        "collapse app sidebar",
        "expand app sidebar",
        "app sidebar",
        "sidebar",
        "view",
      ],
      shortcut: getShortcutKeys("toggle_sidebar"),
      actionId: ACTION_ID.SIDEBAR_TOGGLE,
      payload: {},
      fallback: "toggle-sidebar",
      closeOnSuccess: false,
    },
  ];

  if (showWorkstationSidebarAction) {
    actions.push({
      id: "toggle-workstation-sidebar",
      labelKey: isWorkstationSidebarCollapsed
        ? "selectors.spotlight.actions.showWorkstationSidebar.label"
        : "selectors.spotlight.actions.hideWorkstationSidebar.label",
      icon: List,
      keywords: [
        "show work station sidebar",
        "hide work station sidebar",
        "collapse work station sidebar",
        "expand work station sidebar",
        "tool sidebar",
        "work station sidebar",
        "primary sidebar",
        "view",
      ],
      shortcut: getShortcutKeys("toggle_workstation_sidebar"),
      actionId: ACTION_ID.WORKSTATION_TOGGLE_SIDEBAR,
      payload: {},
      fallback: "toggle-workstation-sidebar",
      closeOnSuccess: false,
    });
  }

  if (showBottomPanelAction) {
    actions.push({
      id: "toggle-bottom-panel",
      labelKey: isBottomPanelCollapsed
        ? "commands.showBottomPanel"
        : "commands.hideBottomPanel",
      icon: PanelBottom,
      keywords: [
        "show bottom panel",
        "hide bottom panel",
        "toggle bottom panel",
        "terminal panel",
        "bottom panel",
        "view",
      ],
      shortcut: getShortcutKeys("toggle_bottom_panel"),
      actionId: ACTION_ID.PANEL_TOGGLE_BOTTOM,
      payload: {},
      fallback: "toggle-bottom-panel",
      closeOnSuccess: false,
    });
  }

  if (showWorkStationChatFocusAction) {
    actions.push({
      id: "toggle-workstation-chat-panel",
      labelKey: isChatPanelVisible
        ? "selectors.spotlight.actions.maximizeWorkStation.label"
        : "selectors.spotlight.actions.restoreChatPanel.label",
      icon: isChatPanelVisible ? Dock : MessageCircle,
      keywords: [
        "maximize work station",
        "hide chat panel",
        "restore chat panel",
        "show chat panel",
        "toggle chat panel",
        "work station",
        "view",
      ],
      shortcut: getShortcutKeys("maximize_work_station"),
      actionId: ACTION_ID.WORKSTATION_TOGGLE_CHAT_PANEL_VISIBILITY,
      payload: {},
      fallback: "toggle-chat-panel",
      closeOnSuccess: false,
    });

    actions.push({
      id: "toggle-workstation-chat-focus",
      labelKey: isChatPanelMaximized
        ? "selectors.spotlight.actions.showWorkstation.label"
        : "selectors.spotlight.actions.focusChatPanel.label",
      icon: isChatPanelMaximized ? Dock : MessageCircle,
      keywords: [
        "focus chat panel",
        "hide work station",
        "show work station",
        "restore work station",
        "chat panel",
        "workstation chat",
        "view",
      ],
      shortcut: getShortcutKeys("maximize_chat"),
      actionId: ACTION_ID.WORKSTATION_TOGGLE_CHAT_FOCUS,
      payload: {},
      fallback: "toggle-chat-focus",
      closeOnSuccess: false,
    });
  }

  actions.push(
    {
      id: "zoom-in",
      labelKey: "selectors.spotlight.actions.zoomIn.label",
      icon: ZoomIn,
      keywords: ["zoom in", "increase zoom", "increase UI scale", "view"],
      shortcut: getShortcutKeys("zoom_in"),
      actionId: ACTION_ID.APP_ZOOM_IN,
      payload: {},
      fallback: "zoom-in",
      closeOnSuccess: false,
    },
    {
      id: "zoom-out",
      labelKey: "selectors.spotlight.actions.zoomOut.label",
      icon: ZoomOut,
      keywords: ["zoom out", "decrease zoom", "decrease UI scale", "view"],
      shortcut: getShortcutKeys("zoom_out"),
      actionId: ACTION_ID.APP_ZOOM_OUT,
      payload: {},
      fallback: "zoom-out",
      closeOnSuccess: false,
    },
    {
      id: "zoom-reset",
      labelKey: "selectors.spotlight.actions.resetZoom.label",
      icon: RotateCcw,
      keywords: ["reset zoom", "reset UI scale", "actual size", "view"],
      shortcut: getShortcutKeys("zoom_reset"),
      actionId: ACTION_ID.APP_ZOOM_RESET,
      payload: {},
      fallback: "zoom-reset",
      closeOnSuccess: false,
    }
  );

  return actions;
}
