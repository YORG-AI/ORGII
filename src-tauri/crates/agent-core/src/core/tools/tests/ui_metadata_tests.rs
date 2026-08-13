//! Tests that built-in tool UI metadata (e.g. icons) is complete for registered tools.

use std::collections::{BTreeSet, HashSet};

use super::builtin_tools::{builtin_tool_entries, BUILTIN_TOOLS};
use super::names;
use super::policy::TOOL_GROUPS;
use super::ui_metadata::{AppSubtool, ChatBlock, SimulatorApp, ToolDisplayBehavior};

fn invokable_canonical_tool_names() -> BTreeSet<&'static str> {
    BTreeSet::from([
        names::READ_FILE,
        names::LIST_DIR,
        names::RUN_SHELL,
        names::AWAIT_OUTPUT,
        names::CODE_SEARCH,
        names::MANAGE_WORKSPACE,
        names::EDIT_FILE,
        names::DELETE_FILE,
        names::QUERY_LSP,
        names::MANAGE_LSP,
        names::MANAGE_TODO,
        names::MANAGE_FILE_HISTORY,
        names::CREATE_PLAN,
        names::SETUP_REPO,
        names::WORKTREE,
        names::RENDER_INLINE_CANVAS,
        names::INSPECT_TERMINALS,
        names::WEB_SEARCH,
        names::WEB_FETCH,
        names::CONTROL_BROWSER_WITH_AGENT_BROWSER,
        names::CONTROL_BROWSER_WITH_PLAYWRIGHT,
        names::CONTROL_INTERNAL_BROWSER,
        names::CONTROL_DESKTOP_WITH_PEEKABOO,
        names::CONTROL_ORGII,
        names::SPOTLIGHT,
        names::REPLY_SESSION_COMMENT,
        names::AGENT,
        names::MANAGE_AGENT_DEF,
        names::MANAGE_NODES,
        names::ASK_USER_QUESTIONS,
        names::MANAGE_SECRETS,
        names::WRITE_ENV_FILE,
        names::MANAGE_SESSION,
        names::SEND_MESSAGE,
        names::SEND_TO_INBOX,
        names::TOOL_SEARCH,
        names::ORG_SEND_MESSAGE,
        names::TASK_CREATE,
        names::TASK_GRAPH_CREATE,
        names::TASK_UPDATE,
        names::TASK_LIST,
        names::TASK_GET,
        names::ORG_RUN_COMPLETE,
        names::ORG_INBOX_REPAIR,
    ])
}

#[test]
fn builtin_table_covers_every_invokable_canonical_tool() {
    let builtin_names: BTreeSet<&str> = BUILTIN_TOOLS.iter().map(|entry| entry.name).collect();
    let invokable_names = invokable_canonical_tool_names();
    let missing: Vec<&str> = invokable_names
        .difference(&builtin_names)
        .copied()
        .collect();

    assert!(
        missing.is_empty(),
        "invokable canonical tool names missing builtin metadata: {missing:?}"
    );
}

#[test]
fn builtin_table_has_no_untracked_invokable_names() {
    let invokable_names = invokable_canonical_tool_names();
    let event_only_names = BTreeSet::from([
        names::ASK_USER_PERMISSIONS,
        names::SUGGEST_MODE_SWITCH,
        "thinking",
        "agent_message",
        "user_message",
        "subagent",
        "mcp_tool",
        "tool_call",
    ]);
    let extra: Vec<&str> = BUILTIN_TOOLS
        .iter()
        .map(|entry| entry.name)
        .filter(|name| !invokable_names.contains(name) && !event_only_names.contains(name))
        .collect();

    assert!(
        extra.is_empty(),
        "builtin metadata contains names that are neither invokable canonical tools nor tracked event-only renderers: {extra:?}"
    );
}

#[test]
fn builtin_tool_names_are_unique() {
    let mut seen = HashSet::new();
    let duplicates: Vec<&str> = BUILTIN_TOOLS
        .iter()
        .map(|entry| entry.name)
        .filter(|name| !seen.insert(*name))
        .collect();

    assert!(
        duplicates.is_empty(),
        "duplicate builtin tool names: {duplicates:?}"
    );
}

#[test]
fn policy_groups_reference_only_builtin_or_workspace_tools() {
    let builtin_names: HashSet<&str> = BUILTIN_TOOLS.iter().map(|entry| entry.name).collect();
    let non_builtin_runtime_tools = HashSet::from([
        names::LIST_KNOWN_WORKSPACES,
        names::ADD_WORKSPACE_DIRECTORY,
        names::REMOVE_WORKSPACE_DIRECTORY,
        names::LIST_SESSION_WORKSPACE,
    ]);
    let unknown: Vec<&str> = TOOL_GROUPS
        .iter()
        .flat_map(|(_, tools)| tools.iter().copied())
        .filter(|name| !builtin_names.contains(name) && !non_builtin_runtime_tools.contains(name))
        .collect();

    assert!(
        unknown.is_empty(),
        "policy groups reference unknown tools: {unknown:?}"
    );
}

