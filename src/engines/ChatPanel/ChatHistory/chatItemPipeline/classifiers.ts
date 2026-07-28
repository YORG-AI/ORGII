/**
 * Chat Item Pipeline — Activity Classifiers
 *
 * Simple boolean identity checks: "is this event a browser action?", etc.
 * These are used by the main pipeline to decide which buffer an event goes into.
 *
 * Uses `event.uiCanonical` (pre-computed in Rust) for fast lookups.
 * Falls back to normalizeFunctionName() for events without uiCanonical.
 */
import { readAwaitMetaFromResult } from "@src/engines/ChatPanel/rendering/adapters/awaitMeta";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { isShellSearchCommand } from "@src/util/terminal/searchCommandParser";

const UI_CANONICAL_ALIASES: Readonly<Record<string, string>> = {
  read: "read_file",
  cat: "read_file",
  file_read: "read_file",
  list_directory: "list_dir",
  file_search: "glob_file_search",
  todowrite: "manage_todo",
  todo_write: "manage_todo",
  browser: "browser_navigate",
  browser_act: "browser_navigate",
};

function normalizeCanonical(value: string): string {
  const normalized = value.trim().toLowerCase();
  return UI_CANONICAL_ALIASES[normalized] ?? normalized;
}

/**
 * Get UI canonical name from a SessionEvent.
 * Prefers pre-computed uiCanonical, falls back to runtime normalization.
 */
function getUiCanonical(event: SessionEvent): string {
  if (event.uiCanonical) return event.uiCanonical;
  return normalizeCanonical(event.functionName || event.actionType || "");
}

// ============================================
// Action Summary Categories
// ============================================

export type ActionSummaryCategory = "read" | "search" | "list" | "glob" | "lsp";

const SUMMARY_CATEGORY_BY_CANONICAL: Readonly<
  Record<string, ActionSummaryCategory>
> = {
  read_file: "read",
  code_search: "search",
  search_in_file: "search",
  glob_file_search: "glob",
  list_dir: "list",
  query_lsp: "lsp",
};

/**
 * A `run_shell` event whose command is really a code search — a pure grep/rg
 * pipeline (`grep -rn "foo" src | head`). These render as search rows
 * (ShellAdapter → SearchBlock) and group with explorations, not terminals.
 */
export function isShellSearchCommandEvent(event: SessionEvent): boolean {
  if (getUiCanonical(event) !== "run_shell") return false;
  const extracted = event.extracted?.kind === "shell" ? event.extracted : null;
  const command =
    extracted?.command ??
    event.command ??
    (typeof event.args?.command === "string" ? event.args.command : "");
  return isShellSearchCommand(command);
}

/**
 * Classify an event into an action summary category.
 * Returns null if the event is not an exploration/lookup action.
 */
export function getActionSummaryCategory(
  event: SessionEvent
): ActionSummaryCategory | null {
  const category = SUMMARY_CATEGORY_BY_CANONICAL[getUiCanonical(event)] ?? null;
  if (category) return category;
  if (isShellSearchCommandEvent(event)) return "search";
  return null;
}

/**
 * Check if an event is a read file action.
 */
export const isReadFileEvent = (event: SessionEvent): boolean => {
  return getUiCanonical(event) === "read_file";
};

/** Check if an event is a file edit/create/patch operation. */
export const isEditFileEvent = (event: SessionEvent): boolean => {
  return getUiCanonical(event) === "edit_file";
};

/** Check if an event deletes a file. */
export const isDeleteFileEvent = (event: SessionEvent): boolean => {
  return getUiCanonical(event) === "delete_file";
};

/** Check if an event modifies the workspace file set or file contents. */
export const isFileModificationEvent = (event: SessionEvent): boolean => {
  return isEditFileEvent(event) || isDeleteFileEvent(event);
};

const SIMULATOR_APP_BY_CANONICAL: Readonly<Record<string, string>> = {
  read_file: "CODE_EDITOR",
  edit_file: "CODE_EDITOR",
  edit_file_by_replace: "CODE_EDITOR",
  delete_file: "CODE_EDITOR",
  apply_patch: "CODE_EDITOR",
  manage_todo: "CHANNELS",
  control_browser_with_agent_browser: "BROWSER",
  control_browser_with_playwright: "BROWSER",
  control_external_browser: "BROWSER",
  control_internal_browser: "BROWSER",
  browser_navigate: "BROWSER",
  browser_act: "BROWSER",
};

/** Serializable simulator classification shared by main-thread and Worker paths. */
export function getToolSimulatorApp(
  rawName: string,
  normalizedName?: string
): string | null {
  const canonical = normalizeCanonical(normalizedName ?? rawName);
  return SIMULATOR_APP_BY_CANONICAL[canonical] ?? null;
}

export function isEventInSimulatorApp(
  event: SessionEvent,
  appType: string
): boolean {
  return (
    getToolSimulatorApp(event.functionName, getUiCanonical(event)) === appType
  );
}

