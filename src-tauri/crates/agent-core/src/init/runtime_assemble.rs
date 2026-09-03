//! Final SessionRuntime assembly + side-effects.
//!
//! At this point in init the heavy lifting is done: tools are wired,
//! workspace is hydrated, the agent definition is loaded. This module's only
//! job is to glue those pieces into a `SessionRuntime`, install it on the
//! session handle, and emit the bookkeeping side-effects (file registry,
//! channel running flag) that other subsystems poll.
//!
//! Side-effects are collected here so the call site in `mod.rs` doesn't
//! interleave them with the tool registry build — keeps the success-path
//! invariant ("if you see a `SessionRuntime`, both bookkeeping rows have
//! been written") trivial to audit.

use std::sync::Arc;

use tracing::{info, warn};

use crate::core::definitions::resolved::ResolvedAgent;
use crate::core::session::overrides::SessionOverrides;
use crate::integrations::config::IntegrationsConfig;
use crate::providers::traits::LLMProvider;
use crate::session::workspace::SessionWorkspace;
use crate::specialization::policies::activation::SessionScopedContextActivator;
use crate::state::{AgentAppState, AgentSession, SessionRuntime};
use crate::tools::policy::ResolvedToolPolicy;
use crate::tools::registry::ToolRegistry;

use super::agent_definition_loader::load_agent_definition;

/// Backfill the `agent_definition_id` column on the session row when it is
/// missing — `None` means the session was auto-registered (e.g. via the Tauri
/// channel re-inject path) before we knew which definition it belonged to.
///
/// We only run the spawn_blocking when we actually have a definition id to
/// write, and we keep the caller's error path as a warning: a backfill miss is
/// recoverable on the next turn, never fatal to the current one.
async fn backfill_definition_id(session_id: &str, def_id: &str) -> Result<(), String> {
    let sid = session_id.to_string();
    let did = def_id.to_string();
    let outcome = tokio::task::spawn_blocking(move || {
        crate::session::persistence::backfill_agent_definition_id(&sid, &did)
    })
    .await;
    flatten_backfill_result(outcome)
}

fn flatten_backfill_result(
    outcome: Result<Result<(), String>, tokio::task::JoinError>,
) -> Result<(), String> {
    match outcome {
        Ok(Ok(())) => Ok(()),
        Ok(Err(err)) => Err(err),
        Err(err) => Err(format!("backfill task failed: {err}")),
    }
}

/// Pull (soul, definition_id) from the persisted row and, if any piece is
/// still missing, fall back to the in-memory session definition that was
/// registered earlier in init.
///
/// `skills_config` is intentionally NOT loaded here: it's plumbed through
/// `UnifiedInitRequest` from the same `AgentDefinition` snapshot that
/// `ResolvedAgent::resolve` consumed, so the runtime's two parallel skill
/// caches (`resolved.skills` and `runtime.skills_config`) cannot diverge.
///
/// The fallback exists for the auto-registered case: a session created via a
/// Tauri command that wrote only the session row but skipped the definition
/// link will have an empty soul on disk; the in-memory `AgentDefinition`
/// is populated from `definition_for_session_id` and is the authoritative
/// source until the next user-driven save.
pub(super) async fn load_or_recover_definition(
    session_id: &str,
    session_handle: &AgentSession,
) -> (Option<String>, Option<String>) {
    let (mut agent_soul, mut resolved_def_id) = load_agent_definition(session_id);

    if resolved_def_id.is_none() || agent_soul.is_none() {
        let def = &session_handle.definition;
        if resolved_def_id.is_none() && !def.id.is_empty() {
            resolved_def_id = Some(def.id.clone());
            if let Err(err) = backfill_definition_id(session_id, &def.id).await {
                warn!(
                    "[init] Failed to backfill agent_definition_id for session {}: {}",
                    session_id, err
                );
            }
        }
        if agent_soul.is_none() {
            agent_soul = def.soul_content.clone();
        }
    }

    (agent_soul, resolved_def_id)
}

/// Inputs for the final `SessionRuntime` construction. Bundled so the call
/// site doesn't pass a 14-argument function — every field is required and
/// the explicit struct makes the semantics obvious at the call site.
pub(super) struct AssembleParams {
    pub provider: Arc<dyn LLMProvider>,
    pub final_registry: Arc<ToolRegistry>,
    pub policy_arc: Arc<ResolvedToolPolicy>,
    pub model: String,
    pub account_id: String,
    pub native_harness_type: Option<core_types::providers::NativeHarnessType>,
    pub workspace_state: Arc<parking_lot::RwLock<SessionWorkspace>>,
    pub mcp_auto_approved: Vec<String>,
    pub resolved: ResolvedAgent,
    pub integrations: IntegrationsConfig,
    pub overrides: SessionOverrides,
    pub agent_soul: Option<String>,
    pub sovereign_prompt: bool,
    pub policy_context_activator: Option<Arc<SessionScopedContextActivator>>,
    pub agent_org_context: Option<crate::coordination::agent_org_runs::AgentOrgRunContext>,
    pub agent_org_current_member_id: Option<String>,
    pub agent_definition_id: Option<String>,
}

