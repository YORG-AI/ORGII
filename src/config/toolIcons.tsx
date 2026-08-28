/**
 * Icon rendering for agent tools and events.
 *
 * **Authoritative icon ids** for built-in tools come from Rust `ToolInfo.icon_id`
 * (`list_all_tools`). `ICON_BY_ID` maps those kebab-case ids to hugeicons
 * glyph data. `mcp-logo` maps to the vendor's `McpServerIcon`, which draws
 * the actual MCP logo mark; other brand marks are hand-authored SVG
 * components handled outside this registry.
 *
 * NOTE: Terminal tool detection uses normalizeFunctionName() (Rust source of truth
 * via cli_agents/alias_map.rs) instead of hardcoded tool names.
 */
import React from "react";

import AnyIcon from "@src/components/AnyIcon";
import {
  getBuiltinToolActionIconId,
  getBuiltinToolIconId,
  getBuiltinToolStatusIconId,
  getCliUiCanonical,
} from "@src/engines/SessionCore/rendering/registry/initToolRegistry";
import {
  Infinity01Icon as Infinity,
  Activity01Icon as Activity,
  ArrowLeftRightIcon as ArrowRightLeft,
  NotificationBubbleIcon as BellRing,
  BookSearchIcon as BookSearch,
  BotIcon as Bot,
  ChatBotIcon as BotMessageSquare,
  BotOffIcon as BotOff,
  BoxIcon as Box,
  FirstBracketIcon as Braces,
  Briefcase01Icon as Briefcase,
  Camera01Icon as Camera,
  CheckmarkCircle01Icon as CheckCircle2,
  InternetIcon as Chrome,
  CircleCheckBigIcon as CircleCheckBig,
  ClipboardCopyIcon as ClipboardCopy,
  ClipboardListIcon as ClipboardList,
  ClipboardPenIcon as ClipboardPen,
  Clock01Icon as Clock,
  DatabaseIcon as Database,
  ViewIcon as Eye,
  FileBoxIcon as FileBox,
  Edit04Icon as FilePenLine,
  FileSearchIcon as FileSearch,
  File02Icon as FileText,
  CenterFocusIcon as Focus,
  FolderCogIcon as FolderCog,
  FolderGitTwoIcon as FolderGit2,
  FolderMinusIcon as FolderMinus,
  FolderOpenIcon as FolderOpen,
  FolderPenIcon as FolderPen,
  FolderAddIcon as FolderPlus,
  FolderSearchIcon as FolderSearch,
  FullScreenIcon as Fullscreen,
  WorkflowCircle05Icon as GitBranch,
  InternetIcon as Globe,
  WorkHistoryIcon as History,
  type IconSvgElement,
  Image01Icon as Image,
  InboxIcon as Inbox,
  KeyboardIcon as Keyboard,
  Layers01Icon as Layers,
  Layout01Icon as Layout,
  ListIcon as List,
  ListChecksIcon as ListChecks,
  ListTodoIcon as ListTodo,
  HierarchyFilesIcon as ListTree,
  LockIcon as Lock,
  LogsIcon as Logs,
  Mail01Icon as Mail,
  MailWarningIcon as MailWarning,
  McpServerIcon as McpLogo,
  BubbleChatIcon as MessageCircle,
  MessageCircleQuestionMarkIcon as MessageCircleQuestionMark,
  MessageSquareReplyIcon as MessageSquareReply,
  MessageMultiple01Icon as MessagesSquare,
  MonitorIcon as Monitor,
  Cursor02Icon as MousePointer2,
  CursorPointer02Icon as MousePointerClick,
  MoveTopIcon as MoveVertical,
  HierarchyCircle01Icon as Network,
  PanelTopIcon as PanelTop,
  Plug01Icon as Plug,
  Refresh04Icon as RefreshCw,
  ScrollIcon as ScrollText,
  Search01Icon as Search,
  MailSend01Icon as Send,
  Share02Icon as Share2,
  Shield01Icon as Shield,
  SecurityCheckIcon as ShieldCheck,
  Shield02Icon as ShieldOff,
  SparkleIcon as Sparkle,
  ComputerTerminal01Icon as Terminal,
  SquareTerminalIcon as TerminalSquare,
  Timer01Icon as Timer,
  Delete02Icon as Trash2,
  UserIcon as User,
  UserMultipleIcon as Users,
  Wrench01Icon as Wrench,
  Cancel01Icon as X,
  CancelCircleIcon as XCircle,
} from "@src/icons";
import { normalizeFunctionName } from "@src/lib/activityData/activityNormalizers";

