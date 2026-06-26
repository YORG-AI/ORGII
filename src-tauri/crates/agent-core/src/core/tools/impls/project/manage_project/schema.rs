//! Static description + JSON Schema for the `manage_project` tool.
//!
//! Pulled into its own module so the `Tool` impl in `mod.rs` reads as a
//! thin dispatch layer — see the `actions` submodule for the per-verb
//! handlers.

use serde_json::{json, Value};

pub(super) const DESCRIPTION: &str =
    "Manage projects and work items (tasks/issues) in the global project store.\n\n\
     **Projects** (Work Item parent containers): list, read, create, update, delete.\n\
     **Work items** (tasks/bugs): list_items, read_item, create_item, update_item, delete_item, start_item.\n\
     **Search**: find — search work items and projects globally by ID, title, or keyword.\n\
     **Members**: list_members — list team members. list_contributors — sync and list git contributors.\n\n\
     Use 'find' to locate work items. Use 'start_item' to execute via SDE agent.";

pub(super) fn llm_description() -> String {
    "Manage projects and work items in the global project store.\n\n\
     Projects: list, read, create, update, delete.\n\
     Work items: list_items, read_item, create_item, update_item, delete_item, start_item.\n\
     Search: find — global.\n\
     Members: list_members, list_contributors."
        .to_string()
}

pub(super) fn parameters() -> Value {
    json!({
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "description": "The operation to perform.",
                "enum": ["list", "read", "create", "update", "delete",
                         "list_items", "read_item", "create_item", "update_item", "delete_item", "start_item",
                         "find", "list_members", "list_contributors"]
            },
            "query": {
                "type": "string",
                "description": "Search term for 'find' action: work item ID, title keyword, project name, or assignee. Searches across ALL IDE workspaces."
            },
            "slug": {
                "type": "string",
                "description": "Project identifier — accepts slug, display name, or project ID (e.g. 'my-project', 'My Project', or 'project-my-project'). Required for project-specific actions. Optional for list_members/list_contributors; omit it to list or sync across all projects. Use 'list' to discover available projects."
            },
            "name": {
                "type": "string",
                "description": "Project name (required for create, optional for update)"
            },
            "description": {
                "type": "string",
                "description": "Project description (markdown)"
            },
            "status": {
                "type": "string",
                "description": "Project status",
                "enum": ["backlog", "planned", "in_progress", "completed", "canceled"]
            },
            "priority": {
                "type": "string",
                "description": "Project priority",
                "enum": ["urgent", "high", "medium", "low", "none"]
            },
            "health": {
                "type": "string",
                "description": "Project health indicator",
                "enum": ["on_track", "at_risk", "off_track", "no_updates"]
            },
            "lead": {
                "type": "string",
                "description": "Member ID of the project lead. Pass empty string to clear."
            },
            "members": {
                "type": "array",
                "items": { "type": "string" },
                "description": "Member IDs assigned to the project"
            },
            "labels": {
                "type": "array",
                "items": { "type": "string" },
                "description": "Label IDs (e.g. ['lbl-bug', 'lbl-feature'])"
            },
            "linked_repos": {
                "type": "array",
                "items": { "type": "string" },
                "description": "Linked repository paths or URLs"
            },
            "start_date": {
                "type": "string",
                "description": "Project start date (ISO 8601, e.g. '2026-02-15'). Pass empty string to clear."
            },
            "target_date": {
                "type": "string",
                "description": "Project target/due date (ISO 8601). Pass empty string to clear."
            },
            "short_id": {
                "type": "string",
                "description": "Work item short ID, e.g. 'PROJ-001' (for read_item, update_item, delete_item)"
            },
            "title": {
                "type": "string",
                "description": "Work item title (required for create_item)"
            },
            "assignee": {
                "type": "string",
                "description": "ID of the assignee (member ID, agent definition ID, or org ID)"
            },
            "assignee_type": {
                "type": "string",
                "enum": ["member", "agent", "org"],
                "description": "Type of assignee: 'member' for human, 'agent' for AgentDefinition, 'org' for AgentOrg. Defaults to 'member'."
            },
            "milestone": {
                "type": "string",
                "description": "Milestone ID for work item"
            },
            "parent": {
                "type": "string",
                "description": "Parent work item short ID (for sub-issues)"
            },
            "starred": {
                "type": "boolean",
                "description": "Star/bookmark this work item"
            },
            "todos": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "content": { "type": "string" },
                        "status": { "type": "string", "enum": ["pending", "in_progress", "completed"] }
                    },
                    "required": ["content"]
                },
                "description": "Todo checklist items (replaces existing)"
            },
            "selected_account_id": {
                "type": "string",
                "description": "Code account ID for Agent Workflow (from Integrations). Assigns which account runs SDE/Review."
            },
            "selected_model_id": {
                "type": "string",
                "description": "Model ID for Agent Workflow. Use with selected_account_id."
            },
            "sub_agent_ids": {
                "type": "array",
                "items": { "type": "string" },
                "description": "IDs of custom agents from Agent Orgs to use as sub-agents during execution."
            },
            "org_id": {
                "type": "string",
                "description": "ID of the agent organization to assign. All org members are resolved as sub-agents."
            },
            "worktree_path": {
                "type": "string",
                "description": "Absolute path to the code repository where the SDE Agent will work. Overrides project linked_repos. Use the Active IDE Repository path when available."
            },
            "review_config": {
                "type": "object",
                "description": "Review configuration. Must include 'reviewer' object with 'type' (agent/org/human/self_review) and optional 'id'. Top-level optional: max_rounds (default 3), model_id, account_id."
            },
            "schedule": {
                "type": "object",
                "description": "Automatic start schedule for a work item. Use 'at' for one-time (ISO 8601 timestamp) or 'cron' for recurring (cron expression).",
                "properties": {
                    "at": {
                        "type": "string",
                        "description": "One-time trigger: ISO 8601 timestamp (e.g. '2026-03-16T18:30:00Z')"
                    },
                    "cron": {
                        "type": "string",
                        "description": "Recurring trigger: cron expression (e.g. '0 9 * * *' for daily 9 AM)"
                    },
                    "enabled": {
                        "type": "boolean",
                        "description": "Whether this schedule is active (default: true)"
                    }
                }
            }
        },
        "required": ["action"]
    })
}
