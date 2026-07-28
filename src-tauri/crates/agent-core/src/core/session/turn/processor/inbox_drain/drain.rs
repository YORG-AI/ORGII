//! Core drain logic: [`drain_and_render_deferred`] and typed side effects.

use serde_json::Value;
use tracing::{info, warn};

use crate::coordination::agent_inbox::{
    AgentInboxRecord, AgentInboxStore, AgentMessage, InsertInboxParams, MemberTerminationReason,
    SYSTEM_SENDER_ID, USER_SENDER_ID,
};
use crate::coordination::agent_member_interventions::AgentMemberInterventionStore;
use crate::coordination::agent_org_runs::{AgentOrgRunContext, COORDINATOR_MEMBER_ID};
use crate::coordination::agent_org_tasks::AgentOrgTaskStore;
use crate::state::AgentSession;

use super::guard::DrainGuard;
use super::hooks::{current_member_shutdown_hook, MemberShutdownHook};
use super::render::{render_inbox_attachment, render_inbox_transcript};
use super::routing::{resolve_recipient_member_id, resolve_sender_member};

/// Drain unread inbox rows, render the attachment into `messages`, and
/// apply side effects — but **defer** marking the rows as read until
/// the caller invokes [`DrainGuard::commit`] after the turn succeeds.
///
/// This is the production entry point. The legacy [`drain_and_render`]
/// wrapper exists only for unit tests that don't want to thread a
/// guard through.
///
/// Returns a [`DrainGuard`] whose `drained_count()` equals the number
/// of inbox rows that were drained-and-rendered. A count of `0` means
/// either the inbox was empty for this recipient in this run, or the
/// lookup itself failed (failures are logged, never propagated, because
/// a stale-inbox surface is strictly better than a hard-failed turn).
///
/// `session` is `Some` in production and `None` in pure rendering tests.
/// When present, the drain also applies side effects keyed on specific
/// payload kinds — currently:
///
///   * `PlanApprovalResponse` stages another Plan turn for revision. The
///     accepted branch remains only for historical rows from the former
///     remote-mode-switch protocol; new approvals complete the source task
///     before anything is delivered to the Planner.
///   * `ShutdownResponse { accepted: true }` from a member to the
///     coordinator triggers `shutdown_hook.cancel_member_session` on
///     the member's runtime AND inserts a system-emitted
///     `MemberTerminated` row into the coordinator's own inbox so the
///     coordinator's LLM has explicit signal on the next turn.
///
/// The shutdown hook is resolved from the process-wide installation
/// performed at app boot (`install_member_shutdown_hook`); tests can
/// install a stub via the same setter.
pub fn drain_and_render_deferred(
    org_context: &AgentOrgRunContext,
    recipient_agent_id: &str,
    runtime_member_id: Option<&str>,
    messages: &mut Vec<Value>,
    session: Option<&AgentSession>,
) -> DrainGuard {
    let shutdown_hook = current_member_shutdown_hook();

    let recipient_member_id = runtime_member_id
        .filter(|member_id| !member_id.trim().is_empty())
        .map(str::to_string)
        .or_else(|| resolve_recipient_member_id(org_context, recipient_agent_id, session));

    if let Some(member_id) = recipient_member_id.as_deref() {
        match AgentMemberInterventionStore::active_for_member(&org_context.run_id, member_id) {
            Ok(Some(intervention)) => {
                info!(
                    run_id = %org_context.run_id,
                    member_id = %member_id,
                    session_id = %intervention.session_id,
                    resume_after = %intervention.resume_after,
                    "[inbox_drain] skipping drain while member is in user_intervention"
                );
                return DrainGuard::empty(&org_context.run_id, member_id);
            }
            Ok(None) => {}
            Err(err) => {
                warn!(
                    run_id = %org_context.run_id,
                    member_id = %member_id,
                    error = %err,
                    "[inbox_drain] member intervention lookup failed; skipping drain to preserve direct user chat priority"
                );
                return DrainGuard::empty(&org_context.run_id, member_id);
            }
        }
    }

    let Some(recipient_member_id_value) = recipient_member_id.as_deref() else {
        return DrainGuard::empty(&org_context.run_id, "unknown");
    };

    let unread_result = AgentInboxStore::list_unread_batch_for_member(
        recipient_member_id_value,
        &org_context.run_id,
    );

    let batch = match unread_result {
        Ok(batch) => batch,
        Err(err) => {
            warn!(
                run_id = %org_context.run_id,
                member_id = %recipient_member_id_value,
                error = %err,
                "[inbox_drain] bounded unread batch failed; skipping injection for this turn"
            );
            return DrainGuard::empty(&org_context.run_id, recipient_member_id_value);
        }
    };
    let unread = batch.rows;
    if unread.is_empty() {
        return DrainGuard::empty(&org_context.run_id, recipient_member_id_value);
    }
    if batch.has_more {
        info!(
            run_id = %org_context.run_id,
            member_id = %recipient_member_id_value,
            delivered = unread.len(),
            "[inbox_drain] bounded inbox batch left additional unread rows for the post-turn re-wake"
        );
    }

    let mut unread = unread;
    unread.sort_by_key(|row| {
        let is_user_group_message = row.sender_agent_id == USER_SENDER_ID;
        (!is_user_group_message, row.id)
    });

    let pending_ids = unread.iter().map(|row| row.id).collect::<Vec<_>>();
    let (materialized_ids, materializations) = if let Some(session) = session {
        match crate::session::persistence::load_agent_org_inbox_transcript_materializations(
            &session.id,
            &pending_ids,
        ) {
            Ok(existing) => existing,
            Err(err) => {
                warn!(
                    run_id = %org_context.run_id,
                    member_id = %recipient_member_id_value,
                    session_id = %session.id,
                    error = %err,
                    "[inbox_drain] materialization lookup failed; leaving source rows unread"
                );
                return DrainGuard::empty(&org_context.run_id, recipient_member_id_value);
            }
        }
    } else {
        (std::collections::HashSet::new(), Vec::new())
    };
    let newly_materialized_rows = unread
        .iter()
        .filter(|row| !materialized_ids.contains(&row.id))
        .cloned()
        .collect::<Vec<_>>();

    // Apply durable/control side effects before exposing this batch to the
    // provider. If a required shutdown disposition or causation notice cannot
    // commit, leave every source row unread and retry the idempotent side
    // effect on a later Wake. This prevents a successful provider turn from
    // acknowledging the ShutdownResponse while permanently losing its
    // MemberTerminated notification.
    if let Some(session) = session {
        if let Err(err) =
            apply_payload_side_effects(&unread, session, org_context, shutdown_hook.as_ref())
        {
            warn!(
                run_id = %org_context.run_id,
                member_id = %recipient_member_id_value,
                error = %err,
                "[inbox_drain] required inbox side effect failed; leaving batch unread"
            );
            return DrainGuard::empty(&org_context.run_id, recipient_member_id_value);
        }
    }

    if newly_materialized_rows.is_empty() {
        info!(
            run_id = %org_context.run_id,
            member_id = %recipient_member_id_value,
            replayed = pending_ids.len(),
            "[inbox_drain] source rows already have durable transcript receipts; retrying from session history"
        );
        return DrainGuard::drained(
            &org_context.run_id,
            recipient_member_id_value,
            session.map(|session| session.id.as_str()),
            pending_ids,
            Vec::new(),
            None,
            materializations,
        );
    }

    let rendered = render_inbox_attachment(&newly_materialized_rows, org_context);
    let transcript = render_inbox_transcript(&newly_materialized_rows);
    messages.push(serde_json::json!({
        "role": "user",
        "content": rendered.clone(),
    }));

    let new_materialization_ids = newly_materialized_rows
        .iter()
        .map(|row| row.id)
        .collect::<Vec<_>>();
    info!(
        run_id = %org_context.run_id,
        member_id = %recipient_member_id_value,
        injected = newly_materialized_rows.len(),
        replayed = materialized_ids.len(),
        "[inbox_drain] injected inbox attachments at turn boundary (mark-read deferred to commit)"
    );
    DrainGuard::drained(
        &org_context.run_id,
        recipient_member_id_value,
        session.map(|session| session.id.as_str()),
        pending_ids,
        new_materialization_ids,
        Some(transcript),
        materializations,
    )
}

