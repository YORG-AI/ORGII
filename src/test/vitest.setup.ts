/**
 * Vitest Global Setup
 *
 * Injects test fixtures for modules that depend on Tauri IPC at runtime.
 * In production, these maps are loaded via `initToolRegistry()` during app init.
 * In tests (Node.js), we inject the static data directly.
 *
 * These fixtures mirror the Rust source of truth:
 * - builtin_tools_list.rs (simulator_app, icon_id, app_subtool)
 * - cli_agents/alias_map.rs (alias → storage, ui, simulator_app, app_subtool)
 *
 * NOTE: Executes at module load time (not beforeAll) so that maps are ready
 * before any test file imports normalizers or other modules that call the maps.
 */
import i18next from "i18next";
import { vi } from "vitest";

import {
  _setBuiltinActionIconsMap,
  _setBuiltinActionsMap,
  _setBuiltinAppSubtoolMap,
  _setBuiltinIconIdMap,
  _setBuiltinLabelsMap,
  _setBuiltinSimulatorMap,
  _setCliToolAliasMap,
} from "@src/engines/SessionCore/rendering/registry/initToolRegistry";
import type { ToolActionInfo } from "@src/engines/SessionCore/rendering/registry/initToolRegistry";
import type {
  AliasEntry,
  AppSubtool,
} from "@src/engines/SessionCore/rendering/registry/types";
import { AppType } from "@src/engines/Simulator/types/appTypes";
import enSessions from "@src/i18n/locales/en/sessions.json";

vi.mock("@tauri-apps/api/webviewWindow", () => {
  const currentWindow = {
    close: vi.fn(),
    minimize: vi.fn(),
    maximize: vi.fn(),
    unmaximize: vi.fn(),
    isMaximized: vi.fn(() => Promise.resolve(false)),
  };

  return {
    WebviewWindow: {
      getCurrent: () => currentWindow,
    },
  };
});

// ============================================================================
// Test Fixtures (mirrors Rust source of truth)
// ============================================================================

/**
 * Builtin tool name → SimulatorApp (from builtin_tools_list.rs)
 */
const BUILTIN_SIMULATOR_APP_FIXTURE: Map<string, AppType> = new Map([
  // Coding tools → CODE_EDITOR
  ["read_file", AppType.CODE_EDITOR],
  ["list_dir", AppType.CODE_EDITOR],
  ["run_shell", AppType.CODE_EDITOR],
  ["await_output", AppType.CODE_EDITOR],
  ["inspect_terminals", AppType.CODE_EDITOR],
  ["code_search", AppType.CODE_EDITOR],
  ["manage_workspace", AppType.CODE_EDITOR],
  ["edit_file", AppType.CODE_EDITOR],
  ["delete_file", AppType.CODE_EDITOR],
  ["query_lsp", AppType.CODE_EDITOR],
  ["manage_lsp", AppType.CODE_EDITOR],
  ["setup_repo", AppType.CODE_EDITOR],

  // Web/Browser tools → BROWSER
  ["web_search", AppType.BROWSER],
  ["web_fetch", AppType.BROWSER],
  ["control_browser_with_agent_browser", AppType.BROWSER],
  ["control_browser_with_playwright", AppType.BROWSER],
  ["control_external_browser", AppType.BROWSER],
  ["control_internal_browser", AppType.BROWSER],
  ["control_desktop_with_peekaboo", AppType.BROWSER],

  // Agent/Channels tools → CHANNELS
  ["manage_todo", AppType.CHANNELS],
  ["task_create", AppType.CHANNELS],
  ["task_update", AppType.CHANNELS],
  ["task_list", AppType.CHANNELS],
  ["task_get", AppType.CHANNELS],
  ["control_orgii", AppType.CHANNELS],
  ["manage_nodes", AppType.CODE_EDITOR],
  ["query_knowledge", AppType.CHANNELS],
  ["ask_user_questions", AppType.CHANNELS],
  ["ask_user_permissions", AppType.CHANNELS],
  ["suggest_mode_switch", AppType.CHANNELS],
  ["manage_session", AppType.CHANNELS],
  ["send_message", AppType.CHANNELS],
  ["send_to_inbox", AppType.CHANNELS],
  ["agent", AppType.CHANNELS],
  ["manage_agent_def", AppType.CHANNELS],
  ["submit_output", AppType.CHANNELS],
  ["worktree", AppType.CODE_EDITOR],
  ["tool_search", AppType.CODE_EDITOR],
  ["mcp_tool", AppType.CODE_EDITOR],
  ["tool_call", AppType.CODE_EDITOR],

  // Project tools → STORY_MANAGER
  ["manage_story", AppType.STORY_MANAGER],
  ["manage_work_item", AppType.STORY_MANAGER],
]);

