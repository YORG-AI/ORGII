/**
 * Unified Tool Registry Initialization
 *
 * Single IPC call to initialize all tool registry data:
 * - Built-in tool info (icon IDs, simulator apps, subtools)
 * - CLI alias map (alias → storage, ui, simulatorApp, subtool)
 *
 * This replaces separate calls to `initBuiltinSimulatorMap()` and `initCliToolAliasMap()`.
 *
 * NOTE: No static fallback in production. Tests inject fixtures via vitest.setup.ts.
 */
import type { AppType } from "@src/engines/Simulator/types/appTypes";
import { createLogger } from "@src/hooks/logger";
import { invokeTauri } from "@src/util/platform/tauri/init";

import { configureToolClassifierRegistry } from "./toolClassifierRegistry";
// Types from types.ts (source of truth for AppSubtool / ChatBlock)
import {
  type AliasEntry,
  type AppSubtool,
  type ChatBlock,
  TOOL_DISPLAY_BEHAVIOR,
  type ToolDisplayBehavior,
} from "./types";

// Re-export types
export type {
  AliasEntry,
  AppSubtool,
  ChatBlock,
  ToolDisplayBehavior,
} from "./types";

const log = createLogger("initToolRegistry");

// ============================================
// Response types (match Rust ToolRegistryData)
// ============================================

/** Structured action metadata from Rust ToolAction (per-action overrides). */
export interface ToolActionInfo {
  name: string;
  summary: string;
  /** Per-action AppSubtool override. Absent → inherit tool-level. */
  appSubtool?: AppSubtool;
  /** Per-action ChatBlock override. Absent → inherit tool-level. */
  chatBlock?: ChatBlock;
  /** Per-action display behavior override. Absent → inherit tool-level. */
  displayBehavior?: ToolDisplayBehavior;
  labelRunning: string;
  labelDone: string;
  labelFailed: string;
  /** Per-action extra state → i18n key map. */
  statusLabels?: Record<string, string>;
}

/** Tool info row from Rust (subset of ToolInfo). */
interface RustToolInfoRow {
  name: string;
  icon_id: string;
  actionIcons?: Record<string, string>;
  statusIcons?: Record<string, string>;
  statusLabels?: Record<string, string>;
  simulatorApp?: string;
  appSubtool?: AppSubtool;
  chatBlock?: ChatBlock;
  displayBehavior?: ToolDisplayBehavior;
  labelRunning?: string;
  labelDone?: string;
  labelFailed?: string;
  actions?: ToolActionInfo[];
}

/** Response from `init_tool_registry` Tauri command. */
interface ToolRegistryData {
  tools: RustToolInfoRow[];
  cli_aliases: Record<string, [string, string, string, string, string]>;
}

// ============================================
// Module-level caches
// ============================================

/** name → AppType (from tools.simulatorApp). */
let builtinSimulatorAppMap: Map<string, AppType> | null = null;

/** name → icon_id. */
let builtinIconIdMap: Map<string, string> | null = null;

/** name → (action → icon_id). */
let builtinActionIconsMap: Map<string, Map<string, string>> | null = null;

/** name → (status → icon_id). */
let builtinStatusIconsMap: Map<string, Map<string, string>> | null = null;

/** name → AppSubtool. */
let builtinAppSubtoolMap: Map<string, AppSubtool> | null = null;

const BASELINE_CHAT_BLOCKS = new Map<string, ChatBlock>([
  ["read_file", "read_file"],
  ["edit_file", "diff"],
  ["edit_file_by_replace", "diff"],
  ["delete_file", "diff"],
  ["apply_patch", "diff"],
  ["list_dir", "explore"],
  ["tool_search", "explore"],
  ["run_shell", "shell"],
  ["run_command_line", "shell"],
  ["await_output", "title_only"],
  ["inspect_terminals", "explore"],
  ["code_search", "search"],
  ["glob_file_search", "glob"],
  ["web_search", "web_search"],
  ["manage_todo", "todo"],
  ["task_create", "org_task"],
  ["task_update", "org_task"],
  ["task_list", "org_task"],
  ["task_get", "org_task"],
  ["org_send_message", "sent_message"],
  ["send_message", "sent_message"],
  ["send_to_inbox", "sent_message"],
  ["subagent", "subagent"],
  ["plan_approval", "plan_doc"],
]);

