//! `context` and the eight `work` commands (`orgtrack/v1` §13).
//!
//! Wire-shape residuals during migration, documented against the frozen
//! contract:
//! - work items serialize their store shape (legacy status vocabulary +
//!   snake_case frontmatter) plus a `portableState` projection and a
//!   `revision`; the full portable shape lands with the Phase 7 UI
//!   switch.
//! - `--ready` filters on portable `open` with no active claim; the
//!   dependency graph (`dependsOn`) arrives with the Routine rebuild.
//! - `claim` composes the execution-lock acquire with the strict
//!   `open -> in_progress` transition; the lock is rolled back when the
//!   transition is rejected. Single-transaction claim replaces this
//!   composition when the claim service handler lands.
//! - `--idempotency-key` is accepted but not yet deduplicated
//!   (`pm_idempotency` wiring is the next slice).

use std::collections::HashMap;

use project_management::projects::io as pio;
use project_management::projects::types::{
    WorkItemData, WorkItemExecutionLockReason, WorkItemMutationActor, WorkItemPartialUpdate,
};
use project_management::work_service;

use crate::context::{ExecutionContext, ProductMode};
use crate::envelope::{emit_error, emit_success, CliError, ErrorCode};

pub fn cmd_context(context: &ExecutionContext) -> i32 {
    emit_success(crate::context::to_wire(context), None, None)
}

fn mutation_actor(context: &ExecutionContext) -> Result<WorkItemMutationActor, CliError> {
    let actor = context.require_actor()?;
    Ok(WorkItemMutationActor {
        id: format!("{}:{}", actor.kind, actor.id),
        name: actor.id.clone(),
    })
}

fn item_to_wire(item: &WorkItemData, revision: Option<i64>) -> serde_json::Value {
    let portable = work_service::state::map_legacy_status(&item.frontmatter.status)
        .map(|state| state.as_str());
    let mut value = serde_json::to_value(item).unwrap_or_default();
    if let Some(object) = value.as_object_mut() {
        object.insert("portableState".into(), serde_json::json!(portable));
        object.insert("revision".into(), serde_json::json!(revision));
    }
    value
}

pub fn dispatch_work(
    context: &ExecutionContext,
    positionals: &[String],
    flags: &HashMap<String, String>,
) -> i32 {
    match positionals.first().map(String::as_str) {
        Some("list") => cmd_work_list(context, flags),
        Some("show") => cmd_work_show(context, positionals.get(1)),
        Some("create") => cmd_work_create(context, flags),
        Some("update") => cmd_work_update(context, positionals.get(1), flags),
        Some("claim") => cmd_work_claim(context, positionals.get(1), flags),
        Some("transition") => cmd_work_transition(context, positionals.get(1), flags),
        Some("note") => cmd_work_note(context, positionals.get(1), flags),
        Some("relate") => cmd_work_relate(context, positionals.get(1), flags),
        other => emit_error(CliError::new(
            ErrorCode::InvalidArgument,
            format!(
                "Unknown work subcommand '{}'; expected list|show|create|update|claim|transition|note|relate",
                other.unwrap_or("<none>")
            ),
        )),
    }
}

/// Idempotency guard for mutation commands (§14.4): when the caller
/// passed `--idempotency-key`, the operation runs at most once per
/// `(actor, operation, scope, key)`; a replay returns the stored wire
/// data without re-executing.
fn guarded(
    actor_id: &str,
    operation: &'static str,
    scope: &str,
    idempotency_key: Option<&String>,
    canonical: serde_json::Value,
    execute: impl FnOnce() -> Result<serde_json::Value, String>,
) -> Result<serde_json::Value, CliError> {
    match idempotency_key {
        None => execute().map_err(CliError::from_service),
        Some(key) => {
            match work_service::run_idempotent(actor_id, operation, scope, key, &canonical, execute)
            {
                Ok(work_service::IdempotencyOutcome::Fresh(value))
                | Ok(work_service::IdempotencyOutcome::Replayed(value)) => Ok(value),
                Err(err) => Err(CliError::from_service(err)),
            }
        }
    }
}

fn require_short_id(short_id: Option<&String>) -> Result<String, CliError> {
    short_id.cloned().ok_or_else(|| {
        CliError::new(
            ErrorCode::InvalidArgument,
            "Missing work item id (usage: org2 work <cmd> <short-id> ...)",
        )
    })
}