/**
 * Builtin tool name → AppSubtool (from builtin_tools_list.rs)
 */
const BUILTIN_SUBTOOL_FIXTURE: Map<string, AppSubtool> = new Map([
  // Coding tools
  ["read_file", "file_read"],
  ["list_dir", "explore"],
  ["run_shell", "shell"],
  ["await_output", "shell"],
  ["inspect_terminals", "shell"],
  ["code_search", "explore"],
  ["manage_workspace", "explore"],
  ["edit_file", "file_write"],
  ["delete_file", "file_write"],
  ["query_lsp", "explore"],
  ["manage_lsp", "other_tool"],
  ["setup_repo", "other_tool"],

  // Web/Browser tools
  ["web_search", "browser"],
  ["web_fetch", "browser"],
  ["control_browser_with_agent_browser", "browser"],
  ["control_browser_with_playwright", "browser"],
  ["control_external_browser", "browser"],
  ["control_internal_browser", "internal_browser"],
  ["control_desktop_with_peekaboo", "browser"],

  // Agent/Channels tools
  ["manage_todo", "todo"],
  ["task_create", "todo"],
  ["task_update", "todo"],
  ["task_list", "todo"],
  ["task_get", "todo"],
  ["control_orgii", "message"],
  ["manage_nodes", "other_tool"],
  ["query_knowledge", "message"],
  ["ask_user_questions", "other_interactions"],
  ["ask_user_permissions", "other_interactions"],
  ["suggest_mode_switch", "other_interactions"],
  ["manage_session", "subagent"],
  ["send_message", "message"],
  ["send_to_inbox", "message"],
  ["agent", "subagent"],
  ["manage_agent_def", "message"],
  ["submit_output", "message"],
  ["worktree", "other_tool"],
  ["tool_search", "explore"],
  ["mcp_tool", "other_tool"],
  ["tool_call", "other_tool"],

  // Project tools
  ["manage_story", "project"],
  ["manage_work_item", "project"],
]);

type LabelKeySet = { running: string; done: string; failed: string };

function labelKeys(prefix: string): LabelKeySet {
  return {
    running: `tools.${prefix}Running`,
    done: `tools.${prefix}Done`,
    failed: `tools.${prefix}Failed`,
  };
}

function actionInfo(
  name: string,
  labels: LabelKeySet,
  appSubtool?: ToolActionInfo["appSubtool"]
): ToolActionInfo {
  return {
    name,
    summary: name,
    appSubtool,
    labelRunning: labels.running,
    labelDone: labels.done,
    labelFailed: labels.failed,
  };
}

const INTERNAL_BROWSER_ACTION_NAMES = [
  "list",
  "is_ready",
  "get_state",
  "click",
  "input",
  "select",
  "scroll",
  "show_mask",
  "hide_mask",
  "clean_up",
] as const;

const INTERNAL_BROWSER_ACTION_LABEL_KEYS: Record<
  (typeof INTERNAL_BROWSER_ACTION_NAMES)[number],
  LabelKeySet
> = {
  list: labelKeys("internalBrowser"),
  is_ready: labelKeys("internalBrowser"),
  get_state: labelKeys("internalBrowserGetState"),
  click: labelKeys("internalBrowserClick"),
  input: labelKeys("internalBrowserInput"),
  select: labelKeys("internalBrowserSelect"),
  scroll: labelKeys("internalBrowserScroll"),
  show_mask: labelKeys("internalBrowserShowMask"),
  hide_mask: labelKeys("internalBrowserHideMask"),
  clean_up: labelKeys("internalBrowserCleanUp"),
};

function buildInternalBrowserActionFixture(): ToolActionInfo[] {
  return INTERNAL_BROWSER_ACTION_NAMES.map((name) =>
    actionInfo(
      name,
      INTERNAL_BROWSER_ACTION_LABEL_KEYS[name],
      "internal_browser"
    )
  );
}

const BROWSER_ACTION_NAMES = [
  "open",
  "click",
  "type",
  "press",
  "hover",
  "fill",
  "evaluate",
  "wait",
  "scroll",
  "select",
  "snapshot",
  "screenshot",
  "tabs",
  "console",
  "close",
] as const;