/** name → ChatBlock. */
let builtinChatBlockMap: Map<string, ChatBlock> | null = new Map(
  BASELINE_CHAT_BLOCKS
);

/** name → Agent Station display behavior. */
let builtinDisplayBehaviorMap: Map<string, ToolDisplayBehavior> | null = null;

/** name → ToolActionInfo[] (layout recipes from Rust). */
let builtinActionsMap: Map<string, ToolActionInfo[]> | null = null;

/** name → tool-level i18n label keys (running/done/failed). */
let builtinLabelsMap: Map<
  string,
  { running: string; done: string; failed: string }
> | null = null;

/** name → tool-level extra status → i18n key map. */
let builtinStatusLabelsMap: Map<string, Map<string, string>> | null = null;

/** alias → AliasEntry. */
let cliAliasMap: Map<string, AliasEntry> | null = null;

/** Whether initialization has been attempted. */
let initAttempted = false;

function publishToolClassifierRegistry(): void {
  const uiCanonicalByName: Record<string, string> = {};
  const simulatorAppByName: Record<string, string> = {};

  for (const [name, simulatorApp] of builtinSimulatorAppMap ?? []) {
    simulatorAppByName[name] = simulatorApp;
  }
  for (const [name, entry] of cliAliasMap ?? []) {
    uiCanonicalByName[name] = entry.ui;
    simulatorAppByName[name] = entry.simulatorApp;
    simulatorAppByName[entry.ui] ??= entry.simulatorApp;
  }

  configureToolClassifierRegistry({
    uiCanonicalByName,
    simulatorAppByName,
  });
}

// ============================================
// Initialization
// ============================================

/**
 * Initialize the tool registry from Rust via single IPC call.
 * Safe to call multiple times; only fetches once.
 */
export async function initToolRegistry(): Promise<void> {
  if (initAttempted) return;
  initAttempted = true;

  try {
    const data = await invokeTauri<ToolRegistryData>("init_tool_registry");

    // Populate builtin maps from tools array
    builtinSimulatorAppMap = new Map();
    builtinIconIdMap = new Map();
    builtinActionIconsMap = new Map();
    builtinStatusIconsMap = new Map();
    builtinAppSubtoolMap = new Map();
    builtinChatBlockMap = new Map(BASELINE_CHAT_BLOCKS);
    builtinDisplayBehaviorMap = new Map();
    builtinActionsMap = new Map();
    builtinLabelsMap = new Map();
    builtinStatusLabelsMap = new Map();

    for (const tool of data.tools) {
      if (tool.simulatorApp) {
        builtinSimulatorAppMap.set(tool.name, tool.simulatorApp as AppType);
      }
      if (tool.icon_id) {
        builtinIconIdMap.set(tool.name, tool.icon_id);
      }
      if (tool.actionIcons && Object.keys(tool.actionIcons).length > 0) {
        builtinActionIconsMap.set(
          tool.name,
          new Map(Object.entries(tool.actionIcons))
        );
      }
      if (tool.statusIcons && Object.keys(tool.statusIcons).length > 0) {
        builtinStatusIconsMap.set(
          tool.name,
          new Map(Object.entries(tool.statusIcons))
        );
      }
      if (tool.appSubtool) {
        builtinAppSubtoolMap.set(tool.name, tool.appSubtool);
      }
      if (tool.chatBlock) {
        builtinChatBlockMap.set(tool.name, tool.chatBlock);
      }
      if (tool.displayBehavior) {
        builtinDisplayBehaviorMap.set(tool.name, tool.displayBehavior);
      }
      if (tool.actions && tool.actions.length > 0) {
        builtinActionsMap.set(tool.name, tool.actions);
      }
      const running = tool.labelRunning ?? "";
      const done = tool.labelDone ?? "";
      const failed = tool.labelFailed ?? "";
      if (running || done || failed) {
        builtinLabelsMap.set(tool.name, { running, done, failed });
      }
      if (tool.statusLabels && Object.keys(tool.statusLabels).length > 0) {
        builtinStatusLabelsMap.set(
          tool.name,
          new Map(Object.entries(tool.statusLabels))
        );
      }
    }

    // Populate CLI alias map
    cliAliasMap = new Map(
      Object.entries(data.cli_aliases).map(
        ([alias, [storage, ui, simulatorApp, appSubtool, chatBlock]]) => [
          alias,
          {
            storage,
            ui,
            simulatorApp,
            appSubtool: appSubtool as AppSubtool,
            chatBlock: chatBlock as ChatBlock,
          },
        ]
      )
    );
    publishToolClassifierRegistry();
  } catch (err) {
    log.error("[initToolRegistry] Failed to fetch from Rust:", err);
    builtinSimulatorAppMap = new Map();
    builtinIconIdMap = new Map();
    builtinActionIconsMap = new Map();
    builtinStatusIconsMap = new Map();
    builtinAppSubtoolMap = new Map();
    builtinChatBlockMap = new Map(BASELINE_CHAT_BLOCKS);
    builtinDisplayBehaviorMap = new Map();
    builtinActionsMap = new Map();
    builtinLabelsMap = new Map();
    builtinStatusLabelsMap = new Map();
    cliAliasMap = new Map();
    publishToolClassifierRegistry();
  }
}

