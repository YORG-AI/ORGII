//! Presence-policy auto-approve deadline watcher for a pending plan.

use std::sync::Arc;

use tokio::sync::Mutex;
use tracing::{info, warn};

use super::snapshot::PendingPlanApproval;

/// Presence-policy auto-approve deadline watcher for a pending plan.
///
/// Mirrors the question watcher: sleeps until the active policy's
/// `plan_auto_approve` deadline (relative to plan creation) and then
/// drives the SAME approve path as the user clicking Build (via
/// `auto_approve_pending_plan` → `resolve_pending`). Re-arms on every
/// presence change; exits when the plan is resolved or superseded.
/// Resolution is idempotent — a racing manual click wins and the watcher
/// becomes a no-op.
pub(super) fn spawn_auto_approve_watcher(
    session_id: String,
    plan_revision_id: String,
    created_at_ms: i64,
    pending: Arc<Mutex<Option<PendingPlanApproval>>>,
) {
    use super::super::presence_policy::AutoResolve;
    use super::super::presence_state;
    use tauri::Manager;

    tokio::spawn(async move {
        let mut presence_rx = presence_state::subscribe();

        loop {
            // Exit when this revision is no longer the pending plan.
            let still_pending = pending.lock().await.as_ref().is_some_and(|snapshot| {
                snapshot.plan_revision_id == plan_revision_id
                    || snapshot.tool_call_id.as_deref() == Some(plan_revision_id.as_str())
            });
            if !still_pending {
                return;
            }

            let policy = presence_state::global_policy();
            let deadline_ms = match policy.plan_auto_approve {
                AutoResolve::Off => None,
                AutoResolve::After(window) => Some(created_at_ms + window.as_millis() as i64),
            };

            match deadline_ms {
                None => {
                    if presence_rx.recv().await.is_err() {
                        return;
                    }
                }
                Some(deadline_ms) => {
                    let now_ms = chrono::Utc::now().timestamp_millis();
                    let remaining = (deadline_ms - now_ms).max(0) as u64;
                    tokio::select! {
                        _ = tokio::time::sleep(std::time::Duration::from_millis(remaining)) => {
                            let mode_label = presence_state::global_presence()
                                .map(|presence| presence.display_label().to_string())
                                .unwrap_or_else(|| "away".to_string());
                            let Some(handle) = super::GLOBAL_APP_HANDLE.get() else {
                                warn!("[plan_approval] auto-approve: no app handle");
                                return;
                            };
                            let Some(state) =
                                handle.try_state::<crate::state::AgentAppState>()
                            else {
                                warn!("[plan_approval] auto-approve: AgentAppState missing");
                                return;
                            };
                            info!(
                                "[plan_approval] auto-approving pending plan (session={}, mode={})",
                                session_id, mode_label
                            );
                            if let Err(err) =
                                crate::state::commands::session::auto_approve_pending_plan(
                                    &state,
                                    session_id.clone(),
                                    mode_label,
                                )
                                .await
                            {
                                warn!("[plan_approval] auto-approve failed: {err}");
                            }
                            return;
                        }
                        changed = presence_rx.recv() => {
                            if changed.is_err() {
                                return;
                            }
                            // Re-loop: re-read policy and re-arm.
                        }
                    }
                }
            }
        }
    });
}
