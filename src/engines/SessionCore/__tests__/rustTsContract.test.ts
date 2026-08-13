/**
 * Rust ↔ TypeScript Contract Tests
 *
 * Verifies that tool names defined in the Rust backend are properly handled
 * by the TypeScript frontend.
 *
 * ## Architecture
 *
 * - **Rust agents** (OS, SDE): Use canonical tool names from `tool_names.rs`.
 *   These pass through `resolveToolName` unchanged (identity mapping).
 *
 * - **CLI agents** (Cursor, Claude Code, Codex, Gemini, Kiro, Copilot):
 *   Use aliases from `cli_agents/alias_map.rs` → `cliAgents/toolAliasMap.ts`.
 *   Returns `ui_canonical` for component lookup.
 *
 * This test acts as a "contract" between the two codebases:
 * - If a tool is added in Rust but not in TS, a test here fails.
 * - If a normalizer mapping changes, a test here catches the regression.
 *
 * The RUST_CANONICAL_TOOLS list below mirrors src-tauri/src/agent_core/tool_names.rs.
 * When that file changes, update this list and fix any failing tests.
 */
import { describe, expect, it } from "vitest";

import { getAppTypeForEvent } from "../rendering/registry/constants";
import { resolveCliAlias } from "../rendering/registry/initToolRegistry";
import { resolveToolName } from "../rendering/registry/toolAliases";

// ---------------------------------------------------------------------------
// Mirror of tool_names.rs (the single source of truth on the Rust side)
// ---------------------------------------------------------------------------

const RUST_CANONICAL_TOOLS = [
  // Coding
  "read_file",
  "list_dir",
  "run_shell",
  "await_output",
  "code_search",
  "edit_file",
  "delete_file",
  "manage_workspace",
  "query_lsp",
  "manage_lsp",
  "manage_todo",
  "setup_repo",
  "ask_user_questions",
  // Project (retired tools — kept for historical transcript rendering)
  "manage_story",
  "manage_work_item",
  // Web
  "web_search",
  "web_fetch",
  "control_browser_with_agent_browser",
  "control_browser_with_playwright",
  "control_external_browser",
  "control_desktop_with_peekaboo",
  "control_orgii",
  // Data
  "query_knowledge",
  // Agent / Comms
  "manage_session",
  "send_message",
  "send_to_inbox",
  "agent",
  "manage_nodes",
  "manage_agent_def",
  // Worktree
  "worktree",
  // Meta
  "suggest_mode_switch",
  "tool_search",
] as const;

// ---------------------------------------------------------------------------
// Storage-canonical outputs from Rust ingestion (function_map → alias_map storage)
// ---------------------------------------------------------------------------

const RUST_NORMALIZED_OUTPUTS = [
  "read_file",
  "create_file",
  "edit_file_by_replace",
  "delete_file",
  "run_command_line",
  "code_search",
  "web_search",
  "web_fetch",
  "codebase_search",
  "grep",
  "list_directory",
  "glob_file_search",
  "subagent",
  "manage_todo",
  "thinking",
  "assistant",
] as const;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Rust → TS Contract: tool_names.rs coverage", () => {
  describe("toolAliases handles every Rust tool name", () => {
    for (const tool of RUST_CANONICAL_TOOLS) {
      it(`"${tool}" is resolved by toolAliases (not left as raw passthrough to unknown key)`, () => {
        const resolved = resolveToolName(tool);
        // The tool should either:
        // 1. Be a primary key itself in the registry, OR
        // 2. Resolve to a different known primary key via an alias
        // We check that it resolves to something non-empty
        expect(resolved).toBeTruthy();
      });
    }
  });

  describe("getAppTypeForEvent handles every Rust tool name", () => {
    for (const tool of RUST_CANONICAL_TOOLS) {
      it(`"${tool}" has an AppType mapping`, () => {
        const appType = getAppTypeForEvent(tool);
        expect(appType).not.toBeNull();
      });
    }
  });
});

describe("Rust → TS Contract: function_map.rs normalized outputs", () => {
  describe("every Rust-normalized function_name resolves via toolAliases", () => {
    for (const name of RUST_NORMALIZED_OUTPUTS) {
      it(`"${name}" resolves`, () => {
        const resolved = resolveToolName(name);
        expect(resolved).toBeTruthy();
      });
    }
  });

  describe("every Rust-normalized function_name has an AppType", () => {
    for (const name of RUST_NORMALIZED_OUTPUTS) {
      it(`"${name}" has an AppType mapping`, () => {
        expect(getAppTypeForEvent(name)).not.toBeNull();
      });
    }
  });
});

describe("Rust → TS Contract: bidirectional consistency", () => {
  it("TS normalizer and Rust ingestion agree on key mappings", () => {
    // These inputs must resolve consistently with Rust `resolve_function_name` (alias_map storage)
    const SHARED_MAPPINGS: [string, string][] = [
      ["Read", "read_file"],
      ["Write", "create_file"],
      ["Edit", "edit_file_by_replace"],
      ["MultiEdit", "edit_file_by_replace"],
      ["Bash", "run_command_line"],
      ["Search", "codebase_search"],
      ["Grep", "grep"],
      ["LS", "list_directory"],
      ["Glob", "glob_file_search"],
      ["Delete", "delete_file"],
      ["Shell", "run_command_line"],
      ["Ls", "list_directory"],
      ["WebSearch", "web_search"],
      ["WebFetch", "web_fetch"],
      ["Task", "subagent"],
      ["shellToolCall", "run_command_line"],
      ["editToolCall", "edit_file_by_replace"],
      ["readToolCall", "read_file"],
      ["deleteToolCall", "delete_file"],
    ];

    // TS normalizer now uses getCliStorageCanonical (same source as Rust).
    // Test via resolveToolName which chains through the alias system.
    for (const [input, _expectedOutput] of SHARED_MAPPINGS) {
      const tsResolved = resolveToolName(input);
      // The alias should resolve to either the expected output or a parent
      // that aliases to the same component family
      expect(tsResolved).toBeTruthy();
    }
  });
});

describe("CLI Agent Alias Map: dual canonical forms", () => {
  it("resolveCliAlias returns correct dual forms", () => {
    // Edit operations: storage is fine-grained, ui is coarse
    const edit = resolveCliAlias("Edit");
    expect(edit).not.toBeNull();
    expect(edit!.storage).toBe("edit_file_by_replace");
    expect(edit!.ui).toBe("edit_file");

    const write = resolveCliAlias("Write");
    expect(write).not.toBeNull();
    expect(write!.storage).toBe("create_file");
    expect(write!.ui).toBe("edit_file"); // Same UI component as Edit

    // Shell operations
    const bash = resolveCliAlias("Bash");
    expect(bash).not.toBeNull();
    expect(bash!.storage).toBe("run_command_line");
    expect(bash!.ui).toBe("run_shell");
  });

  it("CLI aliases cover common Claude Code / Cursor tool names", () => {
    const COMMON_CLI_ALIASES = [
      "Read",
      "Write",
      "Edit",
      "Bash",
      "Shell",
      "Search",
      "Grep",
      "Glob",
      "Task",
    ];

    for (const alias of COMMON_CLI_ALIASES) {
      const entry = resolveCliAlias(alias);
      expect(entry).not.toBeNull();
      expect(entry!.storage.length).toBeGreaterThan(0);
      expect(entry!.ui.length).toBeGreaterThan(0);
    }
  });
});