/** Default size/class for chat ToolCallBlock and Integrations tool rows. */
export const DEFAULT_TOOL_ICON_SIZE = 14;
export const DEFAULT_TOOL_ICON_CLASS = "text-text-2";

/**
 * Maps Rust `icon_id` strings (kebab-case, lucide-era vocabulary) to
 * hugeicons glyph data.
 *
 * Icon ids only ever come from the live registry (`list_all_tools` /
 * `init_tool_registry`) — replayed/persisted sessions store tool NAMES,
 * never icon ids — so this map only needs the union of `icon_id`,
 * `action_icons`, and `status_icons` values in the `ToolEntry` tables in
 * `src-tauri/crates/agent-core/src/core/tools/builtin_tools/table/*.rs`.
 * Keep it in sync with those tables (some keys, e.g. `eye` / `shield` /
 * `move-vertical` / `clock`, are reachable only through action icons).
 */
const ICON_BY_ID: Record<string, IconSvgElement> = {
  activity: Activity,
  "arrow-right-left": ArrowRightLeft,
  "bell-ring": BellRing,
  "book-search": BookSearch,
  bot: Bot,
  "bot-message-square": BotMessageSquare,
  "bot-off": BotOff,
  box: Box,
  braces: Braces,
  camera: Camera,
  "check-circle-2": CheckCircle2,
  chrome: Chrome,
  "circle-check-big": CircleCheckBig,
  "clipboard-copy": ClipboardCopy,
  "clipboard-list": ClipboardList,
  "clipboard-pen": ClipboardPen,
  clock: Clock,
  eye: Eye,
  "file-box": FileBox,
  "file-pen-line": FilePenLine,
  "file-search": FileSearch,
  "file-text": FileText,
  focus: Focus,
  "folder-cog": FolderCog,
  "folder-git-2": FolderGit2,
  "folder-minus": FolderMinus,
  "folder-open": FolderOpen,
  "folder-pen": FolderPen,
  "folder-plus": FolderPlus,
  "folder-search": FolderSearch,
  fullscreen: Fullscreen,
  "git-branch": GitBranch,
  globe: Globe,
  history: History,
  image: Image,
  inbox: Inbox,
  infinity: Infinity,
  keyboard: Keyboard,
  layers: Layers,
  layout: Layout,
  list: List,
  "list-checks": ListChecks,
  "list-todo": ListTodo,
  "list-tree": ListTree,
  lock: Lock,
  mail: Mail,
  "mail-warning": MailWarning,
  "mcp-logo": McpLogo,
  "message-circle": MessageCircle,
  "message-circle-question-mark": MessageCircleQuestionMark,
  "message-square-reply": MessageSquareReply,
  "messages-square": MessagesSquare,
  monitor: Monitor,
  "mouse-pointer-click": MousePointerClick,
  "move-vertical": MoveVertical,
  "mouse-pointer-2": MousePointer2,
  network: Network,
  "panel-top": PanelTop,
  "refresh-cw": RefreshCw,
  "scroll-text": ScrollText,
  search: Search,
  send: Send,
  shield: Shield,
  "shield-check": ShieldCheck,
  "shield-off": ShieldOff,
  sparkle: Sparkle,
  terminal: Terminal,
  "terminal-square": TerminalSquare,
  timer: Timer,
  "trash-2": Trash2,
  user: User,
  users: Users,
  wrench: Wrench,
  x: X,
  "x-circle": XCircle,
};

/**
 * Aliases and legacy names only — not Rust canonical built-ins (those use
 * `getBuiltinToolIconId` + `ICON_BY_ID`). Chat streams often emit
 * adapter names; keep mappings here for icons without an `icon_id` path.
 *
 * Action-specific icons are now defined in Rust `ToolInfo.action_icons` and
 * accessed via `getBuiltinToolActionIconId(toolName, action)`.
 */
