//! Direct member intervention and one-to-one messaging.
//!
//! When the user opens a member's session directly, the run enters a member
//! intervention so background dispatch pauses for that member. This module owns
//! entering/reading that state, returning a member to work (with the production
//! inbox-drain acknowledgement), and sending a direct user message to a member.

use std::time::{Duration, Instant};

use serde::Serialize;

use crate::coordination::agent_inbox::AgentInboxStore;
use crate::coordination::agent_member_interventions::{
    can_enter_member_intervention, AgentMemberInterventionRecord, AgentMemberInterventionStore,
    EnterMemberInterventionParams, DEFAULT_INTERVENTION_TTL_SECS,
};
#[cfg(test)]
use crate::coordination::agent_org_runs::AgentOrgRunContext;
use crate::persistence::AgentResponse;
use crate::state::commands::session::identity::IdentityOverrides;
use crate::state::commands::session::message::{send_message_impl, send_message_impl_for_org_wake};
use crate::state::AgentAppState;

use super::context::{require_session_member_id, session_org_read_context};
use super::run_view::agent_org_session_run_view_impl;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOrgSessionInterventionState {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub intervention: Option<AgentMemberInterventionRecord>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOrgDirectMemberMessageResponse {
    pub member_session_id: String,
    pub response: AgentResponse,
}

#[tauri::command]
pub async fn agent_org_session_enter_intervention(
    state: tauri::State<'_, AgentAppState>,
    session_id: String,
) -> Result<bool, String> {
    let Some(read_context) = session_org_read_context(&state, &session_id).await? else {
        return Ok(false);
    };
    let Some(ref context) = read_context.context else {
        return Ok(false);
    };
    let member_id = require_session_member_id(&read_context, &session_id)?;
    if !can_enter_member_intervention(&member_id) {
        tracing::debug!(
            org_run_id = %context.run_id,
            session_id = %session_id,
            "ordinary coordinator message does not enter member intervention"
        );
        return Ok(false);
    }
    let agent_id = context.require_participant_agent_id(&member_id)?;

    AgentMemberInterventionStore::enter(EnterMemberInterventionParams {
        org_run_id: context.run_id.clone(),
        member_id,
        agent_id,
        session_id,
        reason: Some("direct_user_chat".to_string()),
        ttl_secs: DEFAULT_INTERVENTION_TTL_SECS,
    })?;
    Ok(true)
}

#[tauri::command]
pub async fn agent_org_session_intervention_state(
    state: tauri::State<'_, AgentAppState>,
    session_id: String,
) -> Result<AgentOrgSessionInterventionState, String> {
    let Some(read_context) = session_org_read_context(&state, &session_id).await? else {
        return Ok(AgentOrgSessionInterventionState { intervention: None });
    };
    let Some(ref context) = read_context.context else {
        return Ok(AgentOrgSessionInterventionState { intervention: None });
    };
    let member_id = require_session_member_id(&read_context, &session_id)?;

    Ok(AgentOrgSessionInterventionState {
        intervention: AgentMemberInterventionStore::active_for_member(&context.run_id, &member_id)?,
    })
}

const RETURN_TO_WORK_INBOX_ACK_TIMEOUT: Duration = Duration::from_secs(90);
const RETURN_TO_WORK_INBOX_ACK_POLL_INTERVAL: Duration = Duration::from_millis(500);

async fn wait_for_member_inbox_rows_read(
    run_id: &str,
    member_id: &str,
    boundary_id: Option<i64>,
) -> Result<(), String> {
    let Some(boundary_id) = boundary_id else {
        return Ok(());
    };

    let started_at = Instant::now();
    loop {
        let poll_run_id = run_id.to_string();
        let poll_member_id = member_id.to_string();
        let pending_count = tokio::task::spawn_blocking(move || {
            AgentInboxStore::unread_count_through_boundary(
                &poll_member_id,
                &poll_run_id,
                boundary_id,
            )
        })
        .await
        .map_err(|error| format!("Agent Org inbox acknowledgement poll failed: {error}"))??;
        if pending_count == 0 {
            return Ok(());
        }
        if started_at.elapsed() >= RETURN_TO_WORK_INBOX_ACK_TIMEOUT {
            return Err(format!(
                "Agent Org return-to-work wake did not drain {pending_count} inbox rows for member {member_id} through row {boundary_id}"
            ));
        }
        tokio::time::sleep(RETURN_TO_WORK_INBOX_ACK_POLL_INTERVAL).await;
    }
}

#[tauri::command]
pub async fn agent_org_session_return_to_work(
    state: tauri::State<'_, AgentAppState>,
    session_id: String,
) -> Result<bool, String> {
    agent_org_session_return_to_work_impl(&state, session_id).await
}

/// Production return-to-work implementation shared by the Tauri command and
/// the debug HTTP caller-path E2E bridge.
///
/// Keeping the implementation here (rather than recreating it in the test
/// API) is deliberate: both callers clear the same intervention state, enqueue
/// through [`send_message_impl_for_org_wake`], run the real session scheduler,
/// and wait for the production inbox drain to acknowledge exactly the rows
/// that were pending when the wake was requested.
pub async fn agent_org_session_return_to_work_impl(
    state: &AgentAppState,
    session_id: String,
) -> Result<bool, String> {
    let Some(read_context) = session_org_read_context(state, &session_id).await? else {
        return Ok(false);
    };
    let Some(ref context) = read_context.context else {
        return Ok(false);
    };
    let member_id = require_session_member_id(&read_context, &session_id)?;

    let pending_member_id = member_id.clone();
    let pending_run_id = context.run_id.clone();
    let (changed, pending_inbox_boundary) = tokio::task::spawn_blocking(move || {
        AgentMemberInterventionStore::clear_and_capture_unread_boundary(
            &pending_run_id,
            &pending_member_id,
        )
    })
    .await
    .map_err(|error| format!("Agent Org return-to-work state worker failed: {error}"))??;
    if changed || pending_inbox_boundary.is_some() {
        send_message_impl_for_org_wake(state, session_id, &context.run_id, &member_id).await?;
        wait_for_member_inbox_rows_read(&context.run_id, &member_id, pending_inbox_boundary)
            .await?;
        return Ok(true);
    }
    Ok(false)
}

#[tauri::command]
pub async fn agent_org_send_user_message_to_member(
    state: tauri::State<'_, AgentAppState>,
    session_id: String,
    member_id: String,
    content: String,
) -> Result<AgentOrgDirectMemberMessageResponse, String> {
    agent_org_send_user_message_to_member_impl(&state, session_id, member_id, content).await
}

pub async fn agent_org_send_user_message_to_member_impl(
    state: &AgentAppState,
    session_id: String,
    member_id: String,
    content: String,
) -> Result<AgentOrgDirectMemberMessageResponse, String> {
    let member_id = member_id.trim();
    if member_id.is_empty() {
        return Err("Agent Org member id is required".to_string());
    }
    if content.trim().is_empty() {
        return Err("Agent Org member message content is required".to_string());
    }

    let view = agent_org_session_run_view_impl(state, &session_id)
        .await?
        .ok_or_else(|| format!("Session {session_id} is not part of an Agent Org run"))?;
    let org_run_id = view.context.run_id.clone();
    let member = view
        .members
        .into_iter()
        .find(|candidate| candidate.member_id == member_id)
        .ok_or_else(|| {
            format!("Agent Org member {member_id} was not found for session {session_id}")
        })?;
    let runtime = member.session_runtime.ok_or_else(|| {
        format!(
            "Agent Org member {} does not have a materialized session",
            member.member_id
        )
    })?;
    let member_session_id = runtime.session_id;

    let response = send_message_impl(
        state,
        member_session_id.clone(),
        content,
        None,
        IdentityOverrides::default(),
        None,
        None,
        None,
        false,
        true,
        None,
        None,
        None,
        Some(org_run_id),
        crate::foundation::session_bridge::TurnIntentBridgeSource::AgentOrg,
    )
    .await?;

    Ok(AgentOrgDirectMemberMessageResponse {
        member_session_id,
        response,
    })
}

#[cfg(test)]
pub(super) fn clear_group_chat_target_intervention(
    context: &AgentOrgRunContext,
    target_member_id: &str,
) -> Result<bool, String> {
    AgentMemberInterventionStore::clear(&context.run_id, target_member_id)
}
