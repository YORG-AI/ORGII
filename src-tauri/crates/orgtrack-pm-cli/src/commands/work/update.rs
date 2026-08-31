use std::collections::HashMap;

use project_management::work_service;

use super::{item_to_wire, require_short_id, resolve_body_flag, standalone_fallback_item};
use crate::commands::{guarded, mutation_actor};
use crate::context::ExecutionContext;
use crate::envelope::{emit_error, emit_success, CliError, ErrorCode};

pub(super) fn run(
    context: &ExecutionContext,
    short_id: Option<&String>,
    flags: &HashMap<String, String>,
) -> i32 {
    if let Err(err) = context.require_project_mode("work.update") {
        return emit_error(err);
    }
    let body_flag = match resolve_body_flag(flags) {
        Ok(body) => body,
        Err(err) => return emit_error(err),
    };
    let stage_update: Option<Option<u32>> = match flags.get("stage") {
        None => None,
        Some(raw) if raw.trim() == "none" => Some(None),
        Some(raw) => match raw.trim().parse::<u32>() {
            Ok(value) if value >= 1 => Some(Some(value)),
            _ => {
                return emit_error(
                    CliError::new(
                        ErrorCode::InvalidArgument,
                        format!(
                            "Invalid --stage '{}'; expected a positive integer or 'none'",
                            raw
                        ),
                    )
                    .with_details(serde_json::json!({ "field": "--stage", "value": raw })),
                )
            }
        },
    };
    if flags.contains_key("standalone") {
        let short_id = match require_short_id(short_id) {
            Ok(short_id) => short_id,
            Err(err) => return emit_error(err),
        };
        let actor = match mutation_actor(context) {
            Ok(actor) => actor,
            Err(err) => return emit_error(err),
        };
        let org = context.org_id.clone();
        match work_service::patch_standalone_work_item(
            org.as_deref(),
            &short_id,
            flags.get("title").map(String::as_str),
            body_flag.as_deref(),
            flags.get("priority").map(String::as_str),
            stage_update,
            Some(&actor),
        ) {
            Ok(item) => return emit_success(item_to_wire(&item, None), None, None),
            Err(err) => return emit_error(CliError::from_service(err)),
        }
    }
    let short_id = match require_short_id(short_id) {
        Ok(short_id) => short_id,
        Err(err) => return emit_error(err),
    };
    let actor = match mutation_actor(context) {
        Ok(actor) => actor,
        Err(err) => return emit_error(err),
    };
    if flags.contains_key("status") || flags.contains_key("to") {
        return emit_error(CliError::new(
            ErrorCode::InvalidArgument,
            "work update does not change state; use work transition --to <state>",
        ));
    }
    if standalone_fallback_item(context, &short_id).is_some() {
        return match work_service::patch_standalone_work_item(
            context.org_id.as_deref(),
            &short_id,
            flags.get("title").map(String::as_str),
            body_flag.as_deref(),
            flags.get("priority").map(String::as_str),
            stage_update,
            Some(&actor),
        ) {
            Ok(item) => emit_success(item_to_wire(&item, None), None, None),
            Err(err) => emit_error(CliError::from_service(err)),
        };
    }
    let scope = match context.require_scope() {
        Ok(scope) => scope.to_string(),
        Err(err) => return emit_error(err),
    };
    let expected_revision = flags
        .get("expected-revision")
        .and_then(|value| value.parse::<i64>().ok());
    let canonical = serde_json::json!({
        "op": "work.update",
        "shortId": short_id,
        "title": flags.get("title"),
        "body": body_flag,
        "priority": flags.get("priority"),
        "expectedRevision": expected_revision,
    });
    let scope_for_exec = scope.clone();
    let short_id_for_exec = short_id.clone();
    let caller_session = context
        .session_ref
        .as_ref()
        .map(|session| session.external_id.clone());
    let title = flags.get("title").cloned();
    let body = body_flag.clone();
    let priority = flags.get("priority").cloned();
    let result = guarded(
        &actor.id.clone(),
        "work.update",
        &scope,
        flags.get("idempotency-key"),
        canonical,
        move || {
            let item = work_service::patch_project_work_item(
                &scope_for_exec,
                &short_id_for_exec,
                title.as_deref(),
                body.as_deref(),
                priority.as_deref(),
                stage_update,
                Some(&actor),
                expected_revision,
                caller_session.as_deref(),
            )?;
            let revision =
                work_service::read_project_work_item_revision(&scope_for_exec, &short_id_for_exec)
                    .ok();
            Ok(item_to_wire(&item, revision))
        },
    );
    match result {
        Ok(wire) => emit_success(wire, None, None),
        Err(err) => emit_error(err),
    }
}
