use std::collections::HashMap;

use project_management::projects::types::WorkItemMutationActor;
use project_management::work_service;

use super::{require_short_id, resolve_body_flag, standalone_fallback_item};
use crate::commands::mutation_actor;
use crate::context::ExecutionContext;
use crate::envelope::{emit_error, emit_success, CliError, ErrorCode};

fn agent_note_session<'a>(
    context: &'a ExecutionContext,
    actor: &WorkItemMutationActor,
) -> Option<&'a str> {
    if !actor.id.starts_with("agent:") {
        return None;
    }
    context
        .session_ref
        .as_ref()
        .filter(|session| session.provider == "org2")
        .map(|session| session.external_id.as_str())
}

pub(super) fn run(
    context: &ExecutionContext,
    short_id: Option<&String>,
    flags: &HashMap<String, String>,
) -> i32 {
    if let Err(err) = context.require_project_mode("work.note") {
        return emit_error(err);
    }
    if flags.contains_key("standalone") {
        let short_id = match require_short_id(short_id) {
            Ok(short_id) => short_id,
            Err(err) => return emit_error(err),
        };
        let actor = match mutation_actor(context) {
            Ok(actor) => actor,
            Err(err) => return emit_error(err),
        };
        let body = match resolve_body_flag(flags) {
            Ok(Some(body)) if !body.trim().is_empty() => body,
            Ok(_) => {
                return emit_error(CliError::new(
                    ErrorCode::InvalidArgument,
                    "work note requires --body or --body-file",
                ))
            }
            Err(err) => return emit_error(err),
        };
        let body = body.as_str();
        let parent_id = flags.get("parent-id").map(String::as_str);
        let kind = flags.get("kind").map(String::as_str).unwrap_or("comment");
        const KINDS: &[&str] = &[
            "comment", "progress", "blocker", "decision", "handoff", "review",
        ];
        if !KINDS.contains(&kind) {
            return emit_error(CliError::new(
                ErrorCode::InvalidArgument,
                format!(
                    "Unknown note kind '{}'; expected comment|progress|blocker|decision|handoff|review",
                    kind
                ),
            ));
        }
        return match work_service::note_standalone_work_item_threaded(
            context.org_id.as_deref(),
            &short_id,
            kind,
            body,
            parent_id,
            Some(&actor),
            agent_note_session(context, &actor),
        ) {
            Ok(()) => emit_success(
                serde_json::json!({ "appended": true, "kind": kind }),
                None,
                None,
            ),
            Err(err) => emit_error(CliError::from_service(err)),
        };
    }
    let short_id = match require_short_id(short_id) {
        Ok(short_id) => short_id,
        Err(err) => return emit_error(err),
    };
    let actor = match mutation_actor(context) {
        Ok(actor) => actor,
        Err(err) => return emit_error(err),
    };
    let body = match resolve_body_flag(flags) {
        Ok(Some(body)) if !body.trim().is_empty() => body,
        Ok(_) => {
            return emit_error(CliError::new(
                ErrorCode::InvalidArgument,
                "work note requires --body or --body-file",
            ))
        }
        Err(err) => return emit_error(err),
    };
    let body = body.as_str();
    let parent_id = flags.get("parent-id").map(String::as_str);
    let kind = flags.get("kind").map(String::as_str).unwrap_or("comment");
    const KINDS: &[&str] = &[
        "comment", "progress", "blocker", "decision", "handoff", "review",
    ];
    if !KINDS.contains(&kind) {
        return emit_error(CliError::new(
            ErrorCode::InvalidArgument,
            format!(
                "Unknown note kind '{}'; expected comment|progress|blocker|decision|handoff|review",
                kind
            ),
        ));
    }
    if standalone_fallback_item(context, &short_id).is_some() {
        return match work_service::note_standalone_work_item_threaded(
            context.org_id.as_deref(),
            &short_id,
            kind,
            body,
            parent_id,
            Some(&actor),
            agent_note_session(context, &actor),
        ) {
            Ok(()) => emit_success(
                serde_json::json!({ "appended": true, "kind": kind }),
                None,
                None,
            ),
            Err(err) => emit_error(CliError::from_service(err)),
        };
    }
    let scope = match context.require_scope() {
        Ok(scope) => scope.to_string(),
        Err(err) => return emit_error(err),
    };
    match work_service::note_project_work_item_threaded(
        &scope,
        &short_id,
        kind,
        body,
        parent_id,
        Some(&actor),
        agent_note_session(context, &actor),
    ) {
        Ok(()) => emit_success(
            serde_json::json!({ "appended": true, "kind": kind }),
            None,
            None,
        ),
        Err(err) => emit_error(CliError::from_service(err)),
    }
}
