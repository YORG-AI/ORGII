//! Wire-string stability tests for `tool_names`.
//!
//! These constants are matched as raw strings by non-`agent_core` crates
//! (e.g. `project_management::lineage::event_hook::EDIT_FUNCTION_NAMES`).
//! If a constant's value changes, the match silently breaks at runtime
//! with no compile error. These tests pin every wire string so any
//! accidental rename surfaces here first.

use super::*;

#[test]
fn tool_name_constants_are_stable_wire_strings() {
    // ── Coding ──
    assert_eq!(READ_FILE, "read_file");
    assert_eq!(LIST_DIR, "list_dir");
    assert_eq!(RUN_SHELL, "run_shell");
    assert_eq!(AWAIT_OUTPUT, "await_output");
    assert_eq!(CODE_SEARCH, "code_search");
    assert_eq!(EDIT_FILE, "edit_file");
    assert_eq!(DELETE_FILE, "delete_file");
    assert_eq!(APPLY_PATCH, "apply_patch");
    assert_eq!(MANAGE_WORKSPACE, "manage_workspace");
    assert_eq!(QUERY_LSP, "query_lsp");
    assert_eq!(MANAGE_LSP, "manage_lsp");
    assert_eq!(MANAGE_TODO, "manage_todo");
    assert_eq!(SETUP_REPO, "setup_repo");
    assert_eq!(ASK_USER_QUESTIONS, "ask_user_questions");
    assert_eq!(ASK_USER_PERMISSIONS, "ask_user_permissions");
    assert_eq!(MANAGE_SECRETS, "manage_secrets");
    assert_eq!(WRITE_ENV_FILE, "write_env_file");

    // ── Project ──
    assert_eq!(MANAGE_PROJECT, "manage_project");
    assert_eq!(MANAGE_WORK_ITEM, "manage_work_item");

    // ── Web ──
    assert_eq!(WEB_SEARCH, "web_search");
    assert_eq!(WEB_FETCH, "web_fetch");
    assert_eq!(
        CONTROL_BROWSER_WITH_AGENT_BROWSER,
        "control_browser_with_agent_browser"
    );
    assert_eq!(
        CONTROL_BROWSER_WITH_PLAYWRIGHT,
        "control_browser_with_playwright"
    );
    assert_eq!(CONTROL_EXTERNAL_BROWSER, "control_external_browser");
    assert_eq!(CONTROL_INTERNAL_BROWSER, "control_internal_browser");
    assert_eq!(CONTROL_ORGII, "control_orgii");
    assert_eq!(SPOTLIGHT, "spotlight");
    assert_eq!(REPLY_SESSION_COMMENT, "reply_session_comment");

    // ── Desktop ──
    assert_eq!(
        CONTROL_DESKTOP_WITH_PEEKABOO,
        "control_desktop_with_peekaboo"
    );

    // ── Agent / Comms ──
    assert_eq!(MANAGE_SESSION, "manage_session");
    assert_eq!(SEND_MESSAGE, "send_message");
    assert_eq!(MANAGE_NODES, "manage_nodes");
    assert_eq!(MANAGE_AGENT_DEF, "manage_agent_def");
    assert_eq!(ORG_SEND_MESSAGE, "org_send_message");

    // ── Agent Org Tasks ──
    assert_eq!(TASK_CREATE, "task_create");
    assert_eq!(TASK_GRAPH_CREATE, "task_graph_create");
    assert_eq!(TASK_UPDATE, "task_update");
    assert_eq!(TASK_LIST, "task_list");
    assert_eq!(TASK_GET, "task_get");
    assert_eq!(ORG_RUN_COMPLETE, "org_run_complete");
    assert_eq!(ORG_INBOX_REPAIR, "org_inbox_repair");

    // ── Channel workspace tools ──
    assert_eq!(LIST_KNOWN_WORKSPACES, "list_known_workspaces");
    assert_eq!(ADD_WORKSPACE_DIRECTORY, "add_workspace_directory");
    assert_eq!(REMOVE_WORKSPACE_DIRECTORY, "remove_workspace_directory");
    assert_eq!(LIST_SESSION_WORKSPACE, "list_session_workspace");

    // ── Agent ──
    assert_eq!(AGENT, "agent");

    // ── Git Worktree ──
    assert_eq!(WORKTREE, "worktree");

    // ── Meta ──
    assert_eq!(SEND_TO_INBOX, "send_to_inbox");
    assert_eq!(SUGGEST_MODE_SWITCH, "suggest_mode_switch");
    assert_eq!(TOOL_SEARCH, "tool_search");

    // ── Plan Mode ──
    assert_eq!(CREATE_PLAN, "create_plan");
    assert_eq!(PLAN_APPROVAL, "plan_approval");
}

#[test]
fn tool_names_referenced_by_event_hook_are_present() {
    // Subset matched as raw strings by
    // `project_management::lineage::event_hook::EDIT_FUNCTION_NAMES`
    // (and the `function_name == tool_names::EDIT_FILE` arm in
    // `resolve_line_range`). If any of these constants is deleted from
    // `tool_names.rs`, this test fails fast in `core_types`'s own suite
    // instead of surfacing as a compile error in a far-away crate.
    assert!(!EDIT_FILE.is_empty());
    assert_eq!(EDIT_FILE, "edit_file");
}
