/**
 * Canonical built-in tool names — TS mirror of the Rust source of truth at
 * `src-tauri/src/agent_core/core/tools/names.rs`.
 *
 * Use these constants instead of hardcoding string literals like `"web_search"`.
 * The contract test in `__tests__/toolNames.test.ts` reads `names.rs` and
 * fails the build if the two sides drift.
 *
 * NOTE: The list does NOT need to enumerate every tool — only the names that
 * the frontend actually references by string today (readiness, per-tool
 * config panels, etc.). Add new entries as new TS call sites appear; don't
 * pre-mirror Rust names that nothing on the FE uses.
 */
export const TOOL_NAMES = {
  // ── Coding ──────────────────────────────────────────────────────────
  READ_FILE: "read_file",
  EDIT_FILE: "edit_file",
  DELETE_FILE: "delete_file",
  RUN_SHELL: "run_shell",
  AWAIT_OUTPUT: "await_output",
  INSPECT_TERMINALS: "inspect_terminals",

  // ── Web ─────────────────────────────────────────────────────────────
  WEB_SEARCH: "web_search",
  WEB_FETCH: "web_fetch",
  CONTROL_BROWSER_WITH_AGENT_BROWSER: "control_browser_with_agent_browser",
  CONTROL_BROWSER_WITH_PLAYWRIGHT: "control_browser_with_playwright",
  CONTROL_EXTERNAL_BROWSER: "control_external_browser",
  CONTROL_INTERNAL_BROWSER: "control_internal_browser",

  // ── Desktop ─────────────────────────────────────────────────────────
  CONTROL_DESKTOP_WITH_PEEKABOO: "control_desktop_with_peekaboo",

  // ── Interaction ─────────────────────────────────────────────────────
  ASK_USER_QUESTIONS: "ask_user_questions",
  ASK_USER_PERMISSIONS: "ask_user_permissions",
  SUGGEST_MODE_SWITCH: "suggest_mode_switch",
  SKILL: "skill",

  // ── Plan Mode ───────────────────────────────────────────────────────
  CREATE_PLAN: "create_plan",

  // ── AgentOrg Messaging / Task Board ────────────────────────────────
  ORG_SEND_MESSAGE: "org_send_message",
  TASK_CREATE: "task_create",
  TASK_GRAPH_CREATE: "task_graph_create",
  TASK_UPDATE: "task_update",
  TASK_LIST: "task_list",
  TASK_GET: "task_get",
} as const;

export type ToolName = (typeof TOOL_NAMES)[keyof typeof TOOL_NAMES];
