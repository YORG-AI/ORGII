use std::collections::HashMap;

use project_management::projects::types::WorkItemExecutionLockReason;
use project_management::work_service;

use super::{item_to_wire, require_short_id, standalone_fallback_item};
use crate::commands::{guarded, mutation_actor};
use crate::context::ExecutionContext;
use crate::envelope::{emit_error, emit_success, CliError, ErrorCode};

pub(super) fn assign(
    context: &ExecutionContext,
    short_id: Option<&String>,
    flags: &HashMap<String, String>,
) -> i32 {
    if let Err(err) = context.require_project_mode("work.assign") {
        return emit_error(err);
    }
    let scope = match context.require_scope() {
        Ok(scope) => scope.to_string(),
        Err(err) => return emit_error(err),
    };
    let short_id = match require_short_id(short_id) {
        Ok(short_id) => short_id,
        Err(err) => return emit_error(err),
    };
    let actor = match mutation_actor(context) {
        Ok(actor) => actor,
        Err(err) => return emit_error(err),
    };
    let Some(assignee) = flags.get("actor-target").or_else(|| flags.get("assignee")) else {
        return emit_error(CliError::new(
            ErrorCode::InvalidArgument,
            "work assign requires --assignee <kind:id>",
        ));
    };
    let (assignee_type, assignee_id) = match assignee.split_once(':') {
        Some((kind, id)) if matches!(kind, "human" | "agent") && !id.is_empty() => (kind, id),
        _ => {
            return emit_error(CliError::new(
                ErrorCode::InvalidArgument,
                "work assign --assignee must be human:<id> or agent:<id>",
            ));
        }
    };
    let expected_revision = flags
        .get("expected-revision")
        .and_then(|value| value.parse::<i64>().ok());
    let canonical = serde_json::json!({
        "op": "work.assign",
        "shortId": short_id,
        "assignee": assignee,
        "expectedRevision": expected_revision,
    });
    let scope_for_exec = scope.clone();
    let short_id_for_exec = short_id.clone();
    let assignee_id = assignee_id.to_string();
    let assignee_type = assignee_type.to_string();
    let result = guarded(
        &actor.id.clone(),
        "work.assign",
        &scope,
        flags.get("idempotency-key"),
        canonical,
        move || {
            let item = work_service::assign_project_work_item(
                &scope_for_exec,
                &short_id_for_exec,
                &assignee_id,
                Some(&assignee_type),
                Some(&actor),
                expected_revision,
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

pub(super) fn release(
    context: &ExecutionContext,
    short_id: Option<&String>,
    flags: &HashMap<String, String>,
) -> i32 {
    if let Err(err) = context.require_project_mode("work.release") {
        return emit_error(err);
    }
    let scope = match context.require_scope() {
        Ok(scope) => scope.to_string(),
        Err(err) => return emit_error(err),
    };
    let short_id = match require_short_id(short_id) {
        Ok(short_id) => short_id,
        Err(err) => return emit_error(err),
    };
    let actor = match mutation_actor(context) {
        Ok(actor) => actor,
        Err(err) => return emit_error(err),
    };
    let Some(session_ref) = context.session_ref.as_ref() else {
        return emit_error(CliError::new(
            ErrorCode::InvalidArgument,
            "work release requires --session-ref <provider:id> (only the claim holder releases)",
        ));
    };
    let canonical = serde_json::json!({
        "op": "work.release",
        "shortId": short_id,
        "sessionRef": format!("{}:{}", session_ref.provider, session_ref.external_id),
    });
    let scope_for_exec = scope.clone();
    let short_id_for_exec = short_id.clone();
    let session_id = session_ref.external_id.clone();
    let result = guarded(
        &actor.id.clone(),
        "work.release",
        &scope,
        flags.get("idempotency-key"),
        canonical,
        move || {
            let item = work_service::release_project_work_item(
                &scope_for_exec,
                &short_id_for_exec,
                &session_id,
                Some(&actor),
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

pub(super) fn claim(
    context: &ExecutionContext,
    short_id: Option<&String>,
    flags: &HashMap<String, String>,
) -> i32 {
    if let Err(err) = context.require_project_mode("work.claim") {
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
    let Some(session_ref) = context.session_ref.as_ref() else {
        return emit_error(CliError::new(
            ErrorCode::InvalidArgument,
            "work claim requires --session-ref <provider:id> (claim records the executing session)",
        ));
    };
    if let Err(err) = project_management::provider_host::validate_session_ref(
        &session_ref.provider,
        &session_ref.external_id,
    ) {
        return emit_error(CliError::new(ErrorCode::InvalidArgument, err).with_details(
            serde_json::json!({
                "field": "--session-ref",
                "provider": session_ref.provider,
            }),
        ));
    }
    let expected_revision = flags
        .get("expected-revision")
        .and_then(|value| value.parse::<i64>().ok());
    if flags.contains_key("standalone") || standalone_fallback_item(context, &short_id).is_some() {
        return match work_service::claim_standalone_work_item(
            context.org_id.as_deref(),
            &short_id,
            &session_ref.external_id,
            Some("custom"),
            WorkItemExecutionLockReason::ManualStart,
            Some(&actor),
            expected_revision,
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
        "op": "work.claim",
        "shortId": short_id,
        "sessionRef": format!("{}:{}", session_ref.provider, session_ref.external_id),
        "expectedRevision": expected_revision,
    });
    let scope_for_exec = scope.clone();
    let short_id_for_exec = short_id.clone();
    let session_id = session_ref.external_id.clone();
    let actor_for_exec = actor.clone();
    let result = guarded(
        &actor.id,
        "work.claim",
        &scope,
        flags.get("idempotency-key"),
        canonical,
        move || {
            let item = work_service::claim_project_work_item(
                &scope_for_exec,
                &short_id_for_exec,
                &session_id,
                Some("custom"),
                WorkItemExecutionLockReason::ManualStart,
                Some(&actor_for_exec),
                expected_revision,
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