const BROWSER_ACTION_LABEL_KEYS: Record<
  (typeof BROWSER_ACTION_NAMES)[number],
  { running: string; done: string; failed: string }
> = {
  open: {
    running: "tools.browserOpenRunning",
    done: "tools.browserOpenDone",
    failed: "tools.browserOpenFailed",
  },
  click: {
    running: "tools.browserClickRunning",
    done: "tools.browserClickDone",
    failed: "tools.browserClickFailed",
  },
  type: {
    running: "tools.browserTypeRunning",
    done: "tools.browserTypeDone",
    failed: "tools.browserTypeFailed",
  },
  press: {
    running: "tools.browserPressRunning",
    done: "tools.browserPressDone",
    failed: "tools.browserPressFailed",
  },
  hover: {
    running: "tools.browserHoverRunning",
    done: "tools.browserHoverDone",
    failed: "tools.browserHoverFailed",
  },
  fill: {
    running: "tools.browserFillRunning",
    done: "tools.browserFillDone",
    failed: "tools.browserFillFailed",
  },
  evaluate: {
    running: "tools.browserEvaluateRunning",
    done: "tools.browserEvaluateDone",
    failed: "tools.browserEvaluateFailed",
  },
  wait: {
    running: "tools.browserWaitRunning",
    done: "tools.browserWaitDone",
    failed: "tools.browserWaitFailed",
  },
  scroll: {
    running: "tools.browserScrollRunning",
    done: "tools.browserScrollDone",
    failed: "tools.browserScrollFailed",
  },
  select: {
    running: "tools.browserSelectRunning",
    done: "tools.browserSelectDone",
    failed: "tools.browserSelectFailed",
  },
  snapshot: {
    running: "tools.browserSnapshotRunning",
    done: "tools.browserSnapshotDone",
    failed: "tools.browserSnapshotFailed",
  },
  screenshot: {
    running: "tools.browserScreenshotRunning",
    done: "tools.browserScreenshotDone",
    failed: "tools.browserScreenshotFailed",
  },
  tabs: {
    running: "tools.browserTabsRunning",
    done: "tools.browserTabsDone",
    failed: "tools.browserTabsFailed",
  },
  console: {
    running: "tools.browserConsoleRunning",
    done: "tools.browserConsoleDone",
    failed: "tools.browserConsoleFailed",
  },
  close: {
    running: "tools.browserCloseRunning",
    done: "tools.browserCloseDone",
    failed: "tools.browserCloseFailed",
  },
};

function buildBrowserActionFixture(): ToolActionInfo[] {
  return BROWSER_ACTION_NAMES.map((name) => ({
    name,
    summary: name,
    appSubtool: "browser",
    labelRunning: BROWSER_ACTION_LABEL_KEYS[name].running,
    labelDone: BROWSER_ACTION_LABEL_KEYS[name].done,
    labelFailed: BROWSER_ACTION_LABEL_KEYS[name].failed,
  }));
}

const BUILTIN_LABELS_FIXTURE: Map<string, LabelKeySet> = new Map([
  ["control_browser_with_agent_browser", labelKeys("browser")],
  ["control_browser_with_playwright", labelKeys("browser")],
  ["control_internal_browser", labelKeys("internalBrowser")],
  ["web_search", labelKeys("webSearch")],
  ["web_fetch", labelKeys("webFetch")],
  ["read_file", labelKeys("readFile")],
  ["list_dir", labelKeys("listDir")],
  ["run_shell", labelKeys("runShell")],
  ["await_output", labelKeys("awaitOutput")],
  ["inspect_terminals", labelKeys("inspectTerminals")],
  ["code_search", labelKeys("searchGrep")],
  ["manage_workspace", labelKeys("manageWorkspaceList")],
  ["edit_file", labelKeys("editFile")],
  ["delete_file", labelKeys("deleteFile")],
  ["query_lsp", labelKeys("queryLsp")],
  ["manage_lsp", labelKeys("manageLsp")],
  ["manage_todo", labelKeys("manageTodo")],
  ["task_create", labelKeys("taskCreate")],
  ["task_update", labelKeys("taskUpdate")],
  ["task_list", labelKeys("taskList")],
  ["task_get", labelKeys("taskGet")],
  ["setup_repo", labelKeys("setupRepo")],
  ["worktree", labelKeys("worktree")],
  ["manage_nodes", labelKeys("manageNodes")],
  ["ask_user", labelKeys("askUser")],
  ["subagent", labelKeys("subagent")],
]);

