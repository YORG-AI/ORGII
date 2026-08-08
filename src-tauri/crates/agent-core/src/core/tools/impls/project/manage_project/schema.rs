//! Static description + JSON Schema for the `manage_project` tool.
//!
//! Pulled into its own module so the `Tool` impl in `mod.rs` reads as a
//! thin dispatch layer — see the `actions` submodule for the per-verb
//! handlers.
//!
//! Work-item CRUD moved to `manage_work_item` (Orgtrack migration
//! Phase 8); this tool keeps project CRUD, members, global `find`, and
//! `start_item` — the orchestrator-launch capability `manage_work_item`
//! does not have.

use serde_json::{json, Value};

pub(super) const DESCRIPTION: &str =
    "Manage projects (Work Item parent containers) in the global project store.\n\n\
     **Projects**: list, read, create, update, delete.\n\
     **Execution**: start_item — launch a work item's orchestrator run via the SDE agent.\n\
     **Search**: find — search work items and projects globally by ID, title, or keyword.\n\
     **Members**: list_members — list team members. list_contributors — sync and list git contributors.\n\n\
     Work item CRUD (list/read/create/update/delete) lives on the manage_work_item tool.";

pub(super) fn llm_description() -> String {
    "Manage projects in the global project store.\n\n\
     Projects: list, read, create, update, delete.\n\
     Execution: start_item (launch a work item's orchestrator run).\n\
     Search: find — global.\n\
     Members: list_members, list_contributors.\n\
     Work item CRUD lives on manage_work_item."
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
                         "start_item", "find", "list_members", "list_contributors"]
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
            "project_org_id": {
                "type": "string",
                "description": "Project-org id to create the project under (for 'create'). Omit to use the session's org context (falls back to 'personal-org'). NOT the agent org — see 'org_id'."
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
                "description": "Work item short ID, e.g. 'PROJ-001' (for start_item)"
            }
        },
        "required": ["action"]
    })
}

