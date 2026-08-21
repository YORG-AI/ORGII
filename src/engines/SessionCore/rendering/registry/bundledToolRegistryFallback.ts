/**
 * Static tool-registry fallback for browser hosts where `init_tool_registry`
 * Tauri IPC is unavailable. Mirrors the Rust source of truth used in tests.
 */
import { AppType } from "@src/engines/Simulator/types/appTypes";

import {
  _setBuiltinAppSubtoolMap,
  _setBuiltinSimulatorMap,
  _setCliToolAliasMap,
} from "./initToolRegistry";
import type { AliasEntry, AppSubtool } from "./types";

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

const BUILTIN_SUBTOOL: Map<string, AppSubtool> = new Map([
  ["read_file", "file_read"],
  ["list_dir", "explore"],
  ["run_shell", "shell"],
  ["await_output", "shell"],
  ["inspect_terminals", "shell"],
  ["code_search", "explore"],
  ["manage_workspace", "explore"],
  ["edit_file", "file_write"],
  ["delete_file", "file_write"],
  ["edit_file_by_replace", "file_write"],
  ["create_file", "file_write"],
  ["write_file", "file_write"],
  ["query_lsp", "explore"],
  ["glob_file_search", "glob"],
  ["web_search", "browser"],
  ["web_fetch", "browser"],
  ["agent_message", "message"],
  ["thinking", "thinking"],
]);

const BUILTIN_SIMULATOR: Map<string, AppType> = new Map([
  ["read_file", AppType.CODE_EDITOR],
  ["list_dir", AppType.CODE_EDITOR],
  ["run_shell", AppType.CODE_EDITOR],
  ["await_output", AppType.CODE_EDITOR],
  ["inspect_terminals", AppType.CODE_EDITOR],
  ["code_search", AppType.CODE_EDITOR],
  ["manage_workspace", AppType.CODE_EDITOR],
  ["edit_file", AppType.CODE_EDITOR],
  ["delete_file", AppType.CODE_EDITOR],
  ["edit_file_by_replace", AppType.CODE_EDITOR],
  ["create_file", AppType.CODE_EDITOR],
  ["write_file", AppType.CODE_EDITOR],
  ["query_lsp", AppType.CODE_EDITOR],
  ["glob_file_search", AppType.CODE_EDITOR],
  ["web_search", AppType.BROWSER],
  ["web_fetch", AppType.BROWSER],
]);

const CLI_ALIASES: Map<string, AliasEntry> = new Map([
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
]);

/** Populate registry maps when Rust IPC is unavailable (ORG2 Web). */
export function applyBundledToolRegistryFallback(): void {
  _setBuiltinSimulatorMap(BUILTIN_SIMULATOR);
  _setBuiltinAppSubtoolMap(BUILTIN_SUBTOOL);
  _setCliToolAliasMap(CLI_ALIASES);
}
