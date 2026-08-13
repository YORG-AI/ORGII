//! Unified agent / orchestration tool entries (visible to the LLM).
//!
//! `manage_agent_def` is a first-class parent-agent tool. OS Agent ships
//! with it on by default; custom coordinator agents can opt in when their
//! definition declares the management capability. Work-item / project
//! management is not a tool surface — agents use the `org2-pm` CLI.

use super::aliases::*;
use super::macros::action_sub;

pub(super) static TOOLS: &[ToolEntry] = &[
    ToolEntry {
        name: tool_names::AGENT,
        description: "Launch a subagent to handle a task autonomously.",
        description_detail: "Invoke any built-in or custom agent as a subagent. Built-in: builtin:explore (read-only search), builtin:general (full tools). Pass an agent_id and a detailed prompt.",
        category: tool_categories::AGENT,
        icon_id: "infinity",
        simulator_app: AppBackgroundTasks,
        app_subtool: SubSubagent,
        chat_block: CbSubagent,
        human_tool_key: Some(Sessions),
        label_running: "tools.subagentRunning",
        label_done: "tools.subagentDone",
        label_failed: "tools.subagentFailed",
        actions: &[
            action_sub!(
                "assign",
                "Assigning task to a subagent (pre-start phase)",
                SubSubagent,
                chat: CbTitleOnly,
                labels: "tools.subagentAssigning", "tools.subagentAssigned", "tools.subagentAssignFailed"
            ),
            action_sub!("delegate", "Invoke a named agent by agent_id", SubSubagent, labels: "tools.subagentDelegateRunning", "tools.subagentDelegateDone", "tools.subagentDelegateFailed"),
            action_sub!("shadow", "Clone current agent's setup for parallel subtask", SubSubagent, labels: "tools.subagentShadowRunning", "tools.subagentShadowDone", "tools.subagentShadowFailed"),
            action_sub!("kill", "Abort a running background subagent by handle", SubSubagent, labels: "tools.subagentKillRunning", "tools.subagentKillDone", "tools.subagentKillFailed"),
        ],
        required_capability: CapOrch,
        ..DEFAULT_TOOL_ENTRY
    },
    ToolEntry {
        name: tool_names::MANAGE_AGENT_DEF,
        description: "Manage custom agent definitions and agent organizations.",
        description_detail: "CRUD over custom agents (list, get, create, update, remove) and agent organizations (list_orgs, get_org, create_org, update_org, remove_org). Use to inspect, create, or modify the user's library of custom agents and orgs.",
        category: tool_categories::AGENT,
        icon_id: "users",
        simulator_app: AppBackgroundTasks,
        app_subtool: OtherTool,
        chat_block: CbFallback,
        label_running: "tools.manageAgentDefRunning",
        label_done: "tools.manageAgentDefDone",
        label_failed: "tools.manageAgentDefFailed",
        action_icons: &[
            ("list", "bot-message-square"),
            ("get", "bot-message-square"),
            ("create", "bot"),
            ("update", "refresh-cw"),
            ("remove", "bot-off"),
            ("list_orgs", "users"),
            ("get_org", "users"),
            ("create_org", "bot"),
            ("update_org", "refresh-cw"),
            ("remove_org", "bot-off"),
        ],
        actions: &[
            action_sub!("list", "List custom agents", OtherTool, labels: "tools.manageAgentDefListRunning", "tools.manageAgentDefListDone", "tools.manageAgentDefListFailed"),
            action_sub!("get", "Get a custom agent definition", OtherTool, labels: "tools.manageAgentDefGetRunning", "tools.manageAgentDefGetDone", "tools.manageAgentDefGetFailed"),
            action_sub!("create", "Create a custom agent", OtherTool, labels: "tools.manageAgentDefCreateRunning", "tools.manageAgentDefCreateDone", "tools.manageAgentDefCreateFailed"),
            action_sub!("update", "Update a custom agent", OtherTool, labels: "tools.manageAgentDefUpdateRunning", "tools.manageAgentDefUpdateDone", "tools.manageAgentDefUpdateFailed"),
            action_sub!("remove", "Delete a custom agent", OtherTool, labels: "tools.manageAgentDefRemoveRunning", "tools.manageAgentDefRemoveDone", "tools.manageAgentDefRemoveFailed"),
            action_sub!("list_orgs", "List agent organizations", OtherTool, labels: "tools.manageAgentDefListOrgsRunning", "tools.manageAgentDefListOrgsDone", "tools.manageAgentDefListOrgsFailed"),
            action_sub!("get_org", "Get an org definition", OtherTool, labels: "tools.manageAgentDefGetOrgRunning", "tools.manageAgentDefGetOrgDone", "tools.manageAgentDefGetOrgFailed"),
            action_sub!("create_org", "Create an org", OtherTool, labels: "tools.manageAgentDefCreateOrgRunning", "tools.manageAgentDefCreateOrgDone", "tools.manageAgentDefCreateOrgFailed"),
            action_sub!("update_org", "Update an org", OtherTool, labels: "tools.manageAgentDefUpdateOrgRunning", "tools.manageAgentDefUpdateOrgDone", "tools.manageAgentDefUpdateOrgFailed"),
            action_sub!("remove_org", "Delete an org", OtherTool, labels: "tools.manageAgentDefRemoveOrgRunning", "tools.manageAgentDefRemoveOrgDone", "tools.manageAgentDefRemoveOrgFailed"),
        ],
        required_capability: CapManagement,
        ..DEFAULT_TOOL_ENTRY
    },
];
