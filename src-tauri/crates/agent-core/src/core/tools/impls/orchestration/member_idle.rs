//! Production [`MemberIdleHook`] backed by [`AgentInboxStore`].
//!
//! When a worker session running inside an `AgentOrgRun` finishes a
//! turn, the unified processor calls
//! [`super::super::super::session::turn::member_idle::maybe_emit_member_idle`]
//! which dispatches into the installed hook. This impl persists an
//! [`AgentMessage::MemberIdle`] envelope into `agent_inbox` addressed
//! from `SYSTEM_SENDER_ID` to the coordinator's `agent_id`. The
//! coordinator's next turn-boundary inbox drain renders a
//! `<member_idle member_id="…" member_name="…" reason="…" .../>` line
//! into the prompt so the leader's LLM is told the worker is now
//! available. After persisting the row, the hook wakes the Coordinator only
//! for lifecycle facts that require action; routine availability remains
//! visible history without starting Provider work.
//!
//! Covers success, interrupted, and failed transitions. Emit failures are
//! logged at `warn!` and swallowed — missing one notification is preferable
//! to failing a turn that already produced output or error state.

use std::sync::Arc;

use tracing::{debug, warn};

use crate::coordination::agent_inbox::{
    AgentInboxStore, AgentMessage, InsertInboxParams, MemberIdleReason, SYSTEM_SENDER_ID,
};
use crate::core::session::turn::member_idle::MemberIdleHook;
use crate::tools::impls::orchestration::org_send_message::{InboxWakeHook, NoopInboxWakeHook};

/// Production hook: persist `MemberIdle`, then wake only its actionable owners.
///
/// The hook contract is synchronous because Quiescence must observe this durable
/// notification before it can move the Team to Idle. When called from Tokio's
/// multi-thread runtime we therefore use an explicit `block_in_place` section:
/// executor capacity is handed to another worker while ordering is preserved.
pub struct InboxStoreMemberIdleHook {
    wake_hook: Arc<dyn InboxWakeHook>,
}

impl InboxStoreMemberIdleHook {
    pub fn new(wake_hook: Arc<dyn InboxWakeHook>) -> Arc<Self> {
        Arc::new(Self { wake_hook })
    }
}

impl Default for InboxStoreMemberIdleHook {
    fn default() -> Self {
        Self {
            wake_hook: Arc::new(NoopInboxWakeHook),
        }
    }
}

fn has_unread_member_inbox(org_run_id: &str, member_id: &str) -> bool {
    match AgentInboxStore::has_unread_for_member(member_id, org_run_id) {
        Ok(has_unread) => has_unread,
        Err(err) => {
            warn!(
                run_id = %org_run_id,
                member_id = %member_id,
                error = %err,
                "[member_idle] failed to inspect member inbox for post-turn wake"
            );
            false
        }
    }
}

/// Run short synchronous Agent Org persistence without panicking when the
/// caller happens to be inside Tokio's current-thread runtime. Lifecycle
/// finalization and MemberIdle delivery share this exact boundary.
pub(crate) fn run_agent_org_blocking_section<T>(work: impl FnOnce() -> T) -> T {
    match tokio::runtime::Handle::try_current() {
        Ok(handle) if handle.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread => {
            tokio::task::block_in_place(work)
        }
        _ => work(),
    }
}

impl MemberIdleHook for InboxStoreMemberIdleHook {
    #[allow(clippy::too_many_arguments)]
    fn post_member_idle(
        &self,
        org_run_id: &str,
        coordinator_agent_id: &str,
        member_id: &str,
        _member_agent_id: &str,
        member_name: &str,
        reason: MemberIdleReason,
        current_mode: Option<crate::session::AgentExecMode>,
        summary: Option<String>,
        failure_reason: Option<String>,
        unfinished_task_ids: Vec<String>,
    ) {
        let message = AgentMessage::MemberIdle {
            member_id: member_id.to_string(),
            member_name: member_name.to_string(),
            reason,
            current_mode,
            summary,
            failure_reason,
            unfinished_task_ids,
        };
        if let Err(err) = message.validate() {
            warn!(
                run_id = %org_run_id,
                member_id = %member_id,
                error = %err,
                "[member_idle] payload failed local validate; skipping insert"
            );
            return;
        }
        let params = InsertInboxParams {
            recipient_agent_id: coordinator_agent_id.to_string(),
            recipient_member_id: Some(
                crate::coordination::agent_org_runs::COORDINATOR_MEMBER_ID.to_string(),
            ),
            sender_agent_id: SYSTEM_SENDER_ID.to_string(),
            sender_member_id: None,
            org_run_id: Some(org_run_id.to_string()),
            message,
        };
        let persisted = run_agent_org_blocking_section(|| {
            let inserted = AgentInboxStore::insert_member_idle_if_run_running(params)?;
            let member_has_unread = inserted
                .as_ref()
                .is_some_and(|_| has_unread_member_inbox(org_run_id, member_id));
            Ok::<_, String>((inserted, member_has_unread))
        });
        match persisted {
            Ok((Some((record, coordinator_actionable)), member_has_unread)) => {
                crate::coordination::agent_org_run_events::notify_agent_org_run_changed(org_run_id);
                debug!(
                    run_id = %org_run_id,
                    member_id = %member_id,
                    coordinator = %coordinator_agent_id,
                    inbox_id = record.id,
                    coordinator_actionable,
                    "[member_idle] posted MemberIdle envelope to coordinator inbox"
                );
                if coordinator_actionable {
                    self.wake_hook.wake_member(
                        crate::coordination::agent_org_runs::COORDINATOR_MEMBER_ID,
                        org_run_id,
                    );
                }
                if member_has_unread {
                    self.wake_hook.wake_member(member_id, org_run_id);
                }
            }
            Ok((None, _)) => {
                debug!(
                    run_id = %org_run_id,
                    member_id = %member_id,
                    "[member_idle] run is paused or terminal; skipping stale idle notification"
                );
            }
            Err(err) => {
                warn!(
                    run_id = %org_run_id,
                    member_id = %member_id,
                    coordinator = %coordinator_agent_id,
                    error = %err,
                    "[member_idle] atomic inbox insert failed; coordinator will not see this idle"
                );
            }
        }
    }
}

#[cfg(test)]
#[path = "member_idle/tests.rs"]
mod tests;