const BUILTIN_ACTIONS_FIXTURE: Map<string, ToolActionInfo[]> = new Map([
  ["control_browser_with_agent_browser", buildBrowserActionFixture()],
  ["control_browser_with_playwright", buildBrowserActionFixture()],
  ["control_internal_browser", buildInternalBrowserActionFixture()],
  [
    "read_file",
    [
      actionInfo("read_image", labelKeys("readImage"), "file_read"),
      actionInfo("read_pdf", labelKeys("readPdf"), "file_read"),
    ],
  ],
  [
    "inspect_terminals",
    [
      actionInfo("list", labelKeys("inspectTerminalsList"), "shell"),
      actionInfo(
        "read_output",
        labelKeys("inspectTerminalsReadOutput"),
        "shell"
      ),
      actionInfo(
        "write_input",
        labelKeys("inspectTerminalsWriteInput"),
        "shell"
      ),
      actionInfo("close", labelKeys("inspectTerminalsClose"), "shell"),
    ],
  ],
  [
    "code_search",
    [
      actionInfo("grep", labelKeys("searchGrep"), "search"),
      actionInfo("find_files", labelKeys("searchFindFiles"), "glob"),
      actionInfo("glob", labelKeys("searchGlob"), "glob"),
      actionInfo("symbols", labelKeys("searchSymbols"), "search"),
      actionInfo("check_status", labelKeys("searchCheckStatus"), "other_tool"),
    ],
  ],
  [
    "manage_workspace",
    [
      actionInfo("list", labelKeys("manageWorkspaceList"), "explore"),
      actionInfo("add", labelKeys("manageWorkspaceAdd"), "explore"),
      actionInfo("create", labelKeys("manageWorkspaceCreate"), "explore"),
      actionInfo("remove", labelKeys("manageWorkspaceRemove"), "explore"),
    ],
  ],
  [
    "worktree",
    [
      actionInfo("add", labelKeys("worktreeAdd"), "other_tool"),
      actionInfo("leave", labelKeys("worktreeLeave"), "other_tool"),
      actionInfo("list", labelKeys("worktreeList"), "other_tool"),
    ],
  ],
]);

/**
 * Builtin tool name → icon_id (from builtin_tools_list.rs)
 */
const BUILTIN_ICON_ID_FIXTURE: Map<string, string> = new Map([
  ["read_file", "file-text"],
  ["list_dir", "folder-open"],
  ["run_shell", "terminal"],
  ["await_output", "timer"],
  ["inspect_terminals", "terminal-square"],
  ["code_search", "search"],
  ["manage_workspace", "folder-git-2"],
  ["edit_file", "file-pen-line"],
  ["delete_file", "trash-2"],
  ["query_lsp", "braces"],
  ["manage_lsp", "braces"],
  ["manage_todo", "clipboard-list"],
  ["task_create", "clipboard-copy"],
  ["task_update", "clipboard-pen"],
  ["task_list", "list-checks"],
  ["task_get", "clipboard-list"],
  ["setup_repo", "folder-cog"],
  ["web_search", "globe"],
  ["web_fetch", "globe"],
  ["control_browser_with_agent_browser", "chrome"],
  ["control_browser_with_playwright", "chrome"],
  ["control_external_browser", "chrome"],
  ["control_desktop_with_peekaboo", "monitor"],
  ["control_orgii", "cog"],
  ["manage_nodes", "network"],
  ["query_knowledge", "book-search"],
  ["ask_user_questions", "message-circle-question-mark"],
  ["manage_session", "box"],
  ["send_message", "send"],
  ["send_to_inbox", "inbox"],
  ["agent", "arrow-right-left"],
  ["worktree", "git-branch"],
  ["tool_search", "book-search"],
  ["manage_story", "layout-list"],
  ["manage_work_item", "layout-list"],
]);

/**
 * Builtin tool name → (action → icon_id) (from `ToolInfo.action_icons`)
 *
 * Mirrors `action_icons: &[(&str, &str)]` on each ToolEntry — used by
 * `getBuiltinToolActionIconId()` to resolve per-action header icons.
 */
