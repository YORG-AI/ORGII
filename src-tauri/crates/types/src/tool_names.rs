//! Canonical tool name constants — single source of truth.
//!
//! Every tool's `fn name()` and every string-literal reference to a tool
//! (policy groups, disabled-tool lists, processor match arms, etc.) must
//! use these constants instead of raw `"…"` strings.
//!
//! Lives in `core_types` so non-`agent_core` crates (e.g. `project_management`'s
//! lineage event hook) can match on these names without forming a reverse
//! dependency on `agent_core`. `agent_core::tools::names` re-exports
//! everything from this module verbatim.

// ── Coding ──────────────────────────────────────────────────────────
pub const READ_FILE: &str = "read_file";
pub const LIST_DIR: &str = "list_dir";
pub const RUN_SHELL: &str = "run_shell";
pub const AWAIT_OUTPUT: &str = "await_output";
pub const INSPECT_TERMINALS: &str = "inspect_terminals";
pub const CODE_SEARCH: &str = "code_search";
pub const USE_CODE_MAP: &str = "use_code_map";
pub const MANAGE_CODE_MAP: &str = "manage_code_map";
pub const EDIT_FILE: &str = "edit_file";
pub const DELETE_FILE: &str = "delete_file";
pub const APPLY_PATCH: &str = "apply_patch";
pub const STORAGE_WRITE_FILE: &str = "write_file";
pub const STORAGE_CREATE_FILE: &str = "create_file";
pub const STORAGE_EDIT_FILE_BY_REPLACE: &str = "edit_file_by_replace";
pub const STORAGE_APPEND_FILE: &str = "append_file";
pub const STORAGE_FILE_RANGE_EDIT: &str = "file_range_edit";
pub const STORAGE_INSERT_CONTENT_AT_LINE: &str = "insert_content_at_line";
pub const FILE_EDIT_EVENT_FUNCTION_NAMES: &[&str] = &[
    EDIT_FILE,
    APPLY_PATCH,
    STORAGE_WRITE_FILE,
    STORAGE_CREATE_FILE,
    STORAGE_EDIT_FILE_BY_REPLACE,
    STORAGE_APPEND_FILE,
    STORAGE_FILE_RANGE_EDIT,
    STORAGE_INSERT_CONTENT_AT_LINE,
];
pub const CLI_DISPLAY_EDIT: &str = "Edit";
pub const CLI_DISPLAY_WRITE: &str = "Write";
pub const CLI_DISPLAY_CREATE: &str = "Create";
pub const CLI_DISPLAY_PATCH: &str = "Patch";
pub const CLI_DISPLAY_FILE_EDIT_FUNCTION_NAMES: &[&str] = &[
    CLI_DISPLAY_EDIT,
    CLI_DISPLAY_WRITE,
    CLI_DISPLAY_CREATE,
    CLI_DISPLAY_PATCH,
];
pub const MANAGE_WORKSPACE: &str = "manage_workspace";
pub const QUERY_LSP: &str = "query_lsp";
pub const MANAGE_LSP: &str = "manage_lsp";
pub const MANAGE_TODO: &str = "manage_todo";
pub const MANAGE_FILE_HISTORY: &str = "manage_file_history";
pub const SETUP_REPO: &str = "setup_repo";
pub const ASK_USER_QUESTIONS: &str = "ask_user_questions";
pub const ASK_USER_PERMISSIONS: &str = "ask_user_permissions";

/// Out-of-band secret capture. The agent asks the user (via a dedicated
/// frontend modal) to provide a sensitive value — API key, password, OAuth
/// token. The plaintext never enters the LLM transcript or tool args; only
/// the returned opaque `{{secret:...}}` token does. The token is resolved
/// to plaintext at the moment a privileged tool consumes it (today: only
/// `write_env_file`).
pub const MANAGE_SECRETS: &str = "manage_secrets";

/// Write a `.env`-style file to disk. The `content` template may contain
/// `{{secret:<token>}}` placeholders that were produced by `manage_secrets`;
/// these are resolved to plaintext at write time and never echoed back to
/// the LLM. Enforces workspace bounds, refuses to overwrite tracked files,
/// and sets `0o600` on Unix.
pub const WRITE_ENV_FILE: &str = "write_env_file";

// ── Project ─────────────────────────────────────────────────────────
pub const MANAGE_PROJECT: &str = "manage_project";
pub const MANAGE_WORK_ITEM: &str = "manage_work_item";