// ============================================
// Builtin tool getters
// ============================================

/** Get simulator app for a built-in tool. */
export function getBuiltinSimulatorApp(toolName: string): AppType | null {
  return builtinSimulatorAppMap?.get(toolName) ?? null;
}

/** Get icon ID for a built-in tool. */
export function getBuiltinToolIconId(toolName: string): string | null {
  const iconId = builtinIconIdMap?.get(toolName);
  return iconId && iconId.length > 0 ? iconId : null;
}

/** Get action-specific icon ID for a built-in tool. */
export function getBuiltinToolActionIconId(
  toolName: string,
  action: string
): string | null {
  const actionMap = builtinActionIconsMap?.get(toolName);
  if (!actionMap) return null;
  const iconId = actionMap.get(action);
  return iconId && iconId.length > 0 ? iconId : null;
}

/** Get status-dependent icon ID for a built-in tool/event. */
export function getBuiltinToolStatusIconId(
  toolName: string,
  status: string
): string | null {
  const statusMap = builtinStatusIconsMap?.get(toolName);
  if (!statusMap) return null;
  const iconId = statusMap.get(status);
  return iconId && iconId.length > 0 ? iconId : null;
}

/** Get appSubtool for a built-in tool. */
function getBuiltinAppSubtool(toolName: string): AppSubtool | null {
  return builtinAppSubtoolMap?.get(toolName) ?? null;
}

/** Get chatBlock for a built-in tool. */
function getBuiltinChatBlock(toolName: string): ChatBlock | null {
  return builtinChatBlockMap?.get(toolName) ?? null;
}

/** Get Agent Station display behavior for a built-in tool. */
function getBuiltinDisplayBehavior(
  toolName: string
): ToolDisplayBehavior | null {
  return builtinDisplayBehaviorMap?.get(toolName) ?? null;
}

/** Get all structured actions for a built-in tool. */
export function getToolActions(toolName: string): ToolActionInfo[] {
  const uiCanonical = getCliUiCanonical(toolName);
  return (
    builtinActionsMap?.get(toolName) ??
    builtinActionsMap?.get(uiCanonical) ??
    []
  );
}

/**
 * Resolve the effective ChatBlock for a tool + action combination.
 * Per-action override takes precedence, then tool-level default.
 * Returns `null` when nothing is declared so callers can default to
 * `"fallback"` (the ToolCallBlock).
 */
export function getActionChatBlock(
  toolName: string,
  actionName?: string
): ChatBlock | null {
  const uiCanonical = getCliUiCanonical(toolName);
  const actions = getToolActions(uiCanonical);

  if (actionName && actions.length > 0) {
    const match = actions.find((act) => act.name === actionName);
    if (match?.chatBlock) return match.chatBlock;
  }

  return getChatBlock(uiCanonical);
}

export function getToolDisplayBehavior(
  toolName: string,
  actionName?: string
): ToolDisplayBehavior {
  const uiCanonical = getCliUiCanonical(toolName);
  const actions = getToolActions(uiCanonical);

  if (actionName && actions.length > 0) {
    const match = actions.find((act) => act.name === actionName);
    if (match?.displayBehavior) return match.displayBehavior;
  }

  return (
    getBuiltinDisplayBehavior(toolName) ??
    getBuiltinDisplayBehavior(uiCanonical) ??
    TOOL_DISPLAY_BEHAVIOR.WAIT_FOR_RESULT
  );
}

/**
 * Resolve the i18n label keys for a tool invocation's running/done/failed
 * states. When `actionName` matches a declared action with non-empty labels
 * those take precedence; otherwise we fall back to the tool-level defaults.
 *
 * Returns `null` when neither the action nor the tool has any labels set so
 * callers can apply their own derived fallback.
 */