const BUILTIN_ACTION_ICONS_FIXTURE: Map<string, Map<string, string>> = new Map([
  [
    "inspect_terminals",
    new Map([
      ["read_output", "scroll-text"],
      ["write_input", "keyboard"],
      ["close", "x"],
    ]),
  ],
  [
    "manage_agent_def",
    new Map([
      ["list", "bot-message-square"],
      ["get", "bot-message-square"],
      ["create", "bot"],
      ["update", "refresh-cw"],
      ["remove", "bot-off"],
      ["list_orgs", "users"],
      ["get_org", "users"],
      ["create_org", "bot"],
      ["update_org", "refresh-cw"],
      ["remove_org", "bot-off"],
    ]),
  ],
]);

/**
 * CLI alias → (storage, ui, simulatorApp, subtool) canonical (from cli_agents/alias_map.rs)
 * This is a comprehensive subset covering all test scenarios.
 *
 * Helpers to reduce verbosity - each includes the appropriate appSubtool:
 */
const codeRead = (storage: string, ui: string): AliasEntry => ({
  storage,
  ui,
  simulatorApp: "CODE_EDITOR",
  appSubtool: "file_read",
  chatBlock: "read_file",
});
const codeWrite = (storage: string, ui: string): AliasEntry => ({
  storage,
  ui,
  simulatorApp: "CODE_EDITOR",
  appSubtool: "file_write",
  chatBlock: "diff",
});
const codeShell = (storage: string, ui: string): AliasEntry => ({
  storage,
  ui,
  simulatorApp: "CODE_EDITOR",
  appSubtool: "shell",
  chatBlock: "shell",
});
const codeSearch = (storage: string, ui: string): AliasEntry => ({
  storage,
  ui,
  simulatorApp: "CODE_EDITOR",
  appSubtool: "explore",
  chatBlock: "search",
});
const codeMsg = (storage: string, ui: string): AliasEntry => ({
  storage,
  ui,
  simulatorApp: "CODE_EDITOR",
  appSubtool: "message",
  chatBlock: "fallback",
});
const msg = (storage: string, ui: string): AliasEntry => ({
  storage,
  ui,
  simulatorApp: "CHANNELS",
  appSubtool: "message",
  chatBlock: "fallback",
});
const todoMsg = (storage: string, ui: string): AliasEntry => ({
  storage,
  ui,
  simulatorApp: "CHANNELS",
  appSubtool: "todo",
  chatBlock: "todo",
});
const orgTaskMsg = (storage: string, ui: string): AliasEntry => ({
  storage,
  ui,
  simulatorApp: "CHANNELS",
  appSubtool: "todo",
  chatBlock: "org_task",
});
const subagentMsg = (storage: string, ui: string): AliasEntry => ({
  storage,
  ui,
  simulatorApp: "CHANNELS",
  appSubtool: "subagent",
  chatBlock: "subagent",
});
const thinkMsg = (storage: string, ui: string): AliasEntry => ({
  storage,
  ui,
  simulatorApp: "CHANNELS",
  appSubtool: "thinking",
  chatBlock: "fallback",
});
const browserSub = (storage: string, ui: string): AliasEntry => ({
  storage,
  ui,
  simulatorApp: "BROWSER",
  appSubtool: "browser",
  chatBlock: "web_search",
});