fn cmd_work_list(context: &ExecutionContext, flags: &HashMap<String, String>) -> i32 {
    let scope = match context.require_scope() {
        Ok(scope) => scope.to_string(),
        Err(err) => return emit_error(err),
    };
    let items = match pio::read_all_work_items(&scope) {
        Ok(items) => items,
        Err(err) => return emit_error(CliError::from_service(err)),
    };
    let status_filter = flags.get("status");
    let ready_only = flags.contains_key("ready");
    let limit: usize = flags
        .get("limit")
        .and_then(|value| value.parse().ok())
        .unwrap_or(50);

    let filtered: Vec<serde_json::Value> = items
        .iter()
        .filter(|item| item.frontmatter.deleted_at.is_none())
        .filter(|item| {
            status_filter
                .map(|status| &item.frontmatter.status == status)
                .unwrap_or(true)
        })
        .filter(|item| {
            if !ready_only {
                return true;
            }
            // Ready = portable open with no active claim. Dependency
            // readiness joins in when dependsOn lands (Phase 4).
            let open = matches!(
                work_service::state::map_legacy_status(&item.frontmatter.status),
                Some(work_service::WorkItemState::Open)
            );
            let unclaimed = item
                .frontmatter
                .execution_lock
                .as_ref()
                .and_then(|lock| lock.active_session_id.as_ref())
                .is_none();
            open && unclaimed
        })
        .take(limit)
        .map(|item| item_to_wire(item, None))
        .collect();

    emit_success(serde_json::json!({ "items": filtered }), None, None)
}

fn cmd_work_show(context: &ExecutionContext, short_id: Option<&String>) -> i32 {
    let scope = match context.require_scope() {
        Ok(scope) => scope.to_string(),
        Err(err) => return emit_error(err),
    };
    let short_id = match require_short_id(short_id) {
        Ok(short_id) => short_id,
        Err(err) => return emit_error(err),
    };
    let item = match pio::read_work_item(&scope, &short_id) {
        Ok(item) => item,
        Err(err) => return emit_error(CliError::from_service(err)),
    };
    let revision = work_service::read_project_work_item_revision(&scope, &short_id).ok();
    let relations = work_service::list_work_item_relations(&short_id).unwrap_or_default();
    let mut wire = item_to_wire(&item, revision);
    if let Some(object) = wire.as_object_mut() {
        object.insert("relations".into(), serde_json::json!(relations));
    }
    emit_success(wire, revision, None)
}

