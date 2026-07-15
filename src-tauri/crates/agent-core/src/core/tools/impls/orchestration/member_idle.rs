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
//! available. After persisting the row, the hook wakes the coordinator
//! session so the org keeps draining work when workers become idle.
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

/// Production hook: persist a `MemberIdle` envelope into the inbox, then wake the coordinator.
///
/// The insert is synchronous (a single `AgentInboxStore::insert` SQL
/// statement) so we do not spawn a task — keeping the call cheap means
/// the worker's post-turn dispatch path never blocks on idle emission.
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
    match AgentInboxStore::list_unread_for_member(member_id, org_run_id) {
        Ok(rows) => !rows.is_empty(),
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
        match AgentInboxStore::insert(params) {
            Ok(record) => {
                debug!(
                    run_id = %org_run_id,
                    member_id = %member_id,
                    coordinator = %coordinator_agent_id,
                    inbox_id = record.id,
                    "[member_idle] posted MemberIdle envelope to coordinator inbox"
                );
                self.wake_hook.wake_member(
                    crate::coordination::agent_org_runs::COORDINATOR_MEMBER_ID,
                    org_run_id,
                );
                if has_unread_member_inbox(org_run_id, member_id) {
                    self.wake_hook.wake_member(member_id, org_run_id);
                }
            }
            Err(err) => {
                warn!(
                    run_id = %org_run_id,
                    member_id = %member_id,
                    coordinator = %coordinator_agent_id,
                    error = %err,
                    "[member_idle] AgentInboxStore::insert failed; coordinator will not see this idle"
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;
    use crate::coordination::agent_inbox::{self, AgentInboxStore};
    use database;
    use test_helpers::test_env;

    #[derive(Default, Debug)]
    struct RecordingWakeHook {
        calls: Mutex<Vec<(String, String)>>,
    }

    impl RecordingWakeHook {
        fn snapshot(&self) -> Vec<(String, String)> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl InboxWakeHook for RecordingWakeHook {
        fn wake_member(&self, member_id: &str, org_run_id: &str) {
            self.calls
                .lock()
                .unwrap()
                .push((member_id.to_string(), org_run_id.to_string()));
        }
    }

    fn insert_member_inbox_row(run_id: &str, member_id: &str) {
        AgentInboxStore::insert(InsertInboxParams {
            recipient_agent_id: "worker-1".to_string(),
            recipient_member_id: Some(member_id.to_string()),
            sender_agent_id: crate::coordination::agent_inbox::USER_SENDER_ID.to_string(),
            sender_member_id: None,
            org_run_id: Some(run_id.to_string()),
            message: AgentMessage::Plain {
                summary: "User group chat message".to_string(),
                text: "Who are you?".to_string(),
            },
        })
        .expect("insert member inbox row");
    }

    #[test]
    fn member_idle_posts_row_and_wakes_coordinator() {
        let _sandbox = test_env::sandbox();
        let conn = database::db::get_connection().expect("test connection");
        agent_inbox::init_schema(&conn).expect("agent inbox schema");
        let wake_hook = Arc::new(RecordingWakeHook::default());
        let hook = InboxStoreMemberIdleHook::new(wake_hook.clone());

        hook.post_member_idle(
            "run-1",
            "coord",
            "member-worker",
            "worker-1",
            "Worker",
            MemberIdleReason::Available,
            Some(crate::session::AgentExecMode::Plan),
            None,
            None,
            Vec::new(),
        );

        let inbox = AgentInboxStore::list_unread_for_member(
            crate::coordination::agent_org_runs::COORDINATOR_MEMBER_ID,
            "run-1",
        )
        .expect("coordinator inbox");
        assert_eq!(inbox.len(), 1);
        assert_eq!(inbox[0].payload_kind, "member_idle");
        assert_eq!(
            wake_hook.snapshot(),
            vec![(
                crate::coordination::agent_org_runs::COORDINATOR_MEMBER_ID.into(),
                "run-1".into()
            )]
        );
    }

    #[test]
    fn member_idle_wakes_member_when_post_turn_inbox_is_unread() {
        let _sandbox = test_env::sandbox();
        let conn = database::db::get_connection().expect("test connection");
        agent_inbox::init_schema(&conn).expect("agent inbox schema");
        insert_member_inbox_row("run-1", "member-worker");
        let wake_hook = Arc::new(RecordingWakeHook::default());
        let hook = InboxStoreMemberIdleHook::new(wake_hook.clone());

        hook.post_member_idle(
            "run-1",
            "coord",
            "member-worker",
            "worker-1",
            "Worker",
            MemberIdleReason::Available,
            Some(crate::session::AgentExecMode::Build),
            None,
            None,
            Vec::new(),
        );

        assert_eq!(
            wake_hook.snapshot(),
            vec![
                (
                    crate::coordination::agent_org_runs::COORDINATOR_MEMBER_ID.into(),
                    "run-1".into()
                ),
                ("member-worker".into(), "run-1".into())
            ]
        );
    }
}
