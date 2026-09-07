use std::collections::HashMap;

use project_management::projects::io as pio;
use project_management::work_service;

use super::{item_to_wire, require_short_id, standalone_fallback_item, uses_standalone_scope};
use crate::context::ExecutionContext;
use crate::envelope::{emit_error, emit_success, CliError, ErrorCode};

pub(super) fn list(context: &ExecutionContext, flags: &HashMap<String, String>) -> i32 {
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
            Ok(state) => Some(StatusFilter::Portable(state)),
            Err(err) => match custom_status_definition(context, raw) {
                Ok(Some(_)) => Some(StatusFilter::CustomKey(raw.clone())),
                Ok(None) => return emit_error(err),
                Err(lookup) => return emit_error(lookup),
            },
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
        .filter(|item| match &status_filter {
            None => true,
            Some(StatusFilter::Portable(state)) => {
                work_service::state::map_legacy_status(&item.frontmatter.status) == Some(*state)
            }
            Some(StatusFilter::CustomKey(key)) => &item.frontmatter.status == key,
        })
        .filter(|item| {
            if !ready_only {
                return true;
            }
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

pub(super) enum StatusFilter {
    Portable(work_service::WorkItemState),
    CustomKey(String),
}

pub(super) fn custom_status_definition(
    context: &ExecutionContext,
    raw: &str,
) -> Result<Option<project_management::work_item_features::StatusDefinition>, CliError> {
    project_management::work_item_features::find_active_status_definition(
        context.org_id.as_deref(),
        raw,
    )
    .map_err(CliError::from_service)
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
                "Unknown state '{}'; expected open|in_progress|blocked|completed|failed|cancelled or an active custom status key",
                other
            ),
        )),
    }
}

pub(super) fn show(
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
        return emit_success(item_to_wire(&item, None), None, None);
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

pub(super) fn timeline(
    context: &ExecutionContext,
    short_id: Option<&String>,
    flags: &HashMap<String, String>,
) -> i32 {
    let short_id = match require_short_id(short_id) {
        Ok(short_id) => short_id,
        Err(err) => return emit_error(err),
    };
    let tail = match flags.get("tail") {
        None => None,
        Some(raw) => match raw.parse::<usize>() {
            Ok(value) => Some(value),
            Err(_) => {
                return emit_error(
                    CliError::new(
                        ErrorCode::InvalidArgument,
                        format!("--tail expects a non-negative integer, got '{raw}'"),
                    )
                    .with_details(serde_json::json!({ "field": "--tail", "value": raw })),
                )
            }
        },
    };
    if flags.contains_key("activity-only") && flags.contains_key("comments-only") {
        return emit_error(CliError::new(
            ErrorCode::InvalidArgument,
            "--activity-only and --comments-only are mutually exclusive",
        ));
    }
    let filter = work_service::timeline::TimelineFilter {
        since: flags.get("since").map(String::as_str),
        tail,
        activity_only: flags.contains_key("activity-only"),
        comments_only: flags.contains_key("comments-only"),
    };
    let (item, revision) = if uses_standalone_scope(context, flags) {
        match pio::read_standalone_work_item(context.org_id.as_deref(), &short_id) {
            Ok(item) => (item, None),
            Err(err) => return emit_error(CliError::from_service(err)),
        }
    } else if let Some(item) = standalone_fallback_item(context, &short_id) {
        (item, None)
    } else {
        let scope = match context.require_scope() {
            Ok(scope) => scope.to_string(),
            Err(err) => return emit_error(err),
        };
        match pio::read_work_item(&scope, &short_id) {
            Ok(item) => (
                item,
                work_service::read_project_work_item_revision(&scope, &short_id).ok(),
            ),
            Err(err) => return emit_error(CliError::from_service(err)),
        }
    };
    let entries = work_service::timeline::work_item_timeline(&item, filter);
    emit_success(
        serde_json::json!({
            "shortId": item.frontmatter.short_id,
            "status": item.frontmatter.status,
            "entries": entries,
        }),
        revision,
        None,
    )
}