export const TOOL_ICON_COMPONENTS: Record<string, IconSvgElement> = {
  // Search aliases
  search_in_file: Search,
  search: Search,
  search_files: Search,
  search_code_files: Search,
  code_search: Search,
  glob_file_search: FileSearch,

  /**
   * Ask-user / clarification tools — Rust `ui_metadata_details` uses
   * `message-circle-question-mark` for `ask_user_questions`. The CLI-agent
   * aliases (`ask_question`, `ask_followup_question`) inherit the same
   * icon to stay consistent. Listed here so we don't fall through to
   * Wrench when `init_tool_registry` is empty or not yet loaded.
   */
  ask_user: MessageCircleQuestionMark,
  ask_question: MessageCircleQuestionMark,
  ask_followup_question: MessageCircleQuestionMark,

  // Misc aliases
  git: GitBranch,
  manage_story_list: Briefcase,
  terminal: Terminal,

  // Claude Code background task management tools
  TaskCreate: Timer,
  task_create: Timer,
  TaskStop: Timer,
  task_stop: Timer,
  TaskOutput: Timer,
  task_output: Timer,
  TaskGet: Timer,
  task_get: Timer,
  TaskList: Timer,
  task_list: Timer,
  TaskUpdate: Timer,
  task_update: Timer,

  // Claude Code shell / execution tools
  PowerShell: Terminal,
  powershell: Terminal,
  power_shell: Terminal,
  Monitor: Terminal,
  monitor: Terminal,

  // Claude Code notebook editing
  NotebookEdit: FilePenLine,
  notebook_edit: FilePenLine,

  // Claude Code plan mode
  EnterPlanMode: ClipboardList,
  enter_plan_mode: ClipboardList,
  ExitPlanMode: ClipboardList,
  exit_plan_mode: ClipboardList,

  // Claude Code git worktree
  EnterWorktree: GitBranch,
  enter_worktree: GitBranch,
  ExitWorktree: GitBranch,
  exit_worktree: GitBranch,

  // Claude Code skill invocation
  Skill: Sparkle,
  skill: Sparkle,

  // Claude Code scheduled/cron tasks
  CronCreate: Clock,
  cron_create: Clock,
  CronDelete: Clock,
  cron_delete: Clock,
  CronList: Clock,
  cron_list: Clock,

  // Claude Code agent team collaboration
  TeamCreate: MessagesSquare,
  team_create: MessagesSquare,
  TeamDelete: MessagesSquare,
  team_delete: MessagesSquare,
  SendMessage: MessagesSquare,
  send_message: MessagesSquare,

  // MCP meta-tools
  ListMcpResourcesTool: Plug,
  list_mcp_resources: Plug,
  ReadMcpResourceTool: Plug,
  read_mcp_resource: Plug,
  ToolSearch: Plug,
  tool_search: Plug,

  // Notification / remote tools
  PushNotification: BellRing,
  push_notification: BellRing,
  RemoteTrigger: Share2,
  remote_trigger: Share2,
  ShareOnboardingGuide: Share2,
  share_onboarding_guide: Share2,
};

/**
 * Check if a tool is a terminal/shell command tool.
 * Uses normalizeFunctionName (Rust source of truth) to resolve CLI aliases:
 * all shell tools (run_shell, bash, Shell, execute, etc.) normalize to "run_shell".
 */
export function isTerminalTool(toolName: string): boolean {
  return normalizeFunctionName(toolName) === "run_shell";
}

/**
 * Get the icon data for a tool.
 *
 * @param toolName - Tool name (e.g., "control_browser", "read_file")
 * @param iconId - Optional explicit icon id (takes precedence)
 * @param action - Optional action name for action-specific icons (e.g., "navigate", "act")
 */
