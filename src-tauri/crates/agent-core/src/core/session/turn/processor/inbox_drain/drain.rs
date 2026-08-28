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
    drain_and_render_deferred_impl(
        org_context,
        recipient_agent_id,
        runtime_member_id,
        messages,
        session,
        None,
    )
}

/// Production typed-drain entry point. A TaskExecution Turn can only claim
/// the single formal Inbox row for its persisted Task binding; Coordinator
/// Turns retain the bounded coordinator Inbox drain. UserDirectedWork owns its
/// exact direct source and therefore claims no formal Inbox row here.
pub(crate) fn drain_and_render_deferred_for_turn(
    org_context: &AgentOrgRunContext,
    recipient_agent_id: &str,
    runtime_member_id: Option<&str>,
    messages: &mut Vec<Value>,
    session: Option<&AgentSession>,
    turn_context: &crate::coordination::agent_org_turn_contexts::AgentOrgTurnContext,
) -> DrainGuard {
    drain_and_render_deferred_impl(
        org_context,
        recipient_agent_id,
        runtime_member_id,
        messages,
        session,
        Some(turn_context),
    )
    .bind_formal_turn(turn_context)
}

fn drain_and_render_deferred_impl(
    org_context: &AgentOrgRunContext,
    recipient_agent_id: &str,
    runtime_member_id: Option<&str>,
    messages: &mut Vec<Value>,
    session: Option<&AgentSession>,
    turn_context: Option<&crate::coordination::agent_org_turn_contexts::AgentOrgTurnContext>,
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
                    intervention_receipt_id = %intervention.intervention_receipt_id,
                    intervention_status = %intervention.status.as_str(),
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

    let unread_result = match turn_context.map(|context| context.turn_kind) {
        Some(crate::coordination::agent_org_turn_contexts::AgentOrgTurnKind::TaskExecution) => {
            match turn_context {
                Some(context) if context.task_id.is_some() => {
                    AgentInboxStore::list_unread_task_input_for_turn(
                        recipient_member_id_value,
                        &org_context.run_id,
                        context.task_id.as_deref().expect("guarded Task id"),
                        &context.session_id,
                        &context.turn_intent_id,
                    )
                }
                _ => Err("TaskExecution context has no canonical task_id".to_string()),
            }
        }
        Some(crate::coordination::agent_org_turn_contexts::AgentOrgTurnKind::UserDirectedWork) => {
            return DrainGuard::empty(&org_context.run_id, recipient_member_id_value);
        }
        Some(crate::coordination::agent_org_turn_contexts::AgentOrgTurnKind::Coordinator) => {
            let context = turn_context.expect("Coordinator arm requires persisted context");
            match crate::coordination::agent_org_final_summary::is_summary_turn(
                &context.session_id,
                &context.turn_intent_id,
            ) {
                Ok(true) => {
                    return DrainGuard::empty(&org_context.run_id, recipient_member_id_value)
                }
                Ok(false) => {}
                Err(error) => {
                    warn!(
                        run_id = %org_context.run_id,
                        session_id = %context.session_id,
                        turn_intent_id = %context.turn_intent_id,
                        error = %error,
                        "summary-only authority lookup failed; refusing Inbox drain"
                    );
                    return DrainGuard::empty(&org_context.run_id, recipient_member_id_value);
                }
            }
            AgentInboxStore::list_formal_coordinator_input_for_turn(
                recipient_member_id_value,
                &org_context.run_id,
                &context.session_id,
                &context.turn_intent_id,
            )
        }
        None => AgentInboxStore::list_unread_batch_for_member(
            recipient_member_id_value,
            &org_context.run_id,
        ),
    };

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
/// 1. `PlanApprovalResponse` on a member's drain keeps a rejected plan in
///    Plan mode for revision. Current user decisions are authenticated by
///    the exact immutable revision/decision row; coordinator-sent accepted
///    rows remain historical compatibility for data written before exact
///    revision decisions became authoritative.
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
                request_id,
                accepted,
                feedback,
                next_mode,
                ..
            } => {
                // Rejections are still produced by the current revision flow.
                // Accepted responses are read-only legacy compatibility: new
                // approvals complete the planning task and never return the
                // Planner to an unrelated Build turn.
                match plan_response_is_authorized(
                    row,
                    org_context,
                    request_id.as_str(),
                    accepted,
                    feedback.as_deref(),
                ) {
                    Ok(true) => {}
                    Ok(false) => {
                        warn!(
                            session_id = %session.id,
                            inbox_id = row.id,
                            sender_agent_id = %row.sender_agent_id,
                            sender_member_id = ?row.sender_member_id,
                            "[inbox_drain] dropping plan_approval_response without exact decision authority"
                        );
                        continue;
                    }
                    Err(error) => {
                        return Err(format!(
                            "plan_approval_response_authority_lookup_failed:{}:{error}",
                            row.id
                        ));
                    }
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
                    "[inbox_drain] authorized plan approval response applied to this wake before drain"
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
                let disposition = (|| -> Result<_, String> {
                    let reservation =
                        crate::coordination::agent_org_watchdog::reserve_task_shutdown_release(
                            &org_context.run_id,
                            &member.member_id,
                        )?;
                    let actor = crate::coordination::agent_org_tasks::SystemArchiveOrRecovery::new(
                        reservation.token,
                        reservation.generation,
                        crate::coordination::agent_org_tasks::SystemTaskOperation::ShutdownRelease,
                    )?;
                    AgentOrgTaskStore::release_owner_for_shutdown(
                        actor,
                        &org_context.run_id,
                        &member.member_id,
                    )
                })();
                match disposition {
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

fn plan_response_is_authorized(
    row: &AgentInboxRecord,
    org_context: &AgentOrgRunContext,
    request_id: &str,
    accepted: bool,
    feedback: Option<&str>,
) -> Result<bool, String> {
    if row.sender_member_id.as_deref() == Some(COORDINATOR_MEMBER_ID) {
        return Ok(true);
    }
    if row.sender_agent_id != USER_SENDER_ID || row.sender_member_id.is_some() {
        return Ok(false);
    }
    let Some(recipient_member_id) = row.recipient_member_id.as_deref() else {
        return Ok(false);
    };
    let Some(revision) = crate::coordination::agent_org_plan_approvals::AgentOrgPlanRevisionStore::get_by_request_id(
        &org_context.run_id,
        request_id,
    )? else {
        return Ok(false);
    };
    Ok(user_plan_response_matches_revision(
        &revision,
        recipient_member_id,
        request_id,
        accepted,
        feedback,
    ))
}

pub(super) fn user_plan_response_matches_revision(
    revision: &crate::coordination::agent_org_plan_approvals::AgentOrgPlanRevision,
    recipient_member_id: &str,
    request_id: &str,
    accepted: bool,
    feedback: Option<&str>,
) -> bool {
    !accepted
        && revision.request_id == request_id
        && revision.source_member_id == recipient_member_id
        && revision.status
            == crate::coordination::agent_org_plan_approvals::AgentOrgPlanDecisionStatus::ChangesRequested
        && revision.decision_by.as_deref() == Some("user")
        && revision.feedback.as_deref() == feedback
}
