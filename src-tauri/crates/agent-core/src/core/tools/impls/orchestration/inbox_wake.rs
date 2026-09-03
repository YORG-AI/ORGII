//! Production [`InboxWakeHook`] backed by [`AgentAppState`].
//!
//! # What this hook does
//!
//! When `OrgSendMessageTool` writes a row to `agent_inbox`, the
//! recipient session may be idle or in a terminal state (`Completed` /
//! `Failed` / `Cancelled` / `Abandoned` / `Timeout`). Without a wake,
//! that session would never run another turn and the message would
//! sit unread in the inbox forever.
//!
//! [`AppHandleInboxWakeHook`] handles the wake by reusing the same
//! user-driven entry point that the IDE uses for "user resumed a
//! stopped session": [`send_message_impl`] called with empty content
//! and `is_resume=true`. That tells the processor to skip persisting
//! a synthetic user turn (`should_save_user_msg = !(is_resume &&
//! content.is_empty())` in `processor/mod.rs`) and to drain the
//! inbox payload at turn-boundary entry instead (`inbox_drain` hook
//! in the same file).
//!
//! # Why the inbox row is the source of truth (and the wake doesn't
//! re-attach the message)
//!
//! Every send is persisted to SQLite before this hook fires, so the
//! message survives recipient death independently of the wake. The
//! wake's only job is to start the turn loop again so the persisted
//! row gets drained. Re-attaching the message to the resumed loop's
//! prompt would duplicate it.

use std::sync::Arc;

use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
use tracing::{info, warn};

use crate::coordination::agent_org_runs::{AgentOrgRunStatus, AgentOrgRunStore};
use crate::core::session::SessionStatus;
use crate::state::AgentAppState;
use crate::tools::impls::orchestration::org_send_message::{InboxWakeHook, UserDirectedWake};

/// Production [`InboxWakeHook`] that resolves the recipient session by
/// canonical `member_id` and, when the session is idle or terminal, fires
/// `send_message_impl(session_id, "", is_resume=true)` on a detached Tokio
/// task.
///
/// Failures (DB lookup errors, missing app handle, in-flight session)
/// are logged at `info!`/`warn!` and swallowed — the persisted inbox
/// row remains the source of truth, so a missed wake just means the
/// message is drained the next time the materialized recipient session
/// takes a turn.
pub struct AppHandleInboxWakeHook {
    app_handle: AppHandle,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WakeRequestOutcome {
    Enqueued,
    Coalesced,
    DeferredPaused,
    DeferredIntervention,
    DeferredBackoff,
    RunTerminal,
    SessionUnavailable,
    Failed(String),
}

impl AppHandleInboxWakeHook {
    pub fn new(app_handle: AppHandle) -> Arc<Self> {
        Arc::new(Self { app_handle })
    }
}

impl InboxWakeHook for AppHandleInboxWakeHook {
    fn wake_member(&self, member_id: &str, org_run_id: &str) {
        self.spawn_wake(member_id, org_run_id, None);
    }

    fn wake_member_for_formal_receipts(
        &self,
        member_id: &str,
        org_run_id: &str,
        receipt_ids: &[String],
    ) {
        self.spawn_wake(member_id, org_run_id, Some(receipt_ids.to_vec()));
    }

