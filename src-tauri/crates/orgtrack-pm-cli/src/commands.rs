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
//! - `--idempotency-key` deduplicates every mutation via `pm_idempotency`
//!   (`pm_idempotency` wiring is the next slice).

use std::collections::HashMap;

use project_management::projects::io as pio;
use project_management::projects::types::{
    WorkItemData, WorkItemExecutionLockReason, WorkItemMutationActor, WorkItemOriginSession,
    WorkItemSchedule,
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

fn origin_session(
    context: &ExecutionContext,
    actor: &WorkItemMutationActor,
) -> Option<WorkItemOriginSession> {
    context
        .session_ref
        .as_ref()
        .map(|session| WorkItemOriginSession {
            session_id: session.external_id.clone(),
            provider: session.provider.clone(),
            actor_id: actor.id.clone(),
            session_type: if session.external_id.starts_with("cliagent-") {
                "cli".to_string()
            } else {
                "native".to_string()
            },
            captured_at: chrono::Utc::now().to_rfc3339(),
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
        Some("show") => cmd_work_show(context, positionals.get(1), flags),
        Some("create") => cmd_work_create(context, flags),
        Some("update") => cmd_work_update(context, positionals.get(1), flags),
        Some("assign") => cmd_work_assign(context, positionals.get(1), flags),
        Some("release") => cmd_work_release(context, positionals.get(1), flags),
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

/// Body text from `--body` or `--body-file <path>` (file wins). Shell
/// quoting mangles backticks/`$()` in inline bodies; agents write the
/// body to a file and pass the path instead.
fn resolve_body_flag(flags: &HashMap<String, String>) -> Result<Option<String>, CliError> {
    if let Some(path) = flags
        .get("body-file")
        .filter(|value| !value.trim().is_empty())
    {
        return std::fs::read_to_string(path).map(Some).map_err(|err| {
            CliError::new(
                ErrorCode::InvalidArgument,
                format!("--body-file {path}: {err}"),
            )
        });
    }
    Ok(flags.get("body").cloned())
}

/// Route a bare short id to the org's standalone store when it cannot be
/// served from a project scope: either no scope resolves at all, or the
/// resolved project has no such item while a standalone row exists. Lets
/// a session bound to a standalone root item (Project-mode bootstrap)
/// address it without knowing the `--standalone` flag.
fn standalone_fallback_item(context: &ExecutionContext, short_id: &str) -> Option<WorkItemData> {
    let org = context.org_id.as_deref();
    match context.require_scope() {
        Err(_) => pio::read_standalone_work_item(org, short_id).ok(),
        Ok(scope) => match pio::read_work_item(scope, short_id) {
            Ok(_) => None,
            Err(_) => pio::read_standalone_work_item(org, short_id).ok(),
        },
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

/// A missing project scope is the canonical org-level Work Item scope, not an
/// incomplete context. `--standalone` remains useful when a project-scoped
/// session intentionally targets an org-level item, but projectless sessions
/// should not need to know or spell an implementation flag.
fn uses_standalone_scope(context: &ExecutionContext, flags: &HashMap<String, String>) -> bool {
    flags.contains_key("standalone") || context.scope_id.is_none()
}

fn cmd_work_list(context: &ExecutionContext, flags: &HashMap<String, String>) -> i32 {
    let items = if uses_standalone_scope(context, flags) {
        match pio::read_standalone_work_items(context.org_id.as_deref()) {
            Ok(items) => items,
            Err(err) => return emit_error(CliError::from_service(err)),
        }
    } else {
        let scope = match context.require_scope() {
            Ok(scope) => scope.to_string(),
            Err(err) => return emit_error(err),
        };
        match pio::read_all_work_items(&scope) {
            Ok(items) => items,
            Err(err) => return emit_error(CliError::from_service(err)),
        }
    };
    let status_filter = match flags.get("status") {
        None => None,
        Some(raw) => match parse_portable_state(raw) {
            Ok(state) => Some(state),
            Err(err) => return emit_error(err),
        },
    };
    let ready_only = flags.contains_key("ready");
    let limit: usize = flags
        .get("limit")
        .and_then(|value| value.parse().ok())
        .unwrap_or(50);
    let cursor = flags.get("cursor").cloned();

    let mut sorted: Vec<_> = items.iter().collect();
    sorted.sort_by(|a, b| a.frontmatter.short_id.cmp(&b.frontmatter.short_id));
    let mut matched: Vec<&_> = sorted
        .into_iter()
        .filter(|item| item.frontmatter.deleted_at.is_none())
        .filter(|item| {
            cursor
                .as_deref()
                .map(|last| item.frontmatter.short_id.as_str() > last)
                .unwrap_or(true)
        })
        .filter(|item| {
            status_filter
                .map(|state| {
                    work_service::state::map_legacy_status(&item.frontmatter.status) == Some(state)
                })
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
        .collect();
    let next_cursor = if matched.len() > limit {
        matched
            .get(limit - 1)
            .map(|item| item.frontmatter.short_id.clone())
    } else {
        None
    };
    matched.truncate(limit);
    let filtered: Vec<serde_json::Value> = matched
        .iter()
        .map(|item| item_to_wire(item, None))
        .collect();

    emit_success(serde_json::json!({ "items": filtered }), None, next_cursor)
}

fn parse_portable_state(raw: &str) -> Result<work_service::WorkItemState, CliError> {
    use work_service::WorkItemState::*;
    match raw {
        "open" => Ok(Open),
        "in_progress" => Ok(InProgress),
        "blocked" => Ok(Blocked),
        "completed" => Ok(Completed),
        "failed" => Ok(Failed),
        "cancelled" => Ok(Cancelled),
        other => Err(CliError::new(
            ErrorCode::InvalidArgument,
            format!(
                "Unknown state '{}'; expected open|in_progress|blocked|completed|failed|cancelled",
                other
            ),
        )),
    }
}

fn cmd_work_show(
    context: &ExecutionContext,
    short_id: Option<&String>,
    flags: &HashMap<String, String>,
) -> i32 {
    let short_id = match require_short_id(short_id) {
        Ok(short_id) => short_id,
        Err(err) => return emit_error(err),
    };
    if uses_standalone_scope(context, flags) {
        let org = context.org_id.as_deref();
        let item = match pio::read_standalone_work_item(org, &short_id) {
            Ok(item) => item,
            Err(err) => return emit_error(CliError::from_service(err)),
        };
        let wire = item_to_wire(&item, None);
        return emit_success(wire, None, None);
    }
    if let Some(item) = standalone_fallback_item(context, &short_id) {
        let relations = work_service::list_work_item_relations(&short_id).unwrap_or_default();
        let mut wire = item_to_wire(&item, None);
        if let Some(object) = wire.as_object_mut() {
            object.insert("relations".into(), serde_json::json!(relations));
        }
        return emit_success(wire, None, None);
    }
    let scope = match context.require_scope() {
        Ok(scope) => scope.to_string(),
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

fn cmd_work_update(
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
        // work.update is non-lifecycle by contract; state changes go
        // through work.transition (and claim for open -> in_progress).
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

fn cmd_work_assign(
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

fn cmd_work_release(
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

fn cmd_work_claim(
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

fn cmd_work_transition(
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

fn cmd_work_note(
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
    ) {
        Ok(()) => emit_success(
            serde_json::json!({ "appended": true, "kind": kind }),
            None,
            None,
        ),
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
            return emit_error(CliError::new(ErrorCode::InvalidArgument, err).with_details(
                serde_json::json!({
                    "field": "--target",
                    "provider": provider,
                }),
            ));
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
            format!(
                "Routine file '{}' does not match the portable spec: {}",
                path, err
            ),
        )
    })
}

fn routine_error(err: String) -> CliError {
    if let Some(details) = err.strip_prefix(routine_service::error::SPEC_INVALID) {
        let violations: serde_json::Value =
            serde_json::from_str(details.trim_start_matches(':')).unwrap_or_default();
        return CliError::new(ErrorCode::InvalidArgument, "Routine spec failed validation")
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
            let invoke_key = flags.get("idempotency-key").map(String::as_str);
            match routine_service::invoke(name, &scope, &input_map, Some(&actor), invoke_key) {
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

pub fn dispatch_project(
    context: &ExecutionContext,
    positionals: &[String],
    flags: &HashMap<String, String>,
) -> i32 {
    match positionals.first().map(String::as_str) {
        Some("list") => cmd_project_list(context, flags),
        Some("show") => cmd_project_show(positionals.get(1)),
        Some("find") => cmd_project_find(positionals.get(1)),
        Some("members") => cmd_project_members(positionals.get(1)),
        Some("create") => cmd_project_create(context, flags),
        Some("update") => cmd_project_update(context, positionals.get(1), flags),
        other => emit_error(CliError::new(
            ErrorCode::InvalidArgument,
            format!(
                "Unknown project subcommand '{}'; expected list|show|find|members|create|update",
                other.unwrap_or("<none>")
            ),
        )),
    }
}

fn project_to_wire(
    project: &project_management::projects::types::ProjectData,
) -> serde_json::Value {
    serde_json::json!({
        "slug": project.slug,
        "name": project.meta.name,
        "orgId": project.meta.org_id,
        "status": project.meta.status,
        "priority": project.meta.priority,
        "lead": project.meta.lead,
        "labels": project.meta.labels,
        "workItemPrefix": project.meta.work_item_prefix,
        "createdAt": project.meta.created_at,
        "updatedAt": project.meta.updated_at,
    })
}

fn cmd_project_list(_context: &ExecutionContext, flags: &HashMap<String, String>) -> i32 {
    let org = flags.get("org").map(String::as_str);
    match pio::read_all_projects_scoped(org) {
        Ok(projects) => {
            let items: Vec<serde_json::Value> = projects.iter().map(project_to_wire).collect();
            emit_success(serde_json::json!({ "items": items }), None, None)
        }
        Err(err) => emit_error(CliError::from_service(err)),
    }
}

fn cmd_project_show(slug: Option<&String>) -> i32 {
    let Some(slug) = slug else {
        return emit_error(CliError::new(
            ErrorCode::InvalidArgument,
            "Usage: org2 project show <slug>",
        ));
    };
    match pio::read_project(slug) {
        Ok(project) => {
            let mut wire = project_to_wire(&project);
            wire["description"] = serde_json::Value::String(project.description.clone());
            emit_success(wire, None, None)
        }
        Err(err) => emit_error(CliError::from_service(err)),
    }
}

fn cmd_project_find(query: Option<&String>) -> i32 {
    let Some(query) = query else {
        return emit_error(CliError::new(
            ErrorCode::InvalidArgument,
            "Usage: org2 project find <query>",
        ));
    };
    let needle = query.to_lowercase();
    match pio::read_all_projects_scoped(None) {
        Ok(projects) => {
            let items: Vec<serde_json::Value> = projects
                .iter()
                .filter(|project| {
                    project.slug.to_lowercase().contains(&needle)
                        || project.meta.name.to_lowercase().contains(&needle)
                })
                .map(project_to_wire)
                .collect();
            emit_success(serde_json::json!({ "items": items }), None, None)
        }
        Err(err) => emit_error(CliError::from_service(err)),
    }
}

fn cmd_project_members(slug: Option<&String>) -> i32 {
    let Some(slug) = slug else {
        return emit_error(CliError::new(
            ErrorCode::InvalidArgument,
            "Usage: org2 project members <slug>",
        ));
    };
    match pio::read_project(slug) {
        Ok(project) => emit_success(
            serde_json::json!({
                "lead": project.meta.lead,
                "members": project.meta.members,
            }),
            None,
            None,
        ),
        Err(err) => emit_error(CliError::from_service(err)),
    }
}

fn cmd_project_create(context: &ExecutionContext, flags: &HashMap<String, String>) -> i32 {
    if let Err(err) = context.require_project_mode("project.create") {
        return emit_error(err);
    }
    let actor = match mutation_actor(context) {
        Ok(actor) => actor,
        Err(err) => return emit_error(err),
    };
    let Some(name) = flags.get("name").filter(|value| !value.trim().is_empty()) else {
        return emit_error(CliError::new(
            ErrorCode::InvalidArgument,
            "project create requires --name",
        ));
    };
    let request = project_management::project_service::CreateProjectRequest {
        name: name.clone(),
        description: flags.get("description").cloned().unwrap_or_default(),
        org_id: flags.get("org").cloned(),
        status: flags.get("status").cloned(),
        priority: flags.get("priority").cloned(),
        lead: flags.get("lead").cloned(),
        labels: vec![],
    };
    let canonical = serde_json::json!({
        "op": "project.create",
        "name": name,
        "org": flags.get("org"),
    });
    let result = guarded(
        &actor.id,
        "project.create",
        flags
            .get("org")
            .map(String::as_str)
            .unwrap_or("personal-org"),
        flags.get("idempotency-key"),
        canonical,
        move || {
            let project = project_management::project_service::create_project(&request)?;
            Ok(project_to_wire(&project))
        },
    );
    match result {
        Ok(wire) => emit_success(wire, None, None),
        Err(err) => emit_error(err),
    }
}

fn cmd_project_update(
    context: &ExecutionContext,
    slug: Option<&String>,
    flags: &HashMap<String, String>,
) -> i32 {
    if let Err(err) = context.require_project_mode("project.update") {
        return emit_error(err);
    }
    let Some(slug) = slug else {
        return emit_error(CliError::new(
            ErrorCode::InvalidArgument,
            "Usage: org2 project update <slug> [--name ...] [--status ...]",
        ));
    };
    let actor = match mutation_actor(context) {
        Ok(actor) => actor,
        Err(err) => return emit_error(err),
    };
    let request = project_management::project_service::UpdateProjectRequest {
        name: flags.get("name").cloned(),
        description: flags.get("description").cloned(),
        status: flags.get("status").cloned(),
        priority: flags.get("priority").cloned(),
        lead: flags.get("lead").cloned(),
    };
    let canonical = serde_json::json!({
        "op": "project.update",
        "slug": slug,
        "name": flags.get("name"),
        "status": flags.get("status"),
    });
    let slug_owned = slug.clone();
    let result = guarded(
        &actor.id,
        "project.update",
        &slug_owned.clone(),
        flags.get("idempotency-key"),
        canonical,
        move || {
            let project =
                project_management::project_service::update_project(&slug_owned, &request)?;
            Ok(project_to_wire(&project))
        },
    );
    match result {
        Ok(wire) => emit_success(wire, None, None),
        Err(err) => emit_error(err),
    }
}