const BROWSER_CANONICALS = new Set([
  "control_browser_with_agent_browser",
  "control_browser_with_playwright",
  "control_external_browser",
  "control_internal_browser",
]);

/**
 * Check if an event is a browser tool call.
 */
export const isBrowserEvent = (event: SessionEvent): boolean => {
  const isToolCallAction =
    event.actionType === "tool_call" ||
    event.actionType === "tool_call_start" ||
    event.actionType === "tool_call_update";

  const canonical = getUiCanonical(event);
  return (
    isToolCallAction &&
    (BROWSER_CANONICALS.has(canonical) ||
      getToolSimulatorApp(event.functionName, canonical) === "BROWSER")
  );
};

/**
 * Check whether an await_output call targets at least one shell process.
 * Structured awaitMeta wins; live calls fall back to their numeric PID handles.
 */
function isShellAwaitEvent(event: SessionEvent): boolean {
  const meta = readAwaitMetaFromResult(event.result);
  const metaKinds = [
    ...(meta?.items?.map((item) => item.jobKind) ?? []),
    ...(meta?.listItems?.map((item) => item.kind) ?? []),
  ];
  if (metaKinds.length > 0) return metaKinds.includes("shell");

  const rawHandles = event.args?.handles;
  const handles = Array.isArray(rawHandles)
    ? rawHandles
    : [
        event.args?.handle,
        event.args?.pid,
        event.extracted?.kind === "await" ? event.extracted.handle : undefined,
      ];
  const presentHandles = handles.filter(
    (handle): handle is string | number =>
      typeof handle === "string" || typeof handle === "number"
  );
  if (presentHandles.length > 0) {
    return presentHandles.some((handle) => /^\d+$/.test(String(handle)));
  }

  // `list` has no target handles. It belongs to the terminal stack unless its
  // structured result explicitly says it only contains non-shell jobs.
  return event.args?.command === "list" || meta == null;
}

/**
 * Check if an event should participate in a consecutive Terminal stack:
 * shell commands, shell-oriented waits/monitors/lists, and terminal
 * inspection operations. A `run_shell` kill row remains standalone.
 */
export const isTerminalActivityEvent = (event: SessionEvent): boolean => {
  const canonical = getUiCanonical(event);
  if (canonical === "await_output") return isShellAwaitEvent(event);
  if (canonical === "inspect_terminals") return true;
  return isTerminalCommandEvent(event);
};

/**
 * MCP tool calls arrive in several wire shapes across agent providers:
 * - canonical `mcp_tool` events;
 * - Rust bridge names (`mcp__server__tool`, `mcp_server_tool`);
 * - provider namespaces (`codex_app__read_thread_terminal`);
 * - legacy events carrying an explicit `args.server` field.
 */
export const isMcpToolEvent = (event: SessionEvent): boolean => {
  const functionName = event.functionName.toLowerCase();
  return (
    getUiCanonical(event) === "mcp_tool" ||
    functionName.startsWith("mcp_") ||
    functionName.includes("__") ||
    typeof event.args?.server === "string"
  );
};

/** Activity that belongs in the collapsible command/MCP stack. */
export const isCommandGroupActivityEvent = (event: SessionEvent): boolean => {
  return isTerminalActivityEvent(event) || isMcpToolEvent(event);
};

/** A shell command that can anchor a Terminal activity group. */
export const isTerminalCommandEvent = (event: SessionEvent): boolean => {
  if (getUiCanonical(event) !== "run_shell") return false;
  // Grep/rg pipelines belong to the exploration summary, not terminal stacks.
  if (isShellSearchCommandEvent(event)) return false;

  const extracted = event.extracted?.kind === "shell" ? event.extracted : null;
  const action = extracted?.action ?? event.args?.action;
  const killHandle = extracted?.killHandle ?? event.args?.kill_handle;
  return (
    (typeof action !== "string" || action.toLowerCase() !== "kill") &&
    !killHandle
  );
};

/**
 * Check if an event is a manage_todo event.
 */
export const isManageTodoEvent = (event: SessionEvent): boolean => {
  return getUiCanonical(event) === "manage_todo";
};

/**
 * Terminal agent-error event (quota exhausted, rate limited, auth failure,
 * stream retry budget exhausted, …).
 *
 * SINGLE SOURCE OF TRUTH for "is this event an error card". Matches the
 * shape stamped by both producers:
 * - Rust `lifecycle::build_session_error_event` (id `session-error-…`)
 * - FE `makeErrorEvent` in sync/adapters/shared/eventFactories.ts
 *
 * Mirrors Claude Code's `isApiErrorMessage` contract: every render,
 * filter, and collapse path must treat these as always-visible — a
 * failed turn whose error card is dropped renders as blank space
 * (the 2026-06-10 quota-error bug). Consumers: ActivityRouter (renders
 * AgentErrorChatItem), useChatGroups (collapse survivor set).
 */
export const isAgentErrorEvent = (event: SessionEvent): boolean => {
  return (
    event.functionName === "system" &&
    event.displayStatus === "failed" &&
    event.displayVariant === "message"
  );
};