    fn wake_user_directed_member(&self, wake: UserDirectedWake) {
        let app_handle = self.app_handle.clone();
        tokio::spawn(async move {
            let Some(state) = app_handle.try_state::<AgentAppState>() else {
                warn!(
                    run_id = %wake.org_run_id,
                    member_id = %wake.recipient_member_id,
                    "cannot dispatch linked UDW without AgentAppState"
                );
                return;
            };
            if let Err(error) =
                crate::state::commands::session::message::send_message_impl_for_user_directed_wake(
                    &state, wake,
                )
                .await
            {
                warn!(error = %error, "linked UDW kick failed; startup recovery retains the pending receipt");
            }
        });
    }
}

impl AppHandleInboxWakeHook {
    fn spawn_wake(
        &self,
        member_id: &str,
        org_run_id: &str,
        formal_receipt_ids: Option<Vec<String>>,
    ) {
        let member = member_id.to_string();
        let run_id = org_run_id.to_string();
        let app_handle = self.app_handle.clone();
        tokio::spawn(async move {
            let is_repair = formal_receipt_ids.is_some();
            let formal_receipt_ids = if member
                == crate::coordination::agent_org_runs::COORDINATOR_MEMBER_ID
                && formal_receipt_ids.is_none()
            {
                let pending_receipts = database::db::get_connection()
                    .map_err(|error| error.to_string())
                    .and_then(|connection| {
                        crate::coordination::agent_org_formal_triggers::activity_with_connection(
                            &connection,
                            &run_id,
                            100,
                        )
                    });
                match pending_receipts {
                    Ok(activity) => Some(activity.pending_receipt_ids),
                    Err(error) => {
                        warn!(
                            run_id = %run_id,
                            error = %error,
                            "failed to snapshot exact pending Coordinator formal batch before wake"
                        );
                        None
                    }
                }
            } else {
                formal_receipt_ids
            };
            let outcome =
                wake_one_member(app_handle, &member, &run_id, formal_receipt_ids.as_deref()).await;
            if member == crate::coordination::agent_org_runs::COORDINATOR_MEMBER_ID
                && matches!(
                    outcome,
                    WakeRequestOutcome::Enqueued | WakeRequestOutcome::Coalesced
                )
            {
                let acknowledged = formal_receipt_ids.as_deref().map(|receipt_ids| {
                    crate::coordination::agent_org_formal_triggers::mark_doorbells_delivered(
                        receipt_ids,
                    )
                });
                match acknowledged {
                    None => {}
                    Some(Ok(0)) if !is_repair => {}
                    Some(Ok(count)) if is_repair => tracing::info!(
                        run_id = %run_id,
                        repaired_receipts = count,
                        "[agent_org_metric] formal_doorbell_repaired"
                    ),
                    Some(Ok(count)) => tracing::debug!(
                        run_id = %run_id,
                        acknowledged_receipts = count,
                        "[agent_org_metric] formal_doorbell_delivered"
                    ),
                    Some(Err(error)) => warn!(
                        run_id = %run_id,
                        error = %error,
                        "Coordinator wake was accepted but durable doorbell acknowledgement failed"
                    ),
                }
            }
            info!(run_id = %run_id, member_id = %member, ?outcome, "[inbox_wake] wake request finished");
        });
    }
}

fn should_dispatch_wake(status: SessionStatus) -> bool {
    status.is_agent_org_wakeable()
}

async fn wake_one_member(
    app_handle: AppHandle,
    member_id: &str,
    org_run_id: &str,
    formal_receipt_ids: Option<&[String]>,
) -> WakeRequestOutcome {
    // Only a Running run can dispatch work. Fail closed so a stale wake never
    // resurrects a paused, terminal, missing, or unreadable run.
    match AgentOrgRunStore::get_run_status(org_run_id) {
        Ok(Some(AgentOrgRunStatus::Running)) => {}
        Ok(Some(AgentOrgRunStatus::Paused)) => {
            info!(
                run_id = %org_run_id,
                member_id = %member_id,
                "[inbox_wake] run is paused; inbox row remains pending"
            );
            return WakeRequestOutcome::DeferredPaused;
        }
        Ok(Some(status)) => {
            info!(run_id = %org_run_id, member_id = %member_id, ?status, "[inbox_wake] run is terminal; refusing wake");
            return WakeRequestOutcome::RunTerminal;
        }
        Ok(None) => {
            warn!(
                run_id = %org_run_id,
                member_id = %member_id,
                "[inbox_wake] run does not exist; refusing wake"
            );
            return WakeRequestOutcome::RunTerminal;
        }
        Err(err) => {
            warn!(
                run_id = %org_run_id,
                member_id = %member_id,
                error = %err,
                "[inbox_wake] run status lookup failed; refusing wake"
            );
            return WakeRequestOutcome::Failed(err);
        }
    }

    // Direct user chat temporarily owns this member's next turn. Dispatching
    // an empty resume while the intervention is active cannot drain the inbox;
    // the lifecycle race guard would then see the same unread row and enqueue
    // another empty resume forever. Defer before touching the scheduler so the
    // durable inbox row remains the one source of truth and the frontend never
    // sees a fake running/idle pulse.
    match crate::coordination::agent_member_interventions::AgentMemberInterventionStore::active_for_member(
        org_run_id,
        member_id,
    ) {
        Ok(Some(intervention)) => {
            info!(
                run_id = %org_run_id,
                member_id = %member_id,
                intervention_receipt_id = %intervention.intervention_receipt_id,
                intervention_status = %intervention.status.as_str(),
                "[inbox_wake] member is in direct user intervention; deferring wake"
            );
            return WakeRequestOutcome::DeferredIntervention;
        }
        Ok(None) => {}
        Err(err) => {
            warn!(
                run_id = %org_run_id,
                member_id = %member_id,
                error = %err,
                "[inbox_wake] intervention lookup failed; refusing wake"
            );
            return WakeRequestOutcome::Failed(err);
        }
    }

    let info = if member_id == crate::coordination::agent_org_runs::COORDINATOR_MEMBER_ID {
        match AgentOrgRunStore::find_coordinator_session_by_member_id(org_run_id, member_id) {
            Ok(info) => info,
            Err(err) => {
                warn!(
                    run_id = %org_run_id,
                    member_id = %member_id,
                    error = %err,
                    "[inbox_wake] coordinator session lookup failed; skipping wake"
                );
                return WakeRequestOutcome::Failed(err);
            }
        }
    } else {
        match AgentOrgRunStore::list_worker_sessions_by_member_ids(
            org_run_id,
            &[member_id.to_string()],
        ) {
            Ok(mut sessions) => match sessions.pop() {
                Some(session) if session.cli_agent_type.is_some() => {
                    warn!(
                        run_id = %org_run_id,
                        member_id = %member_id,
                        cli_agent_type = ?session.cli_agent_type,
                        "[inbox_wake] historical CLI Agent Org member is unsupported; refusing Rust wake"
                    );
                    return WakeRequestOutcome::SessionUnavailable;
                }
                Some(session) => Some(crate::coordination::agent_org_runs::WorkerSessionInfo {
                    session_id: session.session_id,
                    status: session.status,
                    updated_at: session.updated_at,
                }),
                None => None,
            },
            Err(err) => {
                warn!(
                    run_id = %org_run_id,
                    member_id = %member_id,
                    error = %err,
                    "[inbox_wake] member session lookup failed; skipping wake"
                );
                return WakeRequestOutcome::Failed(err);
            }
        }
    };
    let Some(info) = info else {
        info!(
            run_id = %org_run_id,
            member_id = %member_id,
            "[inbox_wake] no materialized member session; inbox row remains pending"
        );
        return WakeRequestOutcome::SessionUnavailable;
    };

    // Recovery throttling follows the durable input being delivered, not just
    // the member's broad session status. A newly-arrived unread inbox row gets
    // a new fingerprint and is therefore dispatchable immediately even when a
    // previous wake for the same stopped session is still in backoff.
    let formal_receipt_batch_id = formal_receipt_rewake_fingerprint(formal_receipt_ids);
    let recovery_fingerprint = match formal_receipt_batch_id.as_ref() {
        Some(fingerprint) => fingerprint.clone(),
        None => match crate::coordination::agent_org_watchdog::member_rewake_fingerprint(
            org_run_id,
            member_id,
            info.status,
        ) {
            Ok(fingerprint) => fingerprint,
            Err(err) => {
                warn!(
                    run_id = %org_run_id,
                    member_id = %member_id,
                    error = %err,
                    "[inbox_wake] recovery fingerprint lookup failed; refusing wake"
                );
                return WakeRequestOutcome::Failed(err);
            }
        },
    };

    wake_session(
        app_handle,
        &info.session_id,
        info.status,
        member_id,
        org_run_id,
        &recovery_fingerprint,
        formal_receipt_batch_id.as_deref(),
    )
    .await
}

/// Give every bounded set of exact formal receipts its own recovery episode.
/// Re-ringing the same receipts therefore respects the existing cooldown,
/// while a newly committed fact (including an explicit final-summary retry)
/// can dispatch immediately even when the Coordinator's broad unread Inbox
/// watermark has not changed.
fn formal_receipt_rewake_fingerprint(receipt_ids: Option<&[String]>) -> Option<String> {
    let mut receipt_ids = receipt_ids?
        .iter()
        .filter(|receipt_id| !receipt_id.is_empty())
        .collect::<Vec<_>>();
    if receipt_ids.is_empty() {
        return None;
    }
    receipt_ids.sort_unstable();
    receipt_ids.dedup();
    let mut hasher = Sha256::new();
    for receipt_id in receipt_ids {
        hasher.update(receipt_id.len().to_le_bytes());
        hasher.update(receipt_id.as_bytes());
    }
    Some(format!("formal-receipts:{:x}", hasher.finalize()))
}

async fn wake_session(
    app_handle: AppHandle,
    session_id: &str,
    status: SessionStatus,
    recipient_member_id: &str,
    org_run_id: &str,
    recovery_fingerprint: &str,
    formal_receipt_batch_id: Option<&str>,
) -> WakeRequestOutcome {
    if !should_dispatch_wake(status) {
        info!(
            run_id = %org_run_id,
            member_id = %recipient_member_id,
            session_id = %session_id,
            status = status.as_str(),
            "[inbox_wake] session status is not wakeable; inbox row remains pending"
        );
        return WakeRequestOutcome::SessionUnavailable;
    }

    // Borrow `AgentAppState` from Tauri-managed state. Returning early
    // when this fails (test environments, headless callers) keeps the
    // hook safe to invoke unconditionally from `OrgSendMessageTool`.
    let state = match app_handle.try_state::<AgentAppState>() {
        Some(s) => s,
        None => {
            warn!(
                run_id = %org_run_id,
                member_id = %recipient_member_id,
                "[inbox_wake] AgentAppState not registered on app handle; cannot wake"
            );
            return WakeRequestOutcome::Failed("AgentAppState is unavailable".to_string());
        }
    };

    // Analyzer decisions are snapshots, and inbox/lifecycle hooks can request
    // wakes without going through the watchdog at all. Atomically reserve one
    // durable attempt immediately before crossing into the scheduler. This
    // makes the crash-safe direction conservative: a crash may spend one
    // cooldown, but an accepted provider turn can never escape budget
    // accounting. Failed/coalesced requests refund their own CAS token below.
    let reservation = match crate::coordination::agent_org_watchdog::reserve_member_rewake_dispatch(
        org_run_id,
        recipient_member_id,
        recovery_fingerprint,
    ) {
        Ok(crate::coordination::agent_org_watchdog::MemberRewakeReservationOutcome::Reserved(
            reservation,
        )) => reservation,
        Ok(crate::coordination::agent_org_watchdog::MemberRewakeReservationOutcome::Deferred) => {
            info!(
                run_id = %org_run_id,
                member_id = %recipient_member_id,
                session_id = %session_id,
                "[inbox_wake] durable recovery budget is in backoff or exhausted; deferring wake"
            );
            return WakeRequestOutcome::DeferredBackoff;
        }
        Err(err) => {
            warn!(
                run_id = %org_run_id,
                member_id = %recipient_member_id,
                session_id = %session_id,
                error = %err,
                "[inbox_wake] recovery budget reservation failed; refusing wake"
            );
            return WakeRequestOutcome::Failed(err);
        }
    };

    // Empty `content` + `is_resume=true` → processor skips persisting
    // an empty user row (see `should_save_user_msg` branch in
    // `processor/mod.rs`), then `inbox_drain` injects the inbox
    // payload as the user attachment at turn-boundary entry. The
    // resumed turn therefore opens with the inbox contents as user
    // input, exactly like a normal "user typed a message" turn.
    let result = crate::state::commands::session::message::send_message_impl_for_org_wake(
        &state,
        session_id.to_string(),
        org_run_id,
        recipient_member_id,
        formal_receipt_batch_id,
    )
    .await;
    match result {
        Ok(response) => {
            let coalesced = serde_json::from_str::<serde_json::Value>(&response.content)
                .ok()
                .and_then(|value| value.get("duplicate").and_then(serde_json::Value::as_bool))
                .unwrap_or(false);
            info!(
                run_id = %org_run_id,
                member_id = %recipient_member_id,
                session_id = %session_id,
                coalesced,
                "[inbox_wake] processed resume dispatch for stopped recipient"
            );
            if coalesced {
                if let Err(err) =
                    crate::coordination::agent_org_watchdog::refund_member_rewake_reservation(
                        &reservation,
                    )
                {
                    warn!(run_id = %org_run_id, member_id = %recipient_member_id, error = %err, "[inbox_wake] coalesced wake but failed to refund provisional recovery attempt");
                }
                WakeRequestOutcome::Coalesced
            } else {
                if let Err(err) =
                    crate::coordination::agent_org_watchdog::commit_member_rewake_reservation(
                        &reservation,
                    )
                {
                    warn!(run_id = %org_run_id, member_id = %recipient_member_id, error = %err, "[inbox_wake] accepted wake was charged, but clearing its reservation token failed");
                }
                WakeRequestOutcome::Enqueued
            }
        }
        Err(err) => {
            if let Err(refund_err) =
                crate::coordination::agent_org_watchdog::refund_member_rewake_reservation(
                    &reservation,
                )
            {
                warn!(run_id = %org_run_id, member_id = %recipient_member_id, error = %refund_err, "[inbox_wake] failed wake but provisional recovery attempt could not be refunded");
            }
            warn!(
                run_id = %org_run_id,
                member_id = %recipient_member_id,
                session_id = %session_id,
                error = %err,
                "[inbox_wake] resume turn dispatch failed"
            );
            WakeRequestOutcome::Failed(err)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wake_gate_dispatches_idle_and_terminal_member_sessions() {
        for status in [
            SessionStatus::Idle,
            SessionStatus::Completed,
            SessionStatus::Failed,
            SessionStatus::Cancelled,
            SessionStatus::Abandoned,
            SessionStatus::Timeout,
        ] {
            assert!(should_dispatch_wake(status), "status={}", status.as_str());
        }
    }

    #[test]
    fn wake_gate_does_not_double_dispatch_in_flight_or_archived_sessions() {
        for status in [
            SessionStatus::Running,
            SessionStatus::Pending,
            SessionStatus::Paused,
            SessionStatus::WaitingForUser,
            SessionStatus::WaitingForFunds,
            SessionStatus::Archived,
        ] {
            assert!(!should_dispatch_wake(status), "status={}", status.as_str());
        }
    }
}

#[cfg(test)]
#[path = "inbox_wake/tests/formal_receipt_wake_tests.rs"]
mod formal_receipt_wake_tests;
