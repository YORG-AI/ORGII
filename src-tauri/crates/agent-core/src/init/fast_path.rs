//! Fast-path check: skip re-init if the existing runtime already matches.
//!
//! Many init calls are re-entrant — channel re-inject, scheduled cron tick,
//! tool dispatch from a sub-agent. The first call did the expensive work
//! (provider construction, MCP startup, plugin scan); the rest just need to
//! confirm "this runtime is still right for what you're asking".
//!
//! Match criteria are deliberately conservative:
//!   - account: must match exactly (None==None or Some(a)==Some(a))
//!   - model: only checked when the caller pinned one (no pin → accept anything)
//!   - workspace: the runtime's live `working_dir()` must match the
//!     caller's resolved workspace path. Identity resolution projects a
//!     worktree session onto its working dir, so comparing against
//!     `working_dir()` (NOT the stable `user_visible()` root) keeps
//!     worktree sessions on the fast path instead of rebuilding the
//!     runtime on every message.
//!
//! The model rule is the load-bearing one: when the channel re-injects an
//! inbound message, it does NOT know which model the user picked, so it
//! passes `None`. We must accept the existing runtime in that case rather
//! than failing on an empty model field.

use std::path::Path;
use std::sync::Arc;

use crate::state::{AgentAppState, SessionRuntime};

/// Returns the existing runtime when it satisfies all match criteria for
/// the current init request, otherwise `None` (caller must rebuild).
pub(super) async fn try_reuse_existing(
    state: &AgentAppState,
    session_id: &str,
    account_id: Option<&str>,
    requested_model: Option<&str>,
    workspace_root: &Path,
    durable_agent_org_run_id: Option<&str>,
) -> Option<Arc<SessionRuntime>> {
    let session = state.get_session(session_id).await?;
    let existing = session.get_runtime().await?;

    let account_matches = match (existing.account_id.as_deref(), account_id) {
        (Some(a), Some(b)) => a == b,
        (None, None) => true,
        _ => false,
    };
    let model_matches = match requested_model {
        Some(req) => existing.model == req,
        None => true,
    };
    let project_matches = existing.workspace_state.read().working_dir() == workspace_root;
    let ownership_matches = existing
        .agent_org_context
        .as_ref()
        .map(|context| context.run_id.as_str())
        == durable_agent_org_run_id;

    if account_matches && model_matches && project_matches && ownership_matches {
        Some(existing)
    } else {
        tracing::info!("[init] Session {} needs reinitialization", session_id);
        None
    }
}
