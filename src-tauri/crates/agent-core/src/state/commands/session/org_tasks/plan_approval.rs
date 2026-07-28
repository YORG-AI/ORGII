//! Agent Org plan-approval commands.
//!
//! When a run's plan-approval policy routes a plan revision to the user, these
//! commands fetch the revision detail and record the user's decision (approve,
//! approve-with-edits, or request-changes), then wake the affected members and
//! reconcile run finality off the durable transaction.

use crate::coordination::agent_inbox::USER_SENDER_ID;
use crate::coordination::agent_org_plan_approvals::{
    AgentOrgPlanApproval, AgentOrgPlanApprovalStore, AgentOrgPlanDecisionBy,
    AgentOrgPlanInboxDelivery,
};
use crate::coordination::agent_org_runs::AgentOrgRunStore;
use crate::state::AgentAppState;

use super::context::session_org_read_context;
use super::lifecycle::wake_agent_org_member;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentOrgPlanApprovalDecision {
    Approve,
    ApproveWithEdits,
    RequestChanges,
}

#[tauri::command]
pub async fn agent_org_plan_approval_detail(
    state: tauri::State<'_, AgentAppState>,
    session_id: String,
    approval_id: String,
    plan_revision_id: String,
) -> Result<AgentOrgPlanApproval, String> {
    let Some(read_context) = session_org_read_context(&state, &session_id).await? else {
        return Err(format!(
            "Session {session_id} is not part of an Agent Org run"
        ));
    };
    let context = read_context
        .context
        .ok_or_else(|| format!("Session {session_id} has no Agent Org context"))?;
    let lookup_approval_id = approval_id.clone();
    let lookup_revision_id = plan_revision_id.clone();
    let lookup_run_id = context.run_id.clone();
    let approval = tokio::task::spawn_blocking(move || {
        AgentOrgPlanApprovalStore::get_revision_for_run(
            &lookup_run_id,
            &lookup_approval_id,
            &lookup_revision_id,
        )
    })
    .await
    .map_err(|err| format!("Agent Org plan approval detail worker failed: {err}"))??
    .ok_or_else(|| {
        format!("Agent Org plan approval revision was not found: {approval_id}/{plan_revision_id}")
    })?;
    Ok(approval)
}

#[tauri::command]
// Tauri exposes command arguments as a flat invoke payload. Keeping these
// fields explicit preserves the stable frontend wire shape.
#[allow(clippy::too_many_arguments)]
pub async fn agent_org_plan_approval_respond(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AgentAppState>,
    session_id: String,
    approval_id: String,
    plan_revision_id: String,
    decision: AgentOrgPlanApprovalDecision,
    edited_content: Option<String>,
    feedback: Option<String>,
) -> Result<AgentOrgPlanApproval, String> {
    let Some(read_context) = session_org_read_context(&state, &session_id).await? else {
        return Err(format!(
            "Session {session_id} is not part of an Agent Org run"
        ));
    };
    let context = read_context
        .context
        .ok_or_else(|| format!("Session {session_id} has no Agent Org context"))?;
    let edited_content = match decision {
        AgentOrgPlanApprovalDecision::ApproveWithEdits => Some(
            edited_content
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| {
                    "approve_with_edits requires non-empty edited_content".to_string()
                })?,
        ),
        _ => None,
    };
    let feedback = match decision {
        AgentOrgPlanApprovalDecision::RequestChanges => Some(
            feedback
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "request_changes requires non-empty feedback".to_string())?
                .to_string(),
        ),
        _ => None,
    };
    let run_id = context.run_id.clone();
    let blocking_run_id = run_id.clone();
    let blocking_approval_id = approval_id.clone();
    let blocking_revision_id = plan_revision_id.clone();
    let blocking_context = context.clone();

    // Approval edits can touch SQLite and the plan artifact. Execute the
    // complete durable decision off Tokio's async executor; only dispatch
    // wake signals after the store transaction has committed.
    let (resolved, wake_member_ids, should_reconcile) = tokio::task::spawn_blocking(
        move || -> Result<(AgentOrgPlanApproval, Vec<String>, bool), String> {
            let approval =
                AgentOrgPlanApprovalStore::get(&blocking_approval_id)?.ok_or_else(|| {
                    format!("Agent Org plan approval {blocking_approval_id} was not found")
                })?;
            if approval.org_run_id != blocking_run_id {
                return Err("Agent Org plan approval does not belong to this run".to_string());
            }

            match decision {
                AgentOrgPlanApprovalDecision::Approve
                | AgentOrgPlanApprovalDecision::ApproveWithEdits => {
                    let approved = AgentOrgPlanApprovalStore::approve(
                        &blocking_approval_id,
                        &blocking_revision_id,
                        AgentOrgPlanDecisionBy::User,
                        edited_content,
                    )?;
                    Ok((approved.approval, approved.wake_member_ids, true))
                }
                AgentOrgPlanApprovalDecision::RequestChanges => {
                    let feedback = feedback.as_deref().ok_or_else(|| {
                        "request_changes feedback disappeared before commit".to_string()
                    })?;
                    let recipient_agent_id = blocking_context
                        .participant_agent_id(&approval.source_member_id)
                        .ok_or_else(|| {
                            format!(
                                "Agent Org plan source member {} is not in the run roster",
                                approval.source_member_id
                            )
                        })?;
                    let (changed, _) = AgentOrgPlanApprovalStore::request_changes(
                        &blocking_approval_id,
                        &blocking_revision_id,
                        AgentOrgPlanDecisionBy::User,
                        feedback,
                        AgentOrgPlanInboxDelivery {
                            recipient_agent_id,
                            sender_agent_id: USER_SENDER_ID.to_string(),
                            sender_member_id: None,
                        },
                    )?;
                    let source_member_id = changed.source_member_id.clone();
                    Ok((changed, vec![source_member_id], false))
                }
            }
        },
    )
    .await
    .map_err(|err| format!("Agent Org plan approval worker failed: {err}"))??;

    for member_id in wake_member_ids {
        wake_agent_org_member(app_handle.clone(), &member_id, &run_id);
    }
    if should_reconcile {
        let reconcile_run_id = run_id.clone();
        tokio::spawn(async move {
            match tokio::task::spawn_blocking(move || {
                AgentOrgRunStore::reconcile_run_finality(&reconcile_run_id)
            })
            .await
            {
                Ok(Ok(_)) => {}
                Ok(Err(err)) => tracing::warn!(
                    run_id,
                    error = %err,
                    "plan approval committed, but follow-up run reconciliation failed"
                ),
                Err(err) => tracing::warn!(
                    run_id,
                    error = %err,
                    "plan approval committed, but reconciliation worker failed"
                ),
            }
        });
    }
    Ok(resolved)
}