fn cmd_work_create(context: &ExecutionContext, flags: &HashMap<String, String>) -> i32 {
    if let Err(err) = context.require_project_mode("work.create") {
        return emit_error(err);
    }
    let scope = match context.require_scope() {
        Ok(scope) => scope.to_string(),
        Err(err) => return emit_error(err),
    };
    let actor = match mutation_actor(context) {
        Ok(actor) => actor,
        Err(err) => return emit_error(err),
    };
    let Some(title) = flags.get("title").filter(|value| !value.trim().is_empty()) else {
        return emit_error(CliError::new(
            ErrorCode::InvalidArgument,
            "work create requires --title",
        ));
    };
    let canonical = serde_json::json!({
        "op": "work.create",
        "title": title,
        "body": flags.get("body"),
        "status": flags.get("status"),
        "priority": flags.get("priority"),
    });
    let request = work_service::CreateWorkItemRequest {
        title: title.clone(),
        body: flags.get("body").cloned().unwrap_or_default(),
        status: flags.get("status").cloned(),
        priority: flags.get("priority").cloned(),
        created_by: Some(actor.id.clone()),
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

fn cmd_work_update(
    context: &ExecutionContext,
    short_id: Option<&String>,
    flags: &HashMap<String, String>,
) -> i32 {
    if let Err(err) = context.require_project_mode("work.update") {
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
    if flags.contains_key("status") || flags.contains_key("to") {
        // work.update is non-lifecycle by contract; state changes go
        // through work.transition (and claim for open -> in_progress).
        return emit_error(CliError::new(
            ErrorCode::InvalidArgument,
            "work update does not change state; use work transition --to <state>",
        ));
    }
    let updates = WorkItemPartialUpdate {
        title: flags.get("title").cloned(),
        body: flags.get("body").cloned(),
        priority: flags.get("priority").cloned(),
        actor: Some(actor),
        ..Default::default()
    };
    match pio::update_work_item_partial(&scope, &short_id, &updates) {
        Ok(item) => {
            let revision = work_service::read_project_work_item_revision(&scope, &short_id).ok();
            emit_success(item_to_wire(&item, revision), revision, None)
        }
        Err(err) => emit_error(CliError::from_service(err)),
    }
}

fn cmd_work_claim(
    context: &ExecutionContext,
    short_id: Option<&String>,
    flags: &HashMap<String, String>,
) -> i32 {
    if let Err(err) = context.require_project_mode("work.claim") {
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
            "work claim requires --session-ref <provider:id> (claim records the executing session)",
        ));
    };
    if let Err(err) = project_management::provider_host::validate_session_ref(
        &session_ref.provider,
        &session_ref.external_id,
    ) {
        return emit_error(
            CliError::new(ErrorCode::InvalidArgument, err).with_details(serde_json::json!({
                "field": "--session-ref",
                "provider": session_ref.provider,
            })),
        );
    }
    let expected_revision = flags
        .get("expected-revision")
        .and_then(|value| value.parse::<i64>().ok());

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
            // Acquire the claim record first (CAS — fails when another
            // session holds it), then the strict open -> in_progress
            // transition; roll the lock back if the transition is rejected.
            pio::acquire_execution_lock(
                &scope_for_exec,
                &short_id_for_exec,
                &session_id,
                Some("custom"),
                WorkItemExecutionLockReason::ManualStart,
            )?;
            match work_service::transition_project_work_item(
                &scope_for_exec,
                &short_id_for_exec,
                "in_progress",
                Some("claimed"),
                Some(&actor_for_exec),
                expected_revision,
            ) {
                Ok(item) => {
                    let revision = work_service::read_project_work_item_revision(
                        &scope_for_exec,
                        &short_id_for_exec,
                    )
                    .ok();
                    Ok(item_to_wire(&item, revision))
                }
                Err(err) => {
                    let _ = pio::release_execution_lock(
                        &scope_for_exec,
                        &short_id_for_exec,
                        &session_id,
                    );
                    Err(err)
                }
            }
        },
    );
    match result {
        Ok(wire) => emit_success(wire, None, None),
        Err(err) => emit_error(err),
    }
}

fn cmd_work_transition(
    context: &ExecutionContext,
    short_id: Option<&String>,
    flags: &HashMap<String, String>,
) -> i32 {
    if let Err(err) = context.require_project_mode("work.transition") {
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
        // §9.3: in_progress is only entered via work.claim (or
        // blocked -> in_progress resume, which claim also covers).
        return emit_error(CliError::new(
            ErrorCode::InvalidTransition,
            "in_progress is only entered via work claim",
        ));
    }
    let expected_revision = flags
        .get("expected-revision")
        .and_then(|value| value.parse::<i64>().ok());
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
    let result = guarded(
        &actor.id,
        "work.transition",
        &scope,
        flags.get("idempotency-key"),
        canonical,
        move || {
            let item = work_service::transition_project_work_item(
                &scope_for_exec,
                &short_id_for_exec,
                &to_state_owned,
                reason.as_deref(),
                Some(&actor_for_exec),
                expected_revision,
            )?;
            let revision = work_service::read_project_work_item_revision(
                &scope_for_exec,
                &short_id_for_exec,
            )
            .ok();
            Ok(item_to_wire(&item, revision))
        },
    );
    match result {
        Ok(wire) => emit_success(wire, None, None),
        Err(err) => emit_error(err),
    }
}

