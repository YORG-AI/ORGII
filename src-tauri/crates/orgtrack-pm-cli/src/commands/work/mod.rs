//! `work` commands (`orgtrack/v1` §13).
//!
//! Wire-shape residuals during migration, documented against the frozen
//! contract:
//! - work items serialize their store shape (legacy status vocabulary +
//!   snake_case frontmatter) plus a `portableState` projection and a
//!   `revision`; the full portable shape lands with the Phase 7 UI
//!   switch.
//! - `--ready` filters on portable `open` with no active claim; the
//!   dependency graph (`dependsOn`) arrives with the Routine rebuild.
//! - `--idempotency-key` deduplicates every mutation via `pm_idempotency`.

mod create;
mod note;
mod ownership;
mod query;
mod relate;
mod transition;
mod update;

use std::collections::HashMap;

use project_management::projects::io as pio;
use project_management::projects::types::WorkItemData;
use project_management::work_service;

use crate::context::ExecutionContext;
use crate::envelope::{emit_error, CliError, ErrorCode};

pub fn dispatch_work(
    context: &ExecutionContext,
    positionals: &[String],
    flags: &HashMap<String, String>,
) -> i32 {
    match positionals.first().map(String::as_str) {
        Some("list") => query::list(context, flags),
        Some("show") => query::show(context, positionals.get(1), flags),
        Some("create") => create::run(context, flags),
        Some("update") => update::run(context, positionals.get(1), flags),
        Some("assign") => ownership::assign(context, positionals.get(1), flags),
        Some("release") => ownership::release(context, positionals.get(1), flags),
        Some("claim") => ownership::claim(context, positionals.get(1), flags),
        Some("transition") => transition::run(context, positionals.get(1), flags),
        Some("note") => note::run(context, positionals.get(1), flags),
        Some("relate") => relate::run(context, positionals.get(1), flags),
        other => emit_error(CliError::new(
            ErrorCode::InvalidArgument,
            format!(
                "Unknown work subcommand '{}'; expected list|show|create|update|claim|transition|note|relate",
                other.unwrap_or("<none>")
            ),
        )),
    }
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
/// resolved project has no such item while a standalone row exists.
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

/// A missing project scope is the canonical org-level Work Item scope.
fn uses_standalone_scope(context: &ExecutionContext, flags: &HashMap<String, String>) -> bool {
    flags.contains_key("standalone") || context.scope_id.is_none()
}
