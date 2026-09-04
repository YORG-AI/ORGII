/**
 * Spotlight Navigation Action Tables
 *
 * Static, state-independent action tables that act as top-level entry
 * points into app areas: agent/session creation, workspace switching,
 * station mode, quick work-station tab navigation, editor palette modes,
 * and app-level actions. Each constant is a pure data table — no React, no
 * hooks. Split out of `spotlightActionDefinitions.ts`.
 *
 * - `AGENT_SESSION_ACTIONS`    — top-level agent/session entry points.
 * - `WORKSPACE_ACTIONS`        — workspace / repo switching and management.
 * - `ORGANIZATION_ACTIONS`     — organization create / join entry points.
 * - `STATION_MODE_ACTIONS`     — my-station / agent-station / kanban switchers.
 * - `APP_ACTIONS`              — app-level actions (update detection, etc).
 * - `EDITOR_ACTIONS`           — editor palette modes (file / command / symbol).
 * - `QUICK_NAVIGATION_ACTIONS` — work-station tab switchers (terminal, SCM).
 */
import { ACTION_ID } from "@src/ActionSystem";
import { getShortcutKeys } from "@src/config/keyboard/shortcutDisplay";
import {
  Add01Icon,
  AiGenerativeIcon,
  DeliveryBox01Icon,
  DockIcon,
  FolderAddIcon,
  FolderGitTwoIcon,
  FolderLibraryIcon,
  GitPullRequestIcon,
  type IconSvgElement,
  KanbanIcon,
  Login01Icon,
  MessageAdd02Icon,
  PencilEdit02Icon,
  Refresh04Icon,
  Search01Icon,
  SparklesIcon,
  SquareTerminalIcon,
  WorkflowCircle05Icon,
} from "@src/icons";

import type {
  SpotlightEditorActionDefinition,
  SpotlightStaticActionDefinition,
} from "./spotlightActionDefinitions.types";

// ============================================
// Static action tables
// ============================================

/**
 * Custom "database-search" glyph — no equivalent exists in the hugeicons free
 * set, so the original path data is kept verbatim.
 *
 * Ported to hugeicons `IconSvgElement` format. The stroke presentation
 * attributes are spelled out per path to match what hugeicons' own icon
 * modules carry. When rendered via `HugeiconsIcon`, these attributes will
 * be preserved exactly as written.
 */
const STROKE = {
  stroke: "currentColor",
  strokeLinecap: "round",
  strokeLinejoin: "round",
  strokeWidth: "1.5",
} as const;

export const ALL_SESSIONS_SEARCH_ICON: IconSvgElement = [
  [
    "path",
    {
      d: "M4 6c0 1.657 3.582 3 8 3s8-1.343 8-3s-3.582-3-8-3s-8 1.343-8 3",
      ...STROKE,
      key: "database-top",
    },
  ],
  [
    "path",
    {
      d: "M4 6v6c0 1.657 3.582 3 8 3m8-3.5V6",
      ...STROKE,
      key: "database-middle",
    },
  ],
  [
    "path",
    { d: "M4 12v6c0 1.657 3.582 3 8 3", ...STROKE, key: "database-bottom" },
  ],
  ["circle", { cx: "18", cy: "18", r: "3", ...STROKE, key: "search-lens" }],
  ["path", { d: "m20.2 20.2 1.8 1.8", ...STROKE, key: "search-handle" }],
];

export const AGENT_SESSION_ACTIONS = [
  {
    id: "open-agent-control",
    labelKey: "common:adeManager.menuToggle",
    icon: AiGenerativeIcon,
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
    icon: MessageAdd02Icon,
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
    icon: DeliveryBox01Icon,
    keywords: ["create project", "new project", "add project", "project"],
    actionId: ACTION_ID.WORKSTATION_CREATE_PROJECT,
    payload: {},
    fallback: "create-project",
    closeOnSuccess: true,
  },
  {
    id: "create-work-item",
    labelKey: "selectors.spotlight.actions.createWorkItem.label",
    icon: PencilEdit02Icon,
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
    icon: Search01Icon,
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
    icon: ALL_SESSIONS_SEARCH_ICON,
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
    icon: FolderGitTwoIcon,
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
    icon: WorkflowCircle05Icon,
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
    icon: FolderAddIcon,
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
    icon: FolderLibraryIcon,
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

export const ORGANIZATION_ACTIONS = [
  {
    id: "create-organization",
    labelKey: "selectors.spotlight.actions.createOrganization.label",
    icon: Add01Icon,
    keywords: [
      "create organization",
      "create org",
      "new organization",
      "new org",
      "add organization",
      "add org",
    ],
    actionId: ACTION_ID.SPOTLIGHT_OPEN_COLLAB_ORG,
    payload: { mode: "create" },
    fallback: "organization-create",
    opensSecondLevel: true,
    closeOnSuccess: false,
  },
  {
    id: "join-organization",
    labelKey: "selectors.spotlight.actions.joinOrganization.label",
    icon: Login01Icon,
    keywords: [
      "join organization",
      "join org",
      "organization invite",
      "org invite",
      "invite code",
    ],
    actionId: ACTION_ID.SPOTLIGHT_OPEN_COLLAB_ORG,
    payload: { source: "cloud", mode: "join" },
    fallback: "organization-join",
    opensSecondLevel: true,
    closeOnSuccess: false,
  },
] satisfies SpotlightStaticActionDefinition[];

export const STATION_MODE_ACTIONS = [
  {
    id: "open-my-station",
    labelKey: "common:spotlightActions.openMyStation",
    icon: DockIcon,
    keywords: ["my station", "workstation", "work station", "coding", "tools"],
    actionId: ACTION_ID.WORKSTATION_OPEN_MY_STATION,
    payload: {},
    fallback: "open-my-station",
    closeOnSuccess: true,
  },
  {
    id: "open-agent-station",
    labelKey: "common:spotlightActions.openAgentStation",
    icon: SparklesIcon,
    keywords: ["agent station", "agent", "simulator", "replay"],
    actionId: ACTION_ID.WORKSTATION_OPEN_AGENT_STATION,
    payload: {},
    fallback: "open-agent-station",
    closeOnSuccess: true,
  },
  {
    id: "open-kanban",
    labelKey: "common:spotlightActions.openKanban",
    icon: KanbanIcon,
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
    icon: Refresh04Icon,
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
    icon: Search01Icon,
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
    icon: GitPullRequestIcon,
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
    icon: SquareTerminalIcon,
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