const CLI_ALIAS_MAP_FIXTURE: Map<string, AliasEntry> = new Map([
  // ═══════════════════════════════════════════════════════════════════════════
  // File Operations (CODE_EDITOR)
  // ═══════════════════════════════════════════════════════════════════════════
  ["Read", codeRead("read_file", "read_file")],
  ["READ", codeRead("read_file", "read_file")],
  ["read", codeRead("read_file", "read_file")],
  ["read_file", codeRead("read_file", "read_file")],
  ["ReadFile", codeRead("read_file", "read_file")],
  ["readToolCall", codeRead("read_file", "read_file")],
  ["file_read", codeRead("read_file", "read_file")],
  ["cat", codeRead("read_file", "read_file")],
  ["view_file", codeRead("read_file", "read_file")],

  ["Edit", codeWrite("edit_file_by_replace", "edit_file")],
  ["EDIT", codeWrite("edit_file_by_replace", "edit_file")],
  ["edit", codeWrite("edit_file_by_replace", "edit_file")],
  ["edit_file", codeWrite("edit_file", "edit_file")],
  ["MultiEdit", codeWrite("edit_file_by_replace", "edit_file")],
  ["edit_file_by_replace", codeWrite("edit_file_by_replace", "edit_file")],
  ["editToolCall", codeWrite("edit_file_by_replace", "edit_file")],
  ["file_diff", codeWrite("edit_file_by_replace", "edit_file")],
  ["append_file", codeWrite("edit_file_by_replace", "edit_file")],
  ["file_range_edit", codeWrite("edit_file_by_replace", "edit_file")],
  ["insert_content_at_line", codeWrite("edit_file_by_replace", "edit_file")],

  ["Write", codeWrite("create_file", "edit_file")],
  ["WRITE", codeWrite("create_file", "edit_file")],
  ["write", codeWrite("create_file", "edit_file")],
  ["write_file", codeWrite("create_file", "edit_file")],
  ["create_file", codeWrite("create_file", "edit_file")],
  ["createToolCall", codeWrite("create_file", "edit_file")],

  ["Delete", codeWrite("delete_file", "delete_file")],
  ["delete", codeWrite("delete_file", "delete_file")],
  ["deleteToolCall", codeWrite("delete_file", "delete_file")],
  ["remove_file", codeWrite("delete_file", "delete_file")],
  ["delete_file", codeWrite("delete_file", "delete_file")],

  ["LS", codeSearch("list_directory", "list_dir")],
  ["Ls", codeSearch("list_directory", "list_dir")],
  ["ls", codeSearch("list_directory", "list_dir")],
  ["ListDir", codeSearch("list_directory", "list_dir")],
  ["list_directory", codeSearch("list_directory", "list_dir")],

  // ═══════════════════════════════════════════════════════════════════════════
  // Terminal / Shell (CODE_EDITOR)
  // ═══════════════════════════════════════════════════════════════════════════
  ["Shell", codeShell("run_command_line", "run_shell")],
  ["SHELL", codeShell("run_command_line", "run_shell")],
  ["shell", codeShell("run_command_line", "run_shell")],
  ["Bash", codeShell("run_command_line", "run_shell")],
  ["BASH", codeShell("run_command_line", "run_shell")],
  ["bash", codeShell("run_command_line", "run_shell")],
  ["shellToolCall", codeShell("run_command_line", "run_shell")],
  ["run_command_line", codeShell("run_command_line", "run_shell")],
  ["command_execution", codeShell("run_command_line", "run_shell")],
  ["Execute", codeShell("run_command_line", "run_shell")],
  ["execute", codeShell("run_command_line", "run_shell")],
  ["exec", codeShell("run_command_line", "run_shell")],
  ["run_shell", codeShell("run_command_line", "run_shell")],
  ["run_terminal_cmd", codeShell("run_command_line", "run_shell")],
  ["run_command", codeShell("run_command_line", "run_shell")],

  // ═══════════════════════════════════════════════════════════════════════════
  // Search (CODE_EDITOR for codebase, BROWSER for web)
  // ═══════════════════════════════════════════════════════════════════════════
  ["grep", codeSearch("grep", "code_search")],
  ["Grep", codeSearch("grep", "code_search")],
  ["GREP", codeSearch("grep", "code_search")],
  ["search", codeSearch("code_search", "code_search")],
  ["code_search", codeSearch("code_search", "code_search")],
  ["ripgrep", codeSearch("grep", "code_search")],
  ["Search", codeSearch("codebase_search", "code_search")],
  ["searchToolCall", codeSearch("code_search", "code_search")],
  ["search_codebase", codeSearch("code_search", "code_search")],
  ["codebase_search", codeSearch("code_search", "code_search")],
  ["search_code", codeSearch("code_search", "code_search")],

  ["WebSearch", browserSub("web_search", "web_search")],
  ["web_fetch", browserSub("web_fetch", "web_search")],
  ["WebFetch", browserSub("web_fetch", "web_search")],
  ["load_web_page", browserSub("web_fetch", "web_search")],

  ["file_search", codeSearch("glob_file_search", "glob_file_search")],
  ["find_files", codeSearch("glob_file_search", "glob_file_search")],
  ["glob", codeSearch("glob_file_search", "glob_file_search")],
  ["Glob", codeSearch("glob_file_search", "glob_file_search")],
  ["GLOB", codeSearch("glob_file_search", "glob_file_search")],
  ["search_files", codeSearch("glob_file_search", "glob_file_search")],
  ["glob_file_search", codeSearch("glob_file_search", "glob_file_search")],

  // ═══════════════════════════════════════════════════════════════════════════
  // Conversation / Messages (CHANNELS)
  // ═══════════════════════════════════════════════════════════════════════════
  ["assistant", msg("assistant", "assistant")],
  ["message", msg("assistant", "assistant")],
  ["send_message", msg("assistant", "assistant")],
  ["message_delta", msg("assistant", "assistant")],
  ["assistant_delta", msg("assistant", "assistant")],
  ["assistant_message", msg("assistant", "assistant")],
  ["agent_message", msg("assistant", "agent_message")],
  ["agent_message_delta", msg("assistant", "agent_message")],

  ["thinking", thinkMsg("thinking", "thinking")],
  ["think", thinkMsg("thinking", "thinking")],
  ["llm_thinking", thinkMsg("thinking", "thinking")],
  ["llm_thinking_delta", thinkMsg("thinking", "thinking")],
  ["thinking_delta", thinkMsg("thinking", "thinking")],
  ["reasoning", thinkMsg("thinking", "thinking")],
  ["internal_monologue", thinkMsg("thinking", "thinking")],
  ["reflection", thinkMsg("thinking", "thinking")],

  ["ask_question", msg("ask_user_questions", "ask_user_questions")],
  ["ask_followup_question", msg("ask_user_questions", "ask_user_questions")],
  ["question", msg("ask_user_questions", "ask_user_questions")],
  ["ask_user", msg("ask_user_questions", "ask_user_questions")],
  ["ask_user_questions", msg("ask_user_questions", "ask_user_questions")],
  ["AskUserQuestion", msg("ask_user_questions", "ask_user_questions")],
  ["AskQuestion", msg("ask_user_questions", "ask_user_questions")],

  ["user", msg("user", "user")],
  ["raw", msg("user", "user")],
  ["raw_event", msg("user", "user")],

  // ═══════════════════════════════════════════════════════════════════════════
  // Todo (CHANNELS)
  // ═══════════════════════════════════════════════════════════════════════════
  ["manage_todo", todoMsg("manage_todo", "manage_todo")],
  ["task_create", orgTaskMsg("task_create", "task_create")],
  ["TaskCreate", orgTaskMsg("task_create", "task_create")],
  ["task_update", orgTaskMsg("task_update", "task_update")],
  ["TaskUpdate", orgTaskMsg("task_update", "task_update")],
  ["task_list", orgTaskMsg("task_list", "task_list")],
  ["TaskList", orgTaskMsg("task_list", "task_list")],
  ["task_get", orgTaskMsg("task_get", "task_get")],
  ["TaskGet", orgTaskMsg("task_get", "task_get")],
  ["todo_write", todoMsg("manage_todo", "manage_todo")],
  ["TodoWrite", todoMsg("manage_todo", "manage_todo")],
  ["UpdateTodos", todoMsg("manage_todo", "manage_todo")],

  // ═══════════════════════════════════════════════════════════════════════════
  // Subagent / Task (CHANNELS)
  // ═══════════════════════════════════════════════════════════════════════════
  ["subagent", subagentMsg("subagent", "subagent")],
  ["Task", subagentMsg("subagent", "subagent")],
  ["task", subagentMsg("subagent", "subagent")],
  ["session", subagentMsg("subagent", "subagent")],
  ["manage_session", subagentMsg("subagent", "subagent")],
  ["agent", subagentMsg("subagent", "subagent")],
  ["spawn", subagentMsg("subagent", "subagent")],
  ["spawn_agent", subagentMsg("subagent", "subagent")],
  ["spawn_sub_agent", subagentMsg("subagent", "subagent")],

  // ═══════════════════════════════════════════════════════════════════════════
  // Mode switch (CHANNELS)
  // ═══════════════════════════════════════════════════════════════════════════
  ["suggest_mode_switch", msg("suggest_mode_switch", "suggest_mode_switch")],
  ["SuggestModeSwitch", msg("suggest_mode_switch", "suggest_mode_switch")],

  // ═══════════════════════════════════════════════════════════════════════════
  // Browser (BROWSER)
  // ═══════════════════════════════════════════════════════════════════════════
  ["browser", browserSub("browser", "browser")],
  ["control_browser_with_agent_browser", browserSub("browser", "browser")],
  ["control_browser_with_playwright", browserSub("browser", "browser")],
  ["control_external_browser", browserSub("browser", "browser")],
  ["control_desktop_with_peekaboo", browserSub("browser", "browser")],
  ["browser_navigate", browserSub("browser", "browser")],
  ["browser_act", browserSub("browser", "browser")],
  ["browser_screenshot", browserSub("browser", "browser")],
  ["browser_snapshot", browserSub("browser", "browser")],
  ["browser_open", browserSub("browser", "browser")],
  ["browser_visit", browserSub("browser", "browser")],
  ["web_navigate", browserSub("browser", "browser")],
  ["web_open", browserSub("browser", "browser")],
  ["navigate_url", browserSub("browser", "browser")],
  ["open_url", browserSub("browser", "browser")],
  ["visit_page", browserSub("browser", "browser")],

  // ═══════════════════════════════════════════════════════════════════════════
  // MCP server tools (CODE_EDITOR)
  // ═══════════════════════════════════════════════════════════════════════════
  ["mcp_tool", codeMsg("mcp_tool", "mcp_tool")],
  ["Mcp", codeMsg("mcp_tool", "mcp_tool")],
  ["mcp", codeMsg("mcp_tool", "mcp_tool")],

  // ═══════════════════════════════════════════════════════════════════════════
  // Generic tool_call fallback (CODE_EDITOR)
  // ═══════════════════════════════════════════════════════════════════════════
  ["call_tool", codeMsg("tool_call", "tool_call")],

  // ═══════════════════════════════════════════════════════════════════════════
  // Workflow / orchestration (CHANNELS)
  // ═══════════════════════════════════════════════════════════════════════════
  ["schedule_task", msg("schedule_task", "schedule_task")],

  // ═══════════════════════════════════════════════════════════════════════════
  // Session / lifecycle events (CHANNELS for notifications, CODE_EDITOR for merge)
  // ═══════════════════════════════════════════════════════════════════════════
  ["approval_request", msg("ask_user_permissions", "ask_user_permissions")],
  ["ask_user_permissions", msg("ask_user_permissions", "ask_user_permissions")],
  ["approval_response", msg("ask_user_permissions", "ask_user_permissions")],
]);

