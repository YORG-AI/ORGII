//! Command dispatch and shared CLI command helpers.

mod context;
mod project;
mod routine;
mod work;

use project_management::projects::types::{WorkItemMutationActor, WorkItemOriginSession};
use project_management::work_service;

use crate::context::{ExecutionContext, ProductMode};
use crate::envelope::CliError;

pub use context::cmd_context;
pub use project::dispatch_project;
pub use routine::dispatch_routine;
pub use work::dispatch_work;

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

// ProductMode is re-exported for the unused-import lint when features
// shift; keep the type referenced.
#[allow(dead_code)]
fn _mode_witness(mode: ProductMode) -> &'static str {
    mode.as_str()
}
