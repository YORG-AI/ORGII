/**
 * Registry Completeness Tests
 *
 * Ensures every known tool name from the Rust backend resolves to a registry
 * entry and has a consistent `getAppTypeForEvent` mapping.
 *
 * ## Architecture (Post-Consolidation)
 *
 * - **Rust agent tools** (OS, SDE): Use canonical names from `tool_names.rs`.
 *   These pass through `resolveToolName()` unchanged (identity mapping).
 *
 * - **CLI agent aliases** (Cursor, Claude Code, etc.): Resolve via
 *   `cli_agents/alias_map.rs` → `cliAgents/toolAliasMap.ts`.
 *   Returns `ui_canonical` for component lookup.
 *
 * When a new tool is added in Rust (tool_names.rs), a test here will fail
 * until the frontend handles it properly.
 */
import { describe, expect, it } from "vitest";

import { getAppTypeForEvent } from "../rendering/registry/constants";
import { resolveToolName } from "../rendering/registry/toolAliases";

// ---------------------------------------------------------------------------
// Canonical tool names from src-tauri/src/agent_core/tool_names.rs
// ---------------------------------------------------------------------------

const RUST_TOOL_NAMES = {
  coding: [
    "read_file",
    "list_dir",
    "run_shell",
    "await_output",
    "inspect_terminals",
    "code_search",
    "edit_file",
    "delete_file",
    "manage_workspace",
    "query_lsp",
    "manage_lsp",
    "manage_todo",
    "setup_repo",
    "ask_user_questions",
  ],
  project: ["manage_story", "manage_work_item"],
  web: [
    "web_search",
    "web_fetch",
    "control_browser_with_agent_browser",
    "control_browser_with_playwright",
    "control_external_browser",
    "control_desktop_with_peekaboo",
    "control_orgii",
  ],
  data: ["query_knowledge"],
  agent: [
    "manage_session",
    "send_message",
    "send_to_inbox",
    "agent",
    "manage_nodes",
    "manage_agent_def",
  ],
  meta: ["suggest_mode_switch", "worktree", "tool_search"],
} as const;

const ALL_RUST_TOOLS = Object.values(RUST_TOOL_NAMES).flat();

// SDE-only tools not in tool_names.rs but used as function_names
const SDE_EXTRA_TOOLS = ["task", "spawn_sub_agent"] as const;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Registry Completeness", () => {
  describe("Every Rust tool_names.rs entry resolves via resolveToolName", () => {
    for (const tool of ALL_RUST_TOOLS) {
      it(`"${tool}" resolves to a valid string`, () => {
        const resolved = resolveToolName(tool);
        // Rust canonical names should pass through unchanged
        // (they are in STATIC_BUILTIN_SIMULATOR_APP)
        expect(typeof resolved).toBe("string");
        expect(resolved.length).toBeGreaterThan(0);
      });
    }
  });

  describe("Every Rust tool_names.rs entry maps via getAppTypeForEvent", () => {
    for (const tool of ALL_RUST_TOOLS) {
      it(`"${tool}" maps to an AppType`, () => {
        const appType = getAppTypeForEvent(tool);
        expect(appType).not.toBeNull();
        expect([
          "CODE_EDITOR",
          "BROWSER",
          "CHANNELS",
          "STORY_MANAGER",
        ]).toContain(appType);
      });
    }
  });

  describe("SDE extra tools resolve via resolveToolName", () => {
    for (const tool of SDE_EXTRA_TOOLS) {
      it(`"${tool}" resolves`, () => {
        const resolved = resolveToolName(tool);
        expect(resolved.length).toBeGreaterThan(0);
      });
    }
  });

  describe("CLI aliases resolve to ui_canonical for component lookup", () => {
    // Test that CLI aliases (from Claude Code, Cursor, etc.) resolve
    // to their ui_canonical form for UI component routing.
    const CLI_ALIAS_TESTS: [string, string][] = [
      // Shell aliases → run_shell
      ["Shell", "run_shell"],
      ["bash", "run_shell"],
      ["Bash", "run_shell"],
      ["shellToolCall", "run_shell"],

      // Search aliases → code_search
      ["grep", "code_search"],
      ["Grep", "code_search"],
      ["Search", "code_search"],
      ["search", "code_search"],

      // Edit aliases → edit_file
      ["Edit", "edit_file"],
      ["Write", "edit_file"],
      ["create_file", "edit_file"],
      ["edit_file_by_replace", "edit_file"],

      // Read aliases → read_file
      ["Read", "read_file"],
      ["readToolCall", "read_file"],

      // Subagent aliases → subagent
      ["Task", "subagent"],
      ["task", "subagent"],

      // Ask user aliases → ask_user_questions
      ["ask_question", "ask_user_questions"],
      ["AskQuestion", "ask_user_questions"],
      ["AskUserQuestion", "ask_user_questions"],
    ];

    for (const [alias, expected] of CLI_ALIAS_TESTS) {
      it(`"${alias}" → "${expected}"`, () => {
        expect(resolveToolName(alias)).toBe(expected);
      });
    }
  });

  describe("Rust canonical names pass through unchanged", () => {
    // Rust canonical names should NOT be aliased - they ARE the canonical form
    const RUST_CANONICAL_PASSTHROUGH = [
      "read_file",
      "list_dir",
      "run_shell",
      "edit_file",
      "agent",
      "manage_session",
      "control_browser_with_agent_browser",
      "control_browser_with_playwright",
      "control_external_browser",
      "web_search",
      "manage_story",
    ];

    for (const tool of RUST_CANONICAL_PASSTHROUGH) {
      it(`"${tool}" passes through unchanged`, () => {
        expect(resolveToolName(tool)).toBe(tool);
      });
    }
  });

  describe("No duplicate aliases across different primary keys", () => {
    it("file_search resolves consistently", () => {
      const resolved = resolveToolName("file_search");
      expect(["code_search", "glob_file_search"]).toContain(resolved);
      expect(resolveToolName("file_search")).toBe(resolved);
    });
  });
});

describe("getAppTypeForEvent coverage (common event names)", () => {
  const COMMON_EVENT_NAMES = [
    // Rust canonical names
    "read_file",
    "edit_file",
    "delete_file",
    "list_dir",
    "run_shell",
    "web_search",
    "web_fetch",
    "control_browser_with_agent_browser",
    "control_browser_with_playwright",
    "control_external_browser",
    "manage_story",
    "agent",
    "suggest_mode_switch",

    // CLI aliases (should also resolve via ui_canonical lookup)
    "Read",
    "Edit",
    "Shell",
    "bash",
    "grep",
    "Grep",

    // Conversation events
    "thinking",
    "assistant",
    "ask_user_questions",

    // Simulator-specific
    "browser",
    // ARCHIVED (2026-03-30): "render_canvas",
    "control_orgii",
    "manage_nodes",
  ];

  for (const name of COMMON_EVENT_NAMES) {
    it(`"${name}" resolves via getAppTypeForEvent`, () => {
      expect(getAppTypeForEvent(name)).not.toBeNull();
    });
  }
});