/// Build the `SessionRuntime` and install it on the session handle.
pub(super) async fn install_runtime(
    session_handle: &AgentSession,
    params: AssembleParams,
) -> Result<(Arc<SessionRuntime>, String), String> {
    let runtime = Arc::new(SessionRuntime {
        provider: params.provider,
        tool_registry: params.final_registry,
        policy: params.policy_arc,
        model: params.model,
        account_id: Some(params.account_id),
        native_harness_type: params.native_harness_type,
        workspace_state: params.workspace_state,
        mcp_auto_approved: params.mcp_auto_approved,
        resolved: params.resolved,
        integrations_snapshot: params.integrations,
        overrides: params.overrides,
        agent_soul: params.agent_soul,
        sovereign_prompt: params.sovereign_prompt,
        policy_context_activator: params.policy_context_activator,
        agent_org_context: params.agent_org_context,
        agent_org_current_member_id: params.agent_org_current_member_id,
        agent_definition_id: params.agent_definition_id,
    });
    let runtime_lease_id = session_handle.set_runtime(Arc::clone(&runtime)).await?;
    Ok((runtime, runtime_lease_id))
}

/// Side-effect: mark the app as "running" + remember the active account.
///
/// Only runs when the session has a gateway capability — a desktop-only
/// session leaves the global running flag untouched so external observers
/// (channel scheduler, status indicators) only see "running" while there is
/// at least one inbound surface live.
pub(super) async fn mark_running_for_gateway(
    state: &AgentAppState,
    has_gateway: bool,
    account_id: &str,
) {
    if !has_gateway {
        return;
    }
    state
        .running
        .store(true, std::sync::atomic::Ordering::Relaxed);
    let mut current = state.current_account_id.lock().await;
    *current = Some(account_id.to_string());
}

/// Side-effect: write the file-based session registry row.
///
/// The file registry is the source of truth for "which sessions exist" for
/// out-of-process inspectors (CLI listings, crash recovery) — keep it in
/// sync with the in-memory state. A failure here is logged but not
/// propagated: the runtime is fully usable without the registry row, and
/// retrying would add latency to the user's first turn.
pub(super) fn register_in_file_registry(
    session_id: &str,
    log_prefix: &str,
    model: &str,
    workspace_root: &std::path::Path,
) {
    let now = chrono::Utc::now().to_rfc3339();
    let entry = crate::session::file_registry::SessionRegistryEntry {
        session_id: session_id.to_string(),
        agent_type: log_prefix.to_string(),
        model: model.to_string(),
        workspace_path: Some(workspace_root.display().to_string()),
        status: crate::session::SessionStatus::Running.as_str().to_string(),
        started_at: now.clone(),
        last_updated_at: now,
    };
    if let Err(err) = crate::session::file_registry::register_session(&entry) {
        warn!(
            "[init] Failed to register session in file registry: {}",
            err
        );
    }
}

/// Final structured-log line emitted at the bottom of `ensure_session_initialized`.
/// Kept here so the per-line format stays in one place — production log
/// scrapers key off the `[init] Session ... initialized` prefix.
pub(super) fn log_init_complete(session_id: &str, model: &str, workspace_root: &std::path::Path) {
    info!(
        "[init] Session {} initialized (model={}, workspace_root={})",
        session_id,
        model,
        workspace_root.display()
    );
}

#[cfg(test)]
mod tests {
    use super::flatten_backfill_result;

    #[test]
    fn flatten_backfill_result_preserves_db_error() {
        let err = flatten_backfill_result(Ok(Err("DB update failed".to_string()))).unwrap_err();
        assert_eq!(err, "DB update failed");
    }

    #[test]
    fn flatten_backfill_result_accepts_success() {
        assert!(flatten_backfill_result(Ok(Ok(()))).is_ok());
    }

    #[tokio::test]
    async fn flatten_backfill_result_reports_join_error() {
        let outcome = tokio::spawn(async {
            panic!("backfill panic");
        })
        .await
        .map(|_| Ok(()));

        let err = flatten_backfill_result(outcome).unwrap_err();
        assert!(err.contains("backfill task failed"));
    }
}
