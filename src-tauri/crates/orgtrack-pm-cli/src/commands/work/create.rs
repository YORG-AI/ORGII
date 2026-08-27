use std::collections::HashMap;

use project_management::projects::io as pio;
use project_management::projects::types::WorkItemSchedule;
use project_management::work_service;

use super::{item_to_wire, resolve_body_flag, uses_standalone_scope};
use crate::commands::{guarded, mutation_actor, origin_session};
use crate::context::ExecutionContext;
use crate::envelope::{emit_error, emit_success, CliError, ErrorCode};

pub(super) fn run(context: &ExecutionContext, flags: &HashMap<String, String>) -> i32 {
    if let Err(err) = context.require_project_mode("work.create") {
        return emit_error(err);
    }
    let actor = match mutation_actor(context) {
        Ok(actor) => actor,
        Err(err) => return emit_error(err),
    };
    let origin_session = origin_session(context, &actor);
    let Some(title) = flags.get("title").filter(|value| !value.trim().is_empty()) else {
        return emit_error(CliError::new(
            ErrorCode::InvalidArgument,
            "work create requires --title",
        ));
    };
    let schedule = match (flags.get("schedule-cron"), flags.get("schedule-at")) {
        (None, None) => None,
        (cron, at) => Some(WorkItemSchedule {
            at: at.cloned(),
            cron: cron.cloned(),
            enabled: true,
            last_run: None,
        }),
    };
    let parent = flags
        .get("parent")
        .filter(|value| !value.trim().is_empty())
        .cloned();
    let stage = match flags.get("stage") {
        None => None,
        Some(raw) => match raw.trim().parse::<u32>() {
            Ok(value) if value >= 1 => Some(value),
            _ => {
                return emit_error(
                    CliError::new(
                        ErrorCode::InvalidArgument,
                        format!("Invalid --stage '{}'; expected a positive integer", raw),
                    )
                    .with_details(serde_json::json!({ "field": "--stage", "value": raw })),
                )
            }
        },
    };
    let body_flag = match resolve_body_flag(flags) {
        Ok(body) => body,
        Err(err) => return emit_error(err),
    };
    if uses_standalone_scope(context, flags) {
        let org = context.org_id.clone();
        let request = work_service::CreateWorkItemRequest {
            title: title.clone(),
            body: body_flag.clone().unwrap_or_default(),
            status: flags.get("status").cloned(),
            priority: flags.get("priority").cloned(),
            created_by: Some(actor.id.clone()),
            origin_session: origin_session.clone(),
            schedule: schedule.clone(),
            parent: parent.clone(),
            stage,
            ..Default::default()
        };
        let result = (|| {
            let short_id = pio::allocate_standalone_short_id(org.as_deref())
                .map_err(CliError::from_service)?;
            let item = work_service::create_standalone_work_item(
                org.as_deref(),
                &short_id,
                &request,
                Some(&actor),
            )
            .map_err(CliError::from_service)?;
            Ok::<_, CliError>(item_to_wire(&item, None))
        })();
        return match result {
            Ok(wire) => emit_success(wire, None, None),
            Err(err) => emit_error(err),
        };
    }
    let scope = match context.require_scope() {
        Ok(scope) => scope.to_string(),
        Err(err) => return emit_error(err),
    };
    let canonical = serde_json::json!({
        "op": "work.create",
        "title": title,
        "body": body_flag,
        "status": flags.get("status"),
        "priority": flags.get("priority"),
    });
    let request = work_service::CreateWorkItemRequest {
        title: title.clone(),
        body: body_flag.clone().unwrap_or_default(),
        status: flags.get("status").cloned(),
        priority: flags.get("priority").cloned(),
        created_by: Some(actor.id.clone()),
        origin_session,
        schedule,
        parent,
        stage,
        ..Default::default()
    };
    let scope_for_exec = scope.clone();
    let actor_for_exec = actor.clone();
    let result = guarded(
        &actor.id,
        "work.create",
        &scope,
        flags.get("idempotency-key"),
        canonical,
        move || {
            let short_id = pio::allocate_short_id(&scope_for_exec)?;
            let item = work_service::create_project_work_item(
                &scope_for_exec,
                &short_id,
                &request,
                Some(&actor_for_exec),
            )?;
            let revision =
                work_service::read_project_work_item_revision(&scope_for_exec, &short_id).ok();
            Ok(item_to_wire(&item, revision))
        },
    );
    match result {
        Ok(wire) => emit_success(wire, None, None),
        Err(err) => emit_error(err),
    }
}