export function getActionLabels(
  toolName: string,
  actionName?: string
): { running: string; done: string; failed: string } | null {
  const uiCanonical = getCliUiCanonical(toolName);

  if (actionName) {
    const actions =
      builtinActionsMap?.get(toolName) ??
      builtinActionsMap?.get(uiCanonical) ??
      null;
    if (actions) {
      const match = actions.find((act) => act.name === actionName);
      if (
        match &&
        (match.labelRunning || match.labelDone || match.labelFailed)
      ) {
        return {
          running: match.labelRunning,
          done: match.labelDone,
          failed: match.labelFailed,
        };
      }
    }
  }

  const toolLabels =
    builtinLabelsMap?.get(toolName) ?? builtinLabelsMap?.get(uiCanonical);
  if (toolLabels) return toolLabels;

  return null;
}

/**
 * Resolve the i18n key for a specific tool/action/state combination.
 *
 * State names follow the event pipeline plus block-specific extensions:
 *   - "running", "done", "failed" — always honored via `getActionLabels`
 *   - "success" — alias for "done"
 *   - any other string — looked up in `statusLabels` (action-level first,
 *     then tool-level), mirroring the `status_icons` design
 *
 * Returns `null` when no label is registered for that state, letting
 * callers fall back to a shared `common:status.*` key or hide the row.
 */
export function getToolLabel(
  toolName: string,
  state: string,
  actionName?: string
): string | null {
  const uiCanonical = getCliUiCanonical(toolName);

  if (
    state === "running" ||
    state === "done" ||
    state === "failed" ||
    state === "success"
  ) {
    const labels = getActionLabels(toolName, actionName);
    if (!labels) return null;
    if (state === "running") return labels.running || null;
    if (state === "failed") return labels.failed || null;
    return labels.done || null;
  }

  if (actionName) {
    const actions =
      builtinActionsMap?.get(toolName) ??
      builtinActionsMap?.get(uiCanonical) ??
      null;
    if (actions) {
      const match = actions.find((act) => act.name === actionName);
      const hit = match?.statusLabels?.[state];
      if (hit) return hit;
    }
  }

  const toolStatusLabels =
    builtinStatusLabelsMap?.get(toolName) ??
    builtinStatusLabelsMap?.get(uiCanonical);
  return toolStatusLabels?.get(state) ?? null;
}

// ============================================
// CLI alias getters
// ============================================

/** Resolve a CLI alias to its full entry. */
export function resolveCliAlias(rawName: string): AliasEntry | null {
  return cliAliasMap?.get(rawName) ?? null;
}

/** Get UI canonical name for a CLI alias.
 *
 * MCP-routed built-in tool calls arrive with an "mcp_orgii_" prefix
 * (e.g. "mcp_orgii_suggest_mode_switch"). Strip it before alias lookup so
 * the rendering registry, component loaders, and visibility filters all
 * treat MCP-prefixed calls identically to their canonical counterparts.
 */
export function getCliUiCanonical(rawName: string): string {
  const stripped = rawName.startsWith("mcp_orgii_")
    ? rawName.slice("mcp_orgii_".length)
    : rawName;
  const entry = resolveCliAlias(stripped);
  return entry?.ui ?? stripped;
}

/** Get storage canonical name for a CLI alias. */
export function getCliStorageCanonical(rawName: string): string {
  const entry = resolveCliAlias(rawName);
  return entry?.storage ?? rawName;
}

/** Get simulator app for a CLI alias. */
export function getCliSimulatorApp(rawName: string): string | null {
  const entry = resolveCliAlias(rawName);
  return entry?.simulatorApp ?? null;
}

/** Get appSubtool for a CLI alias. */
function getCliAppSubtool(rawName: string): AppSubtool | null {
  const entry = resolveCliAlias(rawName);
  return entry?.appSubtool ?? null;
}

/** Get chatBlock for a CLI alias. */
function getCliChatBlock(rawName: string): ChatBlock | null {
  const entry = resolveCliAlias(rawName);
  return entry?.chatBlock ?? null;
}

/** Get all known CLI alias keys. */
export function getAllCliAliasKeys(): string[] {
  if (!cliAliasMap) return [];
  return Array.from(cliAliasMap.keys());
}

// ============================================
// Unified getters (check CLI first, then builtin)
// ============================================