class MemoryStorage implements Storage {
  private readonly entries = new Map<string, string>();

  get length(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }

  getItem(key: string): string | null {
    return this.entries.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.entries.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.entries.delete(key);
  }

  setItem(key: string, value: string): void {
    this.entries.set(key, String(value));
  }
}

if (typeof globalThis.localStorage === "undefined") {
  Object.defineProperty(globalThis, "localStorage", {
    value: new MemoryStorage(),
    configurable: true,
    writable: true,
  });
}

if (typeof globalThis.sessionStorage === "undefined") {
  Object.defineProperty(globalThis, "sessionStorage", {
    value: new MemoryStorage(),
    configurable: true,
    writable: true,
  });
}

if (typeof globalThis.addEventListener === "undefined") {
  Object.defineProperty(globalThis, "addEventListener", {
    value: vi.fn(),
    configurable: true,
    writable: true,
  });
}

if (typeof globalThis.removeEventListener === "undefined") {
  Object.defineProperty(globalThis, "removeEventListener", {
    value: vi.fn(),
    configurable: true,
    writable: true,
  });
}

if (typeof globalThis.dispatchEvent === "undefined") {
  Object.defineProperty(globalThis, "dispatchEvent", {
    value: vi.fn(() => true),
    configurable: true,
    writable: true,
  });
}