/// Test-only wrapper: drain + render + immediately commit. Production
/// code MUST use [`drain_and_render_deferred`] so that mark-read can be
/// gated on turn success.
#[cfg(test)]
pub fn drain_and_render(
    org_context: &AgentOrgRunContext,
    recipient_agent_id: &str,
    runtime_member_id: Option<&str>,
    messages: &mut Vec<Value>,
    session: Option<&AgentSession>,
) -> usize {
    let guard = drain_and_render_deferred(
        org_context,
        recipient_agent_id,
        runtime_member_id,
        messages,
        session,
    );
    let count = guard.drained_count();
    guard.commit_without_materialization_for_test();
    count
}

/// Apply payload-driven side effects to the recipient session.
///
/// Two payload kinds drive side effects today:
///
/// 1. `PlanApprovalResponse` from the coordinator on a member's drain
///    keeps a rejected plan in Plan mode for revision. The accepted branch
///    is historical compatibility for rows written before task-bound plan
///    approvals. Defence-in-depth: only honour rows whose sender is the
///    coordinator.
///
/// 2. `ShutdownResponse { accepted: true }` from a member on the
///    coordinator's drain — invokes `shutdown_hook.cancel_member_session`
///    on the member's runtime and inserts a system-emitted
///    `MemberTerminated` row into the coordinator's own inbox so the
///    coordinator's LLM is told on its next turn that the worker is
///    gone. Defence-in-depth: only honour rows where the recipient
///    is the coordinator AND the sender is a known org member (i.e.
///    exists in `org_context.members`); a self-issued or
///    stranger-sourced row is dropped.
///
/// Invalid/unauthorized historical messages are logged and ignored. Failures
/// in required shutdown persistence are returned so the caller can leave the
/// source batch unread and retry these idempotent side effects.
fn apply_payload_side_effects(
    rows: &[AgentInboxRecord],
    session: &AgentSession,
    org_context: &AgentOrgRunContext,
    shutdown_hook: &dyn MemberShutdownHook,
) -> Result<(), String> {
    for row in rows {
        let msg = match row.decode_payload() {
            Ok(msg) => msg,
            Err(err) => {
                // Render-side already shows a `<raw decode_error=…>` block
                // to the LLM so the row isn't lost from history; this side-
                // effect path is the one that triggers plan-approval exit
                // and shutdown_hook.cancel_member_session, so a silent skip
                // here means the user-visible action never fires.
                warn!(
                    session_id = %session.id,
                    inbox_id = row.id,
                    error = %err,
                    "[inbox_drain] decode_payload failed in side-effect pass; \
                     plan-approval / shutdown actions for this row will not run"
                );
                continue;
            }
        };
        match msg {
            AgentMessage::PlanApprovalResponse {
                accepted,
                next_mode,
                ..
            } => {
                // Rejections are still produced by the current revision flow.
                // Accepted responses are read-only legacy compatibility: new
                // approvals complete the planning task and never return the
                // Planner to an unrelated Build turn.
                if row.sender_member_id.as_deref() != Some(COORDINATOR_MEMBER_ID) {
                    warn!(
                        session_id = %session.id,
                        inbox_id = row.id,
                        sender_member_id = ?row.sender_member_id,
                        coordinator_member_id = COORDINATOR_MEMBER_ID,
                        "[inbox_drain] dropping plan_approval_response from non-coordinator sender — \
                         ignoring to prevent member-to-member approval forgery"
                    );
                    continue;
                }
                let target_mode = next_mode.unwrap_or(if accepted {
                    crate::session::AgentExecMode::Build
                } else {
                    crate::session::AgentExecMode::Plan
                });
                if accepted {
                    session.plan_slot_cache.clear(&session.id);
                    let _ = session.pre_plan_mode_cache.take(&session.id);
                    crate::bus::broadcast_event(
                        "agent:exit_plan_mode",
                        serde_json::json!({
                            "sessionId": session.id,
                            "source": "agent_org_plan_approval",
                            "nextMode": target_mode.as_str(),
                        }),
                    );
                }
                info!(
                    session_id = %session.id,
                    inbox_id = row.id,
                    accepted = accepted,
                    next_mode = %target_mode.as_str(),
                    "[inbox_drain] coordinator plan approval response applied to this wake before drain"
                );
            }
            AgentMessage::ShutdownResponse { accepted: true, .. } => {
                if row.recipient_member_id.as_deref() != Some(COORDINATOR_MEMBER_ID) {
                    // Member-to-member shutdown_response is rejected at
                    // build time (`org_send_message`); guard the
                    // unlikely case it landed via another producer.
                    warn!(
                        session_id = %session.id,
                        inbox_id = row.id,
                        recipient_member_id = ?row.recipient_member_id,
                        coordinator_member_id = COORDINATOR_MEMBER_ID,
                        "[inbox_drain] dropping shutdown_response side effect — recipient is not the coordinator"
                    );
                    continue;
                }
                let Some(member) = resolve_sender_member(org_context, row) else {
                    warn!(
                        session_id = %session.id,
                        inbox_id = row.id,
                        sender = %row.sender_agent_id,
                        sender_member_id = ?row.sender_member_id,
                        "[inbox_drain] dropping shutdown_response side effect — sender is not a known org member"
                    );
                    continue;
                };

                shutdown_hook.cancel_member_session(&member.member_id, &org_context.run_id);

                // Disposition any open tasks the intentionally stopped member
                // still owns: release to an eligible peer pool, or escalate to
                // the coordinator when no peer exists. Errors are logged and
                // swallowed — bookkeeping rot is
                // strictly less bad than failing the whole drain over a
                // task table hiccup; the next coordinator turn will
                // observe whatever state the store is actually in.
                match AgentOrgTaskStore::dispose_open_tasks_for_shutdown(
                    &org_context.run_id,
                    &member.member_id,
                ) {
                    Ok(disposed) if !disposed.is_empty() => {
                        let released_count =
                            disposed.iter().filter(|task| task.owner.is_none()).count();
                        info!(
                            session_id = %session.id,
                            inbox_id = row.id,
                            terminated_member = %member.member_id,
                            disposed_count = disposed.len(),
                            released_count,
                            "[inbox_drain] applied shutdown disposition to terminated member tasks"
                        );
                    }
                    Ok(_) => {}
                    Err(err) => {
                        warn!(
                            session_id = %session.id,
                            inbox_id = row.id,
                            terminated_member = %member.member_id,
                            error = %err,
                            "[inbox_drain] failed to release tasks for terminated member; tasks may be stranded"
                        );
                        return Err(format!(
                            "shutdown task disposition failed for member {}: {err}",
                            member.member_id
                        ));
                    }
                }

                match AgentInboxStore::insert_once_for_causation(
                    InsertInboxParams {
                        recipient_agent_id: org_context.coordinator_agent_id.clone(),
                        recipient_member_id: Some(COORDINATOR_MEMBER_ID.to_string()),
                        sender_agent_id: SYSTEM_SENDER_ID.to_string(),
                        sender_member_id: None,
                        org_run_id: Some(org_context.run_id.clone()),
                        message: AgentMessage::MemberTerminated {
                            member_id: member.member_id.clone(),
                            member_name: member.name.clone(),
                            reason: MemberTerminationReason::Shutdown,
                        },
                    },
                    row.id,
                ) {
                    Ok((record, true)) => {
                        shutdown_hook.wake_coordinator(&org_context.run_id);
                        info!(
                            session_id = %session.id,
                            inbox_id = row.id,
                            terminated_member = %member.member_id,
                            terminated_name = %member.name,
                            new_inbox_id = record.id,
                            "[inbox_drain] member acknowledged shutdown; cancelled session and notified coordinator"
                        );
                    }
                    Ok((record, false)) => {
                        info!(
                            session_id = %session.id,
                            inbox_id = row.id,
                            terminated_member = %member.member_id,
                            existing_inbox_id = record.id,
                            "[inbox_drain] shutdown notification already persisted for this source row; coalesced replay"
                        );
                    }
                    Err(err) => {
                        warn!(
                            session_id = %session.id,
                            inbox_id = row.id,
                            terminated_member = %member.member_id,
                            error = %err,
                            "[inbox_drain] failed to persist MemberTerminated row; coordinator will not be notified this turn"
                        );
                        return Err(format!(
                            "persist MemberTerminated for member {} failed: {err}",
                            member.member_id
                        ));
                    }
                }
            }
            AgentMessage::ExecModeSetRequest { mode, .. } => {
                // Coordinator-driven mode override on a member.
                // Defence-in-depth: only honour the request if
                // the sender is actually the org coordinator (the
                // build-side guard in `org_send_message` already
                // enforces this; we re-check here so a row that
                // somehow lands from another producer is still safe).
                if row.sender_member_id.as_deref() != Some(COORDINATOR_MEMBER_ID) {
                    warn!(
                        session_id = %session.id,
                        inbox_id = row.id,
                        sender_member_id = ?row.sender_member_id,
                        coordinator_member_id = COORDINATOR_MEMBER_ID,
                        "[inbox_drain] dropping exec_mode_set_request from non-coordinator sender"
                    );
                    continue;
                }
                info!(
                    session_id = %session.id,
                    inbox_id = row.id,
                    new_mode = %mode.as_str(),
                    "[inbox_drain] coordinator exec mode override was applied to this wake before drain"
                );
            }
            _ => {}
        }
    }
    Ok(())
}