export function getToolIconComponent(
  toolName: string,
  iconId?: string | null,
  action?: string | null
): IconSvgElement {
  const uiCanonical = getCliUiCanonical(toolName);

  // 1. Explicit icon id takes precedence
  if (iconId) {
    const byId = ICON_BY_ID[iconId];
    if (byId) return byId;
  }

  // 2. Action-specific icon from Rust (e.g. control_browser + "navigate" → globe)
  if (action) {
    const actionIconId =
      getBuiltinToolActionIconId(toolName, action) ??
      getBuiltinToolActionIconId(uiCanonical, action);
    if (actionIconId) {
      const fromAction = ICON_BY_ID[actionIconId];
      if (fromAction) return fromAction;
    }
  }

  // 3. Tool's default icon from Rust
  const builtinKebab =
    getBuiltinToolIconId(toolName) ?? getBuiltinToolIconId(uiCanonical);
  if (builtinKebab) {
    const fromBuiltin = ICON_BY_ID[builtinKebab];
    if (fromBuiltin) return fromBuiltin;
  }

  // 4. Frontend alias fallbacks
  const direct =
    TOOL_ICON_COMPONENTS[toolName] ?? TOOL_ICON_COMPONENTS[uiCanonical];
  if (direct) return direct;

  // 5. Prefix-based fallbacks (includes ui_canonical aliases from Rust)
  if (
    toolName === "internal_browser" ||
    toolName === "control_internal_browser" ||
    uiCanonical === "internal_browser" ||
    uiCanonical === "control_internal_browser"
  ) {
    return MousePointerClick;
  }
  if (
    toolName === "browser" ||
    toolName === "control_browser_with_agent_browser" ||
    toolName === "control_browser_with_playwright" ||
    toolName === "control_external_browser" ||
    toolName.startsWith("browser") ||
    uiCanonical === "browser" ||
    uiCanonical === "control_browser_with_agent_browser" ||
    uiCanonical === "control_browser_with_playwright" ||
    uiCanonical === "control_external_browser" ||
    uiCanonical.startsWith("browser")
  ) {
    return Chrome;
  }
  if (toolName.startsWith("db_") || uiCanonical.startsWith("db_")) {
    return Database;
  }
  if (isTerminalTool(toolName) || isTerminalTool(uiCanonical)) return Terminal;

  return Wrench;
}

export interface GetToolIconOptions {
  size?: number;
  className?: string;
  /** When set (e.g. from `list_all_tools`), takes precedence over name-based lookup. */
  iconId?: string | null;
  /** Action name for action-specific icons (e.g., "navigate", "act" for control_browser). */
  action?: string | null;
}

/**
 * Renders the icon for a tool (chat, Integrations, subagents).
 * Supports action-specific icons via the `action` option.
 */
export function getToolIcon(
  toolName: string,
  options?: GetToolIconOptions
): React.ReactNode {
  const icon = getToolIconComponent(toolName, options?.iconId, options?.action);
  const size = options?.size ?? DEFAULT_TOOL_ICON_SIZE;
  const className = options?.className ?? DEFAULT_TOOL_ICON_CLASS;
  return <AnyIcon icon={icon} size={size} className={className} />;
}

// ============================================
// Event Icons (status-dependent)
// ============================================

/**
 * Get the icon data for an event, optionally resolved by status.
 *
 * Priority:
 * 1. Status-specific icon from Rust (e.g., approval_request + "approved" → check-circle-2)
 * 2. Action-specific icon from Rust (e.g., await_output + "monitor" → focus)
 * 3. Event's default icon from Rust (e.g., approval_request → clock)
 * 4. Falls through to getToolIconComponent() for legacy/alias resolution
 */
export function getEventIconComponent(
  eventType: string,
  status?: string | null,
  action?: string | null
): IconSvgElement {
  const uiCanonical = getCliUiCanonical(eventType);

  if (status) {
    const statusIconId =
      getBuiltinToolStatusIconId(eventType, status) ??
      getBuiltinToolStatusIconId(uiCanonical, status);
    if (statusIconId) {
      const icon = ICON_BY_ID[statusIconId];
      if (icon) return icon;
    }
    // Registry not loaded or missing status row — match Rust `row_with_status` defaults
    if (eventType === "ask_user_questions" && status === "answered") {
      return CheckCircle2;
    }
  }

  const toolIcon = getToolIconComponent(eventType, undefined, action);
  return toolIcon === Wrench ? Logs : toolIcon;
}

export interface GetEventIconOptions {
  size?: number;
  className?: string;
  /** Event result status (e.g., "approved", "denied", "switched", "answered"). */
  status?: string | null;
  /** Action / sub-command name for action-specific icons (e.g., await_output "monitor"). */
  action?: string | null;
}

/**
 * Renders the icon for a chat event with optional status-dependent resolution.
 * All event components should use this instead of importing glyphs directly.
 */
export function getEventIcon(
  eventType: string,
  options?: GetEventIconOptions
): React.ReactNode {
  const icon = getEventIconComponent(
    eventType,
    options?.status,
    options?.action
  );
  const size = options?.size ?? DEFAULT_TOOL_ICON_SIZE;
  const className = options?.className ?? DEFAULT_TOOL_ICON_CLASS;
  return <AnyIcon icon={icon} size={size} className={className} />;
}
