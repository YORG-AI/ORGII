use std::collections::HashMap;

use project_management::work_service;

use super::{item_to_wire, require_short_id, standalone_fallback_item};
use crate::commands::{guarded, mutation_actor};
use crate::context::ExecutionContext;
use crate::envelope::{emit_error, emit_success, CliError, ErrorCode};

pub(super) fn run(
    context: &ExecutionContext,
    short_id: Option<&String>,
    flags: &HashMap<String, String>,
) -> i32 {
    if let Err(err) = context.require_project_mode("work.transition") {
        return emit_error(err);
    }
    let short_id = match require_short_id(short_id) {
        Ok(short_id) => short_id,
        Err(err) => return emit_error(err),
    };
    let actor = match mutation_actor(context) {
        Ok(actor) => actor,
        Err(err) => return emit_error(err),
    };
    let Some(to_state) = flags.get("to") else {
        return emit_error(CliError::new(
            ErrorCode::InvalidArgument,
            "work transition requires --to <open|in_progress|blocked|completed|failed|cancelled>",
        ));
    };
    if work_service::WorkItemState::parse(to_state).is_none() {
        return emit_error(
            CliError::new(
                ErrorCode::InvalidArgument,
                format!(
                    "Unknown state '{}'; expected one of open|in_progress|blocked|completed|failed|cancelled",
                    to_state
                ),
            )
            .with_details(serde_json::json!({ "field": "--to", "value": to_state })),
        );
    }
    if to_state == "in_progress" {
        return emit_error(CliError::new(
            ErrorCode::InvalidTransition,
            "in_progress is only entered via work claim",
        ));
    }
    let expected_revision = flags
        .get("expected-revision")
        .and_then(|value| value.parse::<i64>().ok());
    if flags.contains_key("standalone") || standalone_fallback_item(context, &short_id).is_some() {
        let caller_session = context
            .session_ref
            .as_ref()
            .map(|session| session.external_id.clone());
        return match work_service::transition_standalone_work_item(
            context.org_id.as_deref(),
            &short_id,
            to_state,
            flags.get("reason").map(String::as_str),
            Some(&actor),
            expected_revision,
            caller_session.as_deref(),
        ) {
            Ok(item) => emit_success(item_to_wire(&item, None), None, None),
            Err(err) => emit_error(CliError::from_service(err)),
        };
    }
    let scope = match context.require_scope() {
        Ok(scope) => scope.to_string(),
        Err(err) => return emit_error(err),
    };
    let canonical = serde_json::json!({
        "op": "work.transition",
        "shortId": short_id,
        "to": to_state,
        "reason": flags.get("reason"),
        "expectedRevision": expected_revision,
    });
    let scope_for_exec = scope.clone();
    let short_id_for_exec = short_id.clone();
    let to_state_owned = to_state.clone();
    let reason = flags.get("reason").cloned();
    let actor_for_exec = actor.clone();
    let caller_session = context
        .session_ref
        .as_ref()
        .map(|session| session.external_id.clone());
    let result = guarded(
        &actor.id,
        "work.transition",
        &scope,
        flags.get("idempotency-key"),
        canonical,
        move || {
            let item = work_service::transition_project_work_item_scoped(
                &scope_for_exec,
                &short_id_for_exec,
                &to_state_owned,
                reason.as_deref(),
                Some(&actor_for_exec),
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