// ── Web ─────────────────────────────────────────────────────────────
pub const WEB_SEARCH: &str = "web_search";
pub const WEB_FETCH: &str = "web_fetch";
pub const CONTROL_BROWSER_WITH_AGENT_BROWSER: &str = "control_browser_with_agent_browser";
pub const CONTROL_BROWSER_WITH_PLAYWRIGHT: &str = "control_browser_with_playwright";
pub const CONTROL_EXTERNAL_BROWSER: &str = "control_external_browser";
pub const CONTROL_INTERNAL_BROWSER: &str = "control_internal_browser";
pub const CONTROL_ORGII: &str = "control_orgii";
pub const SPOTLIGHT: &str = "spotlight";

// ── Desktop ─────────────────────────────────────────────────────────
pub const CONTROL_DESKTOP_WITH_PEEKABOO: &str = "control_desktop_with_peekaboo";

// ── Agent / Comms ───────────────────────────────────────────────────
pub const MANAGE_SESSION: &str = "manage_session";
pub const SEND_MESSAGE: &str = "send_message";
pub const MANAGE_NODES: &str = "manage_nodes";
pub const MANAGE_AGENT_DEF: &str = "manage_agent_def";

/// Typed messaging inside an Agent Org run. Distinct from [`SEND_MESSAGE`]
/// (chat-channel egress) — this targets coordinator/member participants in
/// the same org by name or stable agent_id and persists to the typed
/// `agent_inbox` table.
pub const ORG_SEND_MESSAGE: &str = "org_send_message";

// ── Agent Org Tasks ─────────────────────────────────────────────────
/// Create a new task on the org-run-scoped task board. Only available
/// inside an Agent Org run.
pub const TASK_CREATE: &str = "task_create";
/// Update a task on the board (subject, owner, status, blocks, …).
/// Setting `owner` triggers a `TaskAssigned` inbox row for the new
/// owner; setting `status="deleted"` removes the task. Only available
/// inside an Agent Org run.
pub const TASK_UPDATE: &str = "task_update";
/// List every task in the current org run. Read-only. Only available
/// inside an Agent Org run.
pub const TASK_LIST: &str = "task_list";
/// Fetch one task by id with full payload (subject, description,
/// active_form, owner, status, blocks, blocked_by, metadata).
/// Read-only. Only available inside an Agent Org run.
pub const TASK_GET: &str = "task_get";

// ── Channel workspace tools ─────────────────────────────────────────
/// List known workspace paths seen in recent sessions.
pub const LIST_KNOWN_WORKSPACES: &str = "list_known_workspaces";
/// Grant the current session read/edit access to an additional directory
/// (silently invoked by an agent when the user mentions a new path in chat).
pub const ADD_WORKSPACE_DIRECTORY: &str = "add_workspace_directory";
/// Revoke a previously-added additional directory from the bound session.
pub const REMOVE_WORKSPACE_DIRECTORY: &str = "remove_workspace_directory";
/// Return a snapshot of the bound session's roots + additional
/// directories (for LLM self-check; never rendered back to the user).
pub const LIST_SESSION_WORKSPACE: &str = "list_session_workspace";

// ── Agent ───────────────────────────────────────────────────────────
/// Unified agent-worker tool — single entry point for Delegate and Shadow runs.
/// `delegate` mode invokes another explicit Agent; `shadow` mode forks the current Agent.
pub const AGENT: &str = "agent";

// ── Git Worktree ────────────────────────────────────────────────────
pub const WORKTREE: &str = "worktree";

// ── Meta ────────────────────────────────────────────────────────────
pub const SEND_TO_INBOX: &str = "send_to_inbox";
pub const SUGGEST_MODE_SWITCH: &str = "suggest_mode_switch";
pub const SUGGEST_NEXT_STEPS: &str = "suggest_next_steps";
pub const TOOL_SEARCH: &str = "tool_search";

// ── UI Output ───────────────────────────────────────────────────────
/// Renders interactive HTML, URL embeds, or A2UI JSONL streams directly
/// inside the chat panel as a sandboxed inline canvas card. Supported by
/// both OS Agent and SDE Agent. Mode values: "html" | "url" | "a2ui" | "react".
pub const RENDER_INLINE_CANVAS: &str = "render_inline_canvas";

// ── Plan Mode ───────────────────────────────────────────────────────
/// Writes markdown plan content to the session's plan file AND submits it
/// for the user's review in a single step (Plan mode only, top-level agent).
pub const CREATE_PLAN: &str = "create_plan";
pub const PLAN_APPROVAL: &str = "plan_approval";

#[cfg(test)]
#[path = "tool_names_tests.rs"]
mod tests;