#[test]
fn every_visible_or_invokable_builtin_tool_has_status_labels() {
    let invokable_names = invokable_canonical_tool_names();
    let missing: Vec<&str> = BUILTIN_TOOLS
        .iter()
        .filter(|entry| invokable_names.contains(entry.name) || !entry.hidden)
        .filter(|entry| {
            entry.label_running.is_empty()
                || entry.label_done.is_empty()
                || entry.label_failed.is_empty()
        })
        .map(|entry| entry.name)
        .collect();

    assert!(
        missing.is_empty(),
        "visible/invokable tools must provide lifecycle labels: {missing:?}"
    );
}

#[test]
fn every_renderable_tool_has_non_default_chat_block() {
    let exempt_fallback_tools = HashSet::from([
        names::MANAGE_WORKSPACE,
        names::MANAGE_LSP,
        names::MANAGE_FILE_HISTORY,
        names::SETUP_REPO,
        names::WORKTREE,
        names::RENDER_INLINE_CANVAS,
        names::INSPECT_TERMINALS,
        names::CONTROL_DESKTOP_WITH_PEEKABOO,
        names::CONTROL_BROWSER_WITH_AGENT_BROWSER,
        names::CONTROL_BROWSER_WITH_PLAYWRIGHT,
        names::CONTROL_INTERNAL_BROWSER,
        names::CONTROL_ORGII,
        names::SPOTLIGHT,
        names::REPLY_SESSION_COMMENT,
        names::MANAGE_AGENT_DEF,
        names::MANAGE_NODES,
        names::ASK_USER_QUESTIONS,
        names::MANAGE_SECRETS,
        names::WRITE_ENV_FILE,
        "thinking",
        "agent_message",
        "user_message",
        "mcp_tool",
        "tool_call",
    ]);
    let missing: Vec<&str> = BUILTIN_TOOLS
        .iter()
        .filter(|entry| entry.chat_block == ChatBlock::Fallback)
        .filter(|entry| !exempt_fallback_tools.contains(entry.name))
        .map(|entry| entry.name)
        .collect();

    assert!(
        missing.is_empty(),
        "tools with fallback chat blocks must be explicitly classified in the exemption ledger: {missing:?}"
    );
}

#[test]
fn every_builtin_tool_has_icon_id() {
    let tools = builtin_tool_entries("builtin".into());
    for tool in &tools {
        assert!(
            !tool.icon_id.is_empty(),
            "missing icon_id for {}",
            tool.name
        );
    }
}

#[test]
fn every_builtin_tool_has_detail_text() {
    let tools = builtin_tool_entries("builtin".into());
    for tool in &tools {
        let Some(detail) = tool.description_detail.as_deref() else {
            panic!("missing description_detail for {}", tool.name);
        };
        assert!(
            detail.len() > 20,
            "description_detail too short for {}: {:?}",
            tool.name,
            detail
        );
    }
}

#[test]
fn internal_tool_calls_route_to_code_editor_other_tool_usage() {
    let tools = builtin_tool_entries("builtin".into());

    // tool_search intentionally renders as an Explore-style block
    // (book-search icon, CbExplore chat block) — discovery reads as
    // exploration in the UI, not as an anonymous internal call.
    let tool_search = tools
        .iter()
        .find(|entry| entry.name == names::TOOL_SEARCH)
        .expect("missing metadata for tool_search");
    assert_eq!(tool_search.app_subtool, AppSubtool::Explore, "tool_search");

    for tool_name in [names::MANAGE_NODES, "mcp_tool", "tool_call"] {
        let tool = tools
            .iter()
            .find(|entry| entry.name == tool_name)
            .unwrap_or_else(|| panic!("missing metadata for {tool_name}"));

        assert_eq!(tool.simulator_app, SimulatorApp::CodeEditor, "{tool_name}");
        assert_eq!(tool.app_subtool, AppSubtool::OtherTool, "{tool_name}");
    }
}

#[test]
fn coding_tool_display_behaviors_are_serialized() {
    let tools = builtin_tool_entries("builtin".into());

    for (tool_name, expected_behavior) in [
        (names::READ_FILE, ToolDisplayBehavior::Instant),
        (names::RUN_SHELL, ToolDisplayBehavior::Stream),
        (names::CODE_SEARCH, ToolDisplayBehavior::WaitForResult),
        (names::LIST_DIR, ToolDisplayBehavior::WaitForResult),
    ] {
        let tool = tools
            .iter()
            .find(|entry| entry.name == tool_name)
            .unwrap_or_else(|| panic!("missing metadata for {tool_name}"));
        assert_eq!(tool.display_behavior, expected_behavior, "{tool_name}");
    }
}
