//! Project-session root WorkItem bootstrap (orgtrack/v1 §7.2).
//!
//! A Project session that has no active WorkItem gets its root created
//! when the first non-empty user submission is accepted — not when the
//! mode is switched and not when an empty session is opened. The
//! creation boundary is this host event; no LLM classification is
//! involved. The root's body preserves the original user request
//! verbatim (the derived short title never replaces it), and the
//! operation runs under a `(sessionRef)`-derived idempotency key so a
//! retried first submission cannot produce a duplicate root: if an
//! earlier attempt created the item but failed to link it, the replay
//! returns the stored short id and only the link is re-applied.

use crate::foundation::session_bridge::TurnIntentBridgeSource;
use project_management::projects::types::{
    EnqueueWorkItemRunRequest, WorkItemRun, WorkItemRunTarget, WorkItemRunTargetSnapshot,
    WorkItemRunTrigger, PERSONAL_ORG_ID,
};

/// Bootstrap called from the message-accept path. Project mode is an explicit
/// product contract: execution must not silently degrade to plain Build when
/// its Work Item ledger cannot be made durable.
pub(super) async fn ensure_project_root_work_item(
    session_id: &str,
    content: &str,
) -> Result<Option<String>, String> {
    if content.trim().is_empty() {
        return Ok(None);
    }
    let sid = session_id.to_string();
    let body = content.to_string();
    match tokio::task::spawn_blocking(move || bootstrap_root_work_item(&sid, &body)).await {
        Ok(Ok(Some(short_id))) => {
            tracing::info!(
                session_id,
                short_id,
                "[project-bootstrap] created and linked root work item"
            );
            Ok(Some(short_id))
        }
        Ok(Ok(None)) => Ok(None),
        Ok(Err(err)) => Err(err),
        Err(err) => Err(format!("Project Work Item bootstrap worker failed: {err}")),
    }
}

/// Route an ordinary Project turn through the same durable dispatcher used by
/// Discussion, Stage and Routine. A dispatcher-owned `wir_*` turn is already
/// durable and passes through unchanged.
#[allow(clippy::too_many_arguments)]
pub(super) async fn enqueue_project_turn_if_needed(
    session_id: &str,
    content: &str,
    display_text: Option<&str>,
    turn_intent_id: &str,
    client_message_id: Option<&str>,
    source: TurnIntentBridgeSource,
) -> Result<Option<WorkItemRun>, String> {
    if content.trim().is_empty() || turn_intent_id.starts_with("wir_") {
        return Ok(None);
    }
    let sid = session_id.to_string();
    let record =
        tokio::task::spawn_blocking(move || crate::session::persistence::get_session(&sid))
            .await
            .map_err(|err| format!("Project Session lookup worker failed: {err}"))?
            .map_err(|err| format!("Project Session lookup failed: {err}"))?;
    let Some(record) = record else {
        return Ok(None);
    };
    if record.product_mode.as_deref() != Some("project") {
        return Ok(None);
    }
    let Some(work_item_id) = record.work_item_id.clone() else {
        return Err(format!(
            "Project Session {session_id} has no durable Work Item after bootstrap"
        ));
    };

    let trigger = match source {
        TurnIntentBridgeSource::UserSubmit
        | TurnIntentBridgeSource::ForceSend
        | TurnIntentBridgeSource::MobileRemote => WorkItemRunTrigger::Manual,
        TurnIntentBridgeSource::Queue => {
            let latest_session_id = session_id.to_string();
            let previous = tokio::task::spawn_blocking(move || {
                project_management::work_run_service::latest_for_session(&latest_session_id)
            })
            .await
            .map_err(|err| format!("Project follow-up lookup worker failed: {err}"))??;
            previous.map_or(WorkItemRunTrigger::Manual, |run| {
                WorkItemRunTrigger::FollowUp {
                    previous_run_id: run.id,
                }
            })
        }
        TurnIntentBridgeSource::Resume
        | TurnIntentBridgeSource::AgentOrg
        | TurnIntentBridgeSource::Wingman => return Ok(None),
    };

    let mut target_snapshot = WorkItemRunTargetSnapshot::new(WorkItemRunTarget::ResumeSession {
        session_id: session_id.to_string(),
    });
    target_snapshot.workspace_path = record
        .worktree_path
        .clone()
        .or_else(|| record.workspace_path.clone());
    target_snapshot.workspace_mode = Some(if record.worktree_path.is_some() {
        project_management::projects::types::WorkspaceExecutionMode::Worktree
    } else {
        project_management::projects::types::WorkspaceExecutionMode::LocalWorkspace
    });
    target_snapshot.repository = record.workspace_path.clone();
    target_snapshot.repository_ref = record
        .worktree_branch
        .clone()
        .or_else(|| record.base_branch.clone());
    target_snapshot.default_branch = record.base_branch.clone();
    target_snapshot.agent_definition_id = record.agent_definition_id.clone();

    let request = EnqueueWorkItemRunRequest {
        project_slug: record.project_slug,
        org_id: record.org_id.unwrap_or_else(|| PERSONAL_ORG_ID.to_string()),
        work_item_id,
        trigger,
        target_snapshot,
        input: serde_json::json!({
            "content": content,
            "displayText": display_text,
            "clientMessageId": client_message_id,
        }),
        idempotency_key: format!("project-session-turn:{session_id}:{turn_intent_id}"),
        max_attempts: 3,
        parent_run_id: None,
    };
    tokio::task::spawn_blocking(move || project_management::work_run_service::enqueue(request))
        .await
        .map_err(|err| format!("Project WorkItemRun enqueue worker failed: {err}"))?
        .map(Some)
}

/// Blocking core, also driven directly by the `Track this` command —
/// there the "first accepted submission" already happened, so the root
/// is created from the recorded user input at conversion time.
pub(crate) fn bootstrap_root_work_item(
    session_id: &str,
    content: &str,
) -> Result<Option<String>, String> {
    let record = crate::session::persistence::get_session(session_id)
        .map_err(|err| format!("load session record: {err}"))?;
    let Some(record) = record else {
        return Ok(None);
    };
    if record.product_mode.as_deref() != Some("project") || record.work_item_id.is_some() {
        return Ok(None);
    }

    let short_id = project_management::work_service::bootstrap_root_standalone_item(
        session_id,
        record.org_id.as_deref(),
        content,
    )?;

    crate::session::persistence::link_bootstrap_work_item(session_id, &short_id)
        .map_err(|err| format!("link bootstrap work item: {err}"))?;
    Ok(Some(short_id))
}
