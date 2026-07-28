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
/// The hook contract is synchronous because finality must observe this durable
/// notification before it can complete the Run. When called from Tokio's
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
            let record = AgentInboxStore::insert_if_run_running(params)?;
            let member_has_unread = record
                .as_ref()
                .is_some_and(|_| has_unread_member_inbox(org_run_id, member_id));
            Ok::<_, String>((record, member_has_unread))
        });
        match persisted {
            Ok((Some(record), member_has_unread)) => {
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

    fn seed_run(conn: &rusqlite::Connection, run_id: &str, status: &str) {
        crate::coordination::agent_org_runs::init_schema(conn).expect("Agent Org run schema");
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO agent_org_runs (
                 id, org_id, coordinator_agent_id, root_session_id,
                 entry_mode, status, created_at, updated_at
             ) VALUES (?1, 'org-1', 'coord', 'root-1', 'build', ?2, ?3, ?3)",
            rusqlite::params![run_id, status, now],
        )
        .expect("seed Agent Org run");
    }

    #[test]
    fn blocking_section_is_safe_inside_current_thread_runtime() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("current-thread runtime");
        runtime.block_on(async {
            assert_eq!(run_agent_org_blocking_section(|| 42), 42);
        });
    }

    #[test]
    fn member_idle_posts_row_and_wakes_coordinator() {
        let _sandbox = test_env::sandbox();
        let conn = database::db::get_connection().expect("test connection");
        agent_inbox::init_schema(&conn).expect("agent inbox schema");
        seed_run(&conn, "run-1", "running");
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
        seed_run(&conn, "run-1", "running");
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

    #[test]
    fn member_idle_does_not_reopen_terminal_run_inbox() {
        let _sandbox = test_env::sandbox();
        let conn = database::db::get_connection().expect("test connection");
        agent_inbox::init_schema(&conn).expect("agent inbox schema");
        seed_run(&conn, "run-terminal", "completed");
        let wake_hook = Arc::new(RecordingWakeHook::default());
        let hook = InboxStoreMemberIdleHook::new(wake_hook.clone());

        hook.post_member_idle(
            "run-terminal",
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

        assert!(AgentInboxStore::list_unread_for_member(
            crate::coordination::agent_org_runs::COORDINATOR_MEMBER_ID,
            "run-terminal",
        )
        .expect("coordinator inbox")
        .is_empty());
        assert!(wake_hook.snapshot().is_empty());
    }
}