if (typeof globalThis.window === "undefined") {
  Object.defineProperty(globalThis, "window", {
    value: globalThis,
    configurable: true,
    writable: true,
  });
}

if (typeof globalThis.matchMedia === "undefined") {
  Object.defineProperty(globalThis, "matchMedia", {
    value: (query: string): MediaQueryList =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(() => false),
      }) as unknown as MediaQueryList,
    configurable: true,
    writable: true,
  });
}

// ============================================================================
// Inject fixtures immediately at module load (before any tests import modules)
// ============================================================================

_setBuiltinSimulatorMap(BUILTIN_SIMULATOR_APP_FIXTURE);
_setBuiltinIconIdMap(BUILTIN_ICON_ID_FIXTURE);
_setBuiltinAppSubtoolMap(BUILTIN_SUBTOOL_FIXTURE);
_setBuiltinLabelsMap(BUILTIN_LABELS_FIXTURE);
_setBuiltinActionsMap(BUILTIN_ACTIONS_FIXTURE);
_setBuiltinActionIconsMap(BUILTIN_ACTION_ICONS_FIXTURE);
_setCliToolAliasMap(CLI_ALIAS_MAP_FIXTURE);

if (!i18next.isInitialized) {
  i18next.init({
    lng: "en",
    fallbackLng: "en",
    ns: ["sessions"],
    defaultNS: "sessions",
    resources: {
      en: {
        sessions: enSessions,
      },
    },
    interpolation: { escapeValue: false },
  });
}