/**
 * Get AppType for any tool/function name.
 * Checks builtin map first (Rust canonical names), then CLI alias map.
 *
 * Builtin tools take priority because CLI alias map may contain entries for
 * Rust agent tools that have different simulator app mappings for CLI agents.
 */
export function getAppTypeForTool(functionName?: string): string | null {
  if (!functionName) return null;

  // 1. Builtin → simulatorApp (Rust canonical names take priority)
  const builtinApp = getBuiltinSimulatorApp(functionName);
  if (builtinApp) return builtinApp;

  // 2. CLI alias → simulatorApp (for CLI agent-specific tool names)
  const cliApp = getCliSimulatorApp(functionName);
  if (cliApp) return cliApp;

  return null;
}

/**
 * Get AppSubtool for any tool/function name.
 * Checks builtin map first (Rust canonical names), then CLI alias map.
 */
export function getAppSubtool(functionName?: string): AppSubtool | null {
  if (!functionName) return null;

  // 1. Builtin → appSubtool (Rust canonical names take priority)
  const builtinSubtool = getBuiltinAppSubtool(functionName);
  if (builtinSubtool) return builtinSubtool;

  // 2. CLI alias → appSubtool (for CLI agent-specific tool names)
  const cliSubtool = getCliAppSubtool(functionName);
  if (cliSubtool) return cliSubtool;

  return null;
}

/**
 * Get ChatBlock for any tool/function name.
 * Checks builtin map first (Rust canonical names), then CLI alias map.
 * Returns `null` when the tool is unknown so callers can fall back to
 * `"fallback"` (the generic ToolCallBlock).
 */
function getChatBlock(functionName?: string): ChatBlock | null {
  if (!functionName) return null;

  const builtin = getBuiltinChatBlock(functionName);
  if (builtin) return builtin;

  const cli = getCliChatBlock(functionName);
  if (cli) return cli;

  return null;
}

// ============================================
// Test utilities
// ============================================

/** @internal - for tests */
export function _resetToolRegistry(): void {
  builtinSimulatorAppMap = null;
  builtinIconIdMap = null;
  builtinActionIconsMap = null;
  builtinStatusIconsMap = null;
  builtinAppSubtoolMap = null;
  builtinChatBlockMap = null;
  builtinDisplayBehaviorMap = null;
  builtinActionsMap = null;
  builtinLabelsMap = null;
  builtinStatusLabelsMap = null;
  cliAliasMap = null;
  initAttempted = false;
  publishToolClassifierRegistry();
}

/** @internal - for tests: set builtin simulator app map. */
export function _setBuiltinSimulatorMap(map: Map<string, AppType>): void {
  builtinSimulatorAppMap = map;
  initAttempted = true;
  publishToolClassifierRegistry();
}

/** @internal - for tests: set builtin icon ID map. */
export function _setBuiltinIconIdMap(map: Map<string, string>): void {
  builtinIconIdMap = map;
}

/** @internal - for tests: set builtin appSubtool map. */
export function _setBuiltinAppSubtoolMap(map: Map<string, AppSubtool>): void {
  builtinAppSubtoolMap = map;
}

/** @internal - for tests: set builtin chatBlock map. */
export function _setBuiltinChatBlockMap(map: Map<string, ChatBlock>): void {
  builtinChatBlockMap = map;
}

/** @internal - for tests: set builtin tool labels. */
export function _setBuiltinLabelsMap(
  map: Map<string, { running: string; done: string; failed: string }>
): void {
  builtinLabelsMap = map;
}

/** @internal - for tests: set builtin action metadata. */
export function _setBuiltinActionsMap(
  map: Map<string, ToolActionInfo[]>
): void {
  builtinActionsMap = map;
}

/** @internal - for tests: set builtin display behavior metadata. */
export function _setBuiltinDisplayBehaviorMap(
  map: Map<string, ToolDisplayBehavior>
): void {
  builtinDisplayBehaviorMap = map;
}

/** @internal - for tests: set builtin action → icon_id metadata. */
export function _setBuiltinActionIconsMap(
  map: Map<string, Map<string, string>>
): void {
  builtinActionIconsMap = map;
}

/** @internal - for tests: set CLI alias map. */
export function _setCliToolAliasMap(map: Map<string, AliasEntry>): void {
  cliAliasMap = map;
  initAttempted = true;
  publishToolClassifierRegistry();
}