fn cmd_work_note(
    context: &ExecutionContext,
    short_id: Option<&String>,
    flags: &HashMap<String, String>,
) -> i32 {
    if let Err(err) = context.require_project_mode("work.note") {
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
    let Some(body) = flags.get("body").filter(|value| !value.trim().is_empty()) else {
        return emit_error(CliError::new(
            ErrorCode::InvalidArgument,
            "work note requires --body",
        ));
    };
    let kind = flags
        .get("kind")
        .map(String::as_str)
        .unwrap_or("comment");
    const KINDS: &[&str] = &["comment", "progress", "blocker", "decision", "handoff", "review"];
    if !KINDS.contains(&kind) {
        return emit_error(CliError::new(
            ErrorCode::InvalidArgument,
            format!(
                "Unknown note kind '{}'; expected comment|progress|blocker|decision|handoff|review",
                kind
            ),
        ));
    }
    match work_service::note_project_work_item(&scope, &short_id, kind, body, Some(&actor)) {
        Ok(()) => emit_success(serde_json::json!({ "appended": true, "kind": kind }), None, None),
        Err(err) => emit_error(CliError::from_service(err)),
    }
}

fn cmd_work_relate(
    context: &ExecutionContext,
    short_id: Option<&String>,
    flags: &HashMap<String, String>,
) -> i32 {
    if let Err(err) = context.require_project_mode("work.relate") {
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
    let (Some(kind), Some(target)) = (flags.get("type"), flags.get("target")) else {
        return emit_error(CliError::new(
            ErrorCode::InvalidArgument,
            "work relate requires --type <relation> and --target <ref>",
        ));
    };
    // session:// targets must name a registered provenance provider in
    // the canonical namespace (reference-only validation, §15.6).
    if let Some(rest) = target.strip_prefix("session://") {
        let (provider, external_id) = rest.split_once('/').unwrap_or((rest, ""));
        if let Err(err) =
            project_management::provider_host::validate_session_ref(provider, external_id)
        {
            return emit_error(
                CliError::new(ErrorCode::InvalidArgument, err).with_details(serde_json::json!({
                    "field": "--target",
                    "provider": provider,
                })),
            );
        }
    }
    match work_service::relate_project_work_item(&scope, &short_id, kind, target, Some(&actor)) {
        Ok(()) => emit_success(
            serde_json::json!({ "related": true, "kind": kind, "targetRef": target }),
            None,
            None,
        ),
        Err(err) => {
            if err.contains("is not portable") {
                return emit_error(
                    CliError::new(
                        ErrorCode::InvalidArgument,
                        format!(
                            "Relation kind '{}' is not portable (depends_on|relates_to|duplicates|implements|supersedes|continued_by|generated_by|participated_in)",
                            kind
                        ),
                    )
                    .with_details(serde_json::json!({ "field": "--type", "value": kind })),
                );
            }
            emit_error(CliError::from_service(err))
        }
    }
}

// ============================================
// Routine commands (§13.3)
// ============================================

use project_management::routine_service;

fn load_spec_file(path: &str) -> Result<routine_service::spec::RoutineSpecFile, CliError> {
    let raw = std::fs::read_to_string(path).map_err(|err| {
        CliError::new(
            ErrorCode::InvalidArgument,
            format!("Cannot read routine file '{}': {}", path, err),
        )
    })?;
    // YAML is a superset of JSON here: one parser handles both authoring
    // formats; the canonical stored form is always JSON.
    serde_yaml::from_str(&raw).map_err(|err| {
        CliError::new(
            ErrorCode::InvalidArgument,
            format!("Routine file '{}' does not match the portable spec: {}", path, err),
        )
    })
}

fn routine_error(err: String) -> CliError {
    if let Some(details) = err.strip_prefix(routine_service::error::SPEC_INVALID) {
        let violations: serde_json::Value =
            serde_json::from_str(details.trim_start_matches(':')).unwrap_or_default();
        return CliError::new(
            ErrorCode::InvalidArgument,
            "Routine spec failed validation",
        )
        .with_details(serde_json::json!({ "violations": violations }));
    }
    if let Some(rest) = err.strip_prefix(routine_service::error::INPUTS_INVALID) {
        return CliError::new(
            ErrorCode::InvalidArgument,
            format!("Routine inputs invalid: {}", rest.trim_start_matches(':')),
        );
    }
    CliError::from_service(err)
}

pub fn dispatch_routine(
    context: &ExecutionContext,
    positionals: &[String],
    flags: &HashMap<String, String>,
    inputs: &[(String, String)],
) -> i32 {
    match positionals.first().map(String::as_str) {
        Some("list") => match routine_service::list_routines() {
            Ok(rows) => emit_success(serde_json::json!({ "items": rows }), None, None),
            Err(err) => emit_error(CliError::from_service(err)),
        },
        Some("validate") => {
            let Some(path) = flags.get("file") else {
                return emit_error(CliError::new(
                    ErrorCode::InvalidArgument,
                    "routine validate requires --file <path>",
                ));
            };
            let file = match load_spec_file(path) {
                Ok(file) => file,
                Err(err) => return emit_error(err),
            };
            let violations = routine_service::spec::validate(&file);
            if violations.is_empty() {
                emit_success(serde_json::json!({ "valid": true }), None, None)
            } else {
                emit_error(
                    CliError::new(ErrorCode::InvalidArgument, "Routine spec failed validation")
                        .with_details(serde_json::json!({
                            "violations": serde_json::to_value(&violations).unwrap_or_default(),
                        })),
                )
            }
        }
        Some("apply") => {
            if let Err(err) = context.require_project_mode("routine.apply") {
                return emit_error(err);
            }
            let Some(path) = flags.get("file") else {
                return emit_error(CliError::new(
                    ErrorCode::InvalidArgument,
                    "routine apply requires --file <path>",
                ));
            };
            let file = match load_spec_file(path) {
                Ok(file) => file,
                Err(err) => return emit_error(err),
            };
            match routine_service::apply(&file) {
                Ok(applied) => emit_success(
                    serde_json::json!({
                        "name": applied.name,
                        "revision": applied.revision,
                        "specHash": applied.spec_hash,
                        "changed": applied.changed,
                    }),
                    Some(applied.revision),
                    None,
                ),
                Err(err) => emit_error(routine_error(err)),
            }
        }
        Some("run") => {
            if let Err(err) = context.require_project_mode("routine.run") {
                return emit_error(err);
            }
            let scope = match context.require_scope() {
                Ok(scope) => scope.to_string(),
                Err(err) => return emit_error(err),
            };
            let actor = match mutation_actor(context) {
                Ok(actor) => actor,
                Err(err) => return emit_error(err),
            };
            let Some(name) = positionals.get(1) else {
                return emit_error(CliError::new(
                    ErrorCode::InvalidArgument,
                    "Usage: org2 routine run <name> --input k=v ...",
                ));
            };
            let input_map: std::collections::BTreeMap<String, String> =
                inputs.iter().cloned().collect();
            match routine_service::invoke(name, &scope, &input_map, Some(&actor)) {
                Ok(run) => emit_success(
                    serde_json::json!({
                        "runId": run.run_id,
                        "rootWorkItemId": run.root_short_id,
                        "steps": run
                            .steps
                            .iter()
                            .map(|(step, short_id)| serde_json::json!({
                                "stepId": step,
                                "workItemId": short_id,
                            }))
                            .collect::<Vec<_>>(),
                    }),
                    None,
                    None,
                ),
                Err(err) => emit_error(routine_error(err)),
            }
        }
        Some("status") => {
            let Some(run_id) = positionals.get(1) else {
                return emit_error(CliError::new(
                    ErrorCode::InvalidArgument,
                    "Usage: org2 routine status <run-id>",
                ));
            };
            match routine_service::run_status(run_id) {
                Ok(view) => emit_success(view, None, None),
                Err(err) => emit_error(CliError::from_service(err)),
            }
        }
        Some(action @ ("enable" | "disable")) => {
            if let Err(err) = context.require_project_mode("routine.set_enabled") {
                return emit_error(err);
            }
            let Some(name) = positionals.get(1) else {
                return emit_error(CliError::new(
                    ErrorCode::InvalidArgument,
                    format!("Usage: org2 routine {} <name>", action),
                ));
            };
            match routine_service::set_enabled(name, action == "enable") {
                Ok(()) => emit_success(
                    serde_json::json!({ "name": name, "enabled": action == "enable" }),
                    None,
                    None,
                ),
                Err(err) => emit_error(CliError::from_service(err)),
            }
        }
        Some("cancel") => emit_error(CliError::new(
            ErrorCode::UnsupportedCapability,
            "routine cancel lands with the Phase 5 runtime (cancel_requested machinery)",
        )),
        other => emit_error(CliError::new(
            ErrorCode::InvalidArgument,
            format!(
                "Unknown routine subcommand '{}'; expected list|validate|apply|run|status|enable|disable",
                other.unwrap_or("<none>")
            ),
        )),
    }
}

// ProductMode is re-exported for the unused-import lint when features
// shift; keep the type referenced.
#[allow(dead_code)]
fn _mode_witness(mode: ProductMode) -> &'static str {
    mode.as_str()
}
