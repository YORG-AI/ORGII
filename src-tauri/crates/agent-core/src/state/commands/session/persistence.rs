//! Persistence commands for session data (no Tauri state needed).

use crate::interaction::plan_approval::persistence::PlanApprovalStore;
use crate::persistence::db_helpers as shared;
use crate::persistence::session_snapshots;
use crate::session::persistence as session_persistence;
use crate::session::{SessionListFilter, SessionStatus};
use crate::state::control_flow::CancelReason;
use crate::state::AgentAppState;
use crate::tools::file_history;
use core_types::workflow::{AgentRole, LinkedSession, LinkedSessionStatus, LinkedSessionType};

use super::common::review_session_ids;

/// Load conversation messages for a session.
#[tauri::command]
pub async fn agent_load_messages(session_id: String) -> Result<Vec<serde_json::Value>, String> {
    shared::spawn_blocking_cmd(move || {
        let messages = session_persistence::load_messages(&session_id)?;
        messages.into_iter().map(shared::to_json_value).collect()
    })
    .await
}

/// Get a single session record by ID.
#[tauri::command]
pub async fn agent_get_session(session_id: String) -> Result<Option<serde_json::Value>, String> {
    shared::spawn_blocking_cmd(move || {
        session_persistence::get_session(&session_id)?
            .map(shared::to_json_value)
            .transpose()
    })
    .await
}

/// List all sessions from both OS and SDE, merged into one array.
#[tauri::command]
pub async fn agent_list_all_sessions() -> Result<Vec<serde_json::Value>, String> {
    shared::spawn_blocking_cmd(move || {
        let filter = SessionListFilter::default();
        let records = session_persistence::list_sessions(&filter)?;
        records.into_iter().map(shared::to_json_value).collect()
    })
    .await
}

/// Delete a session and all related data, including external relationships.
#[tauri::command]
pub async fn agent_delete_session(
    state: tauri::State<'_, AgentAppState>,
    session_id: String,
) -> Result<(), String> {
    delete_session_with_relationship_cleanup(&state, &session_id).await
}

/// Remove the Work Item relation while preserving the session and Project
/// context. This is intentionally separate from deletion so UI callers do
/// not need to reconstruct a project-only link after an unlink action.
#[tauri::command]
pub async fn agent_unlink_session_from_work_item(session_id: String) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || unlink_session_from_work_item(&session_id))
        .await
        .map_err(|err| err.to_string())?
}

/// Unlink a session from its Work Item without dropping its project context.
///
/// The Work Item is updated first. If its atomic write fails, the canonical
/// SQL relation is deliberately left intact so callers can retry without
/// losing the only pointer to the linked Work Item.
pub fn unlink_session_from_work_item(session_id: &str) -> Result<bool, String> {
    let session = session_persistence::get_session(session_id).map_err(|err| err.to_string())?;
    let Some(session) = session else {
        return Ok(false);
    };

    let work_item_id = session
        .work_item_id
        .as_deref()
        .filter(|id| !id.trim().is_empty());
    let Some(work_item_id) = work_item_id else {
        // Repair legacy project-only rows that stored an empty string instead
        // of SQL NULL without manufacturing a Work Item mutation.
        return session_persistence::clear_work_item_link(session_id)
            .map_err(|err| err.to_string());
    };
    let project_slug = session
        .project_slug
        .as_deref()
        .filter(|slug| !slug.trim().is_empty())
        .ok_or_else(|| {
            format!("Session {session_id} has work_item_id {work_item_id} but no project_slug")
        })?;

    let removed_link =
        remove_linked_session_from_work_item(project_slug, work_item_id, session_id)?;
    match session_persistence::clear_work_item_link(session_id) {
        Ok(true) => Ok(true),
        Ok(false) => {
            restore_linked_session_on_work_item(project_slug, work_item_id, removed_link)?;
            Err(format!(
                "Session not found while unlinking from Work Item: {session_id}"
            ))
        }
        Err(err) => {
            restore_linked_session_on_work_item(project_slug, work_item_id, removed_link)?;
            Err(err.to_string())
        }
    }
}

/// Perform the ordered teardown used by the user-visible delete command.
///
/// Relationship cleanup is fail-closed: a Work Item sync failure prevents
/// binding/runtime/cascade cleanup, leaving the canonical session record
/// available for an operator or retry to repair.
pub async fn delete_session_with_relationship_cleanup(
    state: &AgentAppState,
    session_id: &str,
) -> Result<(), String> {
    let session_id_owned = session_id.to_string();
    tokio::task::spawn_blocking(move || unlink_session_from_work_item(&session_id_owned))
        .await
        .map_err(|err| format!("Session unlink task failed: {err}"))??;

    state
        .gateway_bindings
        .clear_by_target(session_id)
        .await
        .map_err(|err| format!("Failed to clear Gateway bindings for {session_id}: {err}"))?;

    state
        .cancel_session(session_id, CancelReason::ProgrammaticShutdown)
        .await;
    state.remove_session(session_id).await;

    let session_id_owned = session_id.to_string();
    shared::spawn_blocking_cmd(move || session_persistence::delete_session(&session_id_owned)).await
}

/// Clear all messages for a session.
#[tauri::command]
pub async fn agent_clear_messages(session_id: String) -> Result<i64, String> {
    shared::spawn_blocking_cmd(move || session_persistence::clear_messages(&session_id)).await
}

/// Truncate messages at or after an anchor message.
///
/// The anchor is resolved to a `(sequence, created_at)` pair **from the
/// anchor row itself** — `sequence` drives the transcript truncation
/// (the only safe coordinate; see `truncate_messages_from_sequence`),
/// while the row's own `created_at` rewinds the timestamp-keyed side
/// stores (file-history, session snapshots). Resolution is fail-loud:
/// if neither `message_id` nor `created_at` matches an existing row, the
/// command errors instead of guessing — a silently-wrong anchor is how
/// the 2026-06-11 transcript wipe happened.
///
/// When `revert_files` is true (default behavior for edit/regenerate flows),
/// also rewinds the per-session file-history so edited files are restored to
/// their pre-turn state. When false (e.g. "continue with changes"), file
/// contents are left as-is and only message rows are dropped.
#[tauri::command]
pub async fn agent_truncate_after_message(
    state: tauri::State<'_, AgentAppState>,
    session_id: String,
    created_at: String,
    revert_files: Option<bool>,
    message_id: Option<String>,
) -> Result<i64, String> {
    if let Some(session) = state.get_session(&session_id).await {
        session.scheduler.invalidate_pending();
        session
            .cancel_active_turn(CancelReason::ModeSwitchAbort)
            .await;
    }

    let should_revert = revert_files.unwrap_or(true);
    tokio::task::spawn_blocking(move || -> Result<i64, String> {
        let anchor = match message_id.as_deref() {
            Some(message_id) => session_persistence::message_anchor(&session_id, message_id)
                .map_err(|err| err.to_string())?
                .ok_or_else(|| {
                    format!(
                        "Refusing to truncate session {session_id}: anchor message {message_id} not found"
                    )
                })?,
            None => session_persistence::anchor_at_or_after_created_at(&session_id, &created_at)
                .map_err(|err| err.to_string())?
                .ok_or_else(|| {
                    format!(
                        "Refusing to truncate session {session_id}: no message at or after {created_at}"
                    )
                })?,
        };
        let review_session_ids = review_session_ids(&session_id);
        if should_revert {
            for review_session_id in &review_session_ids {
                let stats = file_history::rewind_to_message(review_session_id, &anchor.created_at)
                    .map_err(|err| format!("file-history rewind failed for {review_session_id}: {err}"))?;
                tracing::info!(
                    "[agent_truncate] file-history rewind: session={} restored={} deleted={} skipped={} failed={}",
                    review_session_id,
                    stats.restored,
                    stats.deleted,
                    stats.skipped_unchanged,
                    stats.failed,
                );
            }
        }

        for review_session_id in &review_session_ids {
            session_snapshots::truncate_snapshots_after(review_session_id, &anchor.created_at)
                .map_err(|err| err.to_string())?;
        }
        PlanApprovalStore::delete_by_session(&session_id).map_err(|err| err.to_string())?;
        session_persistence::truncate_messages_from_sequence(&session_id, anchor.sequence)
            .map_err(|err| err.to_string())
    })
    .await
    .map_err(|err| err.to_string())?
}

/// Check whether rewinding to a message would modify files on disk. Used by
/// the frontend to decide whether to show a "keep or revert changes" dialog
/// before regenerating / editing a past message.
#[tauri::command]
pub async fn agent_check_snapshot_changes(
    session_id: String,
    created_at: String,
) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || {
        for review_session_id in review_session_ids(&session_id) {
            let has_changes =
                file_history::has_changes_after_message(&review_session_id, &created_at).map_err(
                    |e| format!("file-history check failed for {review_session_id}: {e}"),
                )?;
            if has_changes {
                return Ok(true);
            }
            let modified_files = session_snapshots::get_session_modified_files_after(
                &review_session_id,
                &created_at,
            )
            .map_err(|e| format!("file-change check failed for {review_session_id}: {e}"))?;
            if !modified_files.is_empty() {
                return Ok(true);
            }
        }
        Ok(false)
    })
    .await
    .map_err(|err| format!("Task error: {}", err))?
}

/// Update session status.
#[tauri::command]
pub async fn agent_update_session_status(
    session_id: String,
    status: String,
) -> Result<bool, String> {
    // Reject unknown status strings instead of silently downgrading to
    // `Idle` — that previously made stuck-state rows invisible (a row
    // wedged in a malformed terminal state would silently look idle to
    // the lifecycle manager).
    let parsed = crate::session::SessionStatus::parse(&status)
        .ok_or_else(|| format!("Unknown session status: {status:?}"))?;
    shared::spawn_blocking_cmd(move || session_persistence::update_status(&session_id, parsed))
        .await
}

/// Return the `workspace_path` for a session. Used by the frontend to resolve
/// file paths for the WorkStation diff view when opening a session's changes
/// from the Group Chat feed.
#[tauri::command]
pub async fn agent_get_session_workspace_path(
    session_id: String,
) -> Result<Option<String>, String> {
    shared::spawn_blocking_cmd(move || {
        crate::persistence::session_snapshots::get_session_workspace_path(&session_id)
    })
    .await
}

/// Save (upsert) a session record.
#[tauri::command]
pub async fn agent_save_session(session: serde_json::Value) -> Result<(), String> {
    let record: session_persistence::UnifiedSessionRecord = serde_json::from_value(session)
        .map_err(|err| format!("Failed to deserialize session: {}", err))?;
    shared::spawn_blocking_cmd(move || session_persistence::upsert_session(&record)).await
}

#[tauri::command]
pub async fn agent_link_session_to_work_item(
    app: tauri::AppHandle,
    session_id: String,
    org_id: Option<String>,
    project_slug: String,
    work_item_id: String,
    agent_role: Option<String>,
) -> Result<serde_json::Value, String> {
    let updated_record = tokio::task::spawn_blocking(move || {
        link_session_to_work_item_sync(
            &session_id,
            org_id.as_deref(),
            &project_slug,
            &work_item_id,
            agent_role.as_deref(),
        )
    })
    .await
    .map_err(|err| err.to_string())??;

    {
        use tauri::Emitter;
        let ts = chrono::Utc::now().to_rfc3339();
        let _ = app.emit(
            project_management::projects::events::DATA_CHANGED_EVENT,
            &ts,
        );
    }

    shared::to_json_value(updated_record).map_err(|err| err.to_string())
}

/// Associate an existing session with a Project without requiring a Work Item.
#[tauri::command]
pub async fn agent_link_session_to_project(
    app: tauri::AppHandle,
    session_id: String,
    project_slug: String,
) -> Result<serde_json::Value, String> {
    let updated_record = tokio::task::spawn_blocking(move || {
        let session = session_persistence::get_session(&session_id)
            .map_err(|err| err.to_string())?
            .ok_or_else(|| format!("Session not found: {session_id}"))?;
        let project = project_management::projects::io::read_project(&project_slug)
            .map_err(|err| format!("Failed to read project {project_slug}: {err}"))?;

        session_persistence::update_project_link(
            &session.session_id,
            &project.meta.org_id,
            &project.meta.id,
            &project.meta.name,
            &project_slug,
        )
        .map_err(|err| err.to_string())?
        .then_some(())
        .ok_or_else(|| format!("Session not found: {}", session.session_id))?;

        session_persistence::get_session(&session.session_id)
            .map_err(|err| err.to_string())?
            .ok_or_else(|| {
                format!(
                    "Session not found after project link: {}",
                    session.session_id
                )
            })
    })
    .await
    .map_err(|err| err.to_string())??;

    {
        use tauri::Emitter;
        let _ = app.emit(
            project_management::projects::events::DATA_CHANGED_EVENT,
            &chrono::Utc::now().to_rfc3339(),
        );
    }

    shared::to_json_value(updated_record).map_err(|err| err.to_string())
}

fn link_session_to_work_item_sync(
    session_id: &str,
    org_id: Option<&str>,
    project_slug: &str,
    work_item_id: &str,
    agent_role: Option<&str>,
) -> Result<session_persistence::UnifiedSessionRecord, String> {
    let session = session_persistence::get_session(session_id)
        .map_err(|err| err.to_string())?
        .ok_or_else(|| format!("Session not found: {session_id}"))?;

    let project = project_management::projects::io::read_project(project_slug)
        .map_err(|err| format!("Failed to read project {project_slug}: {err}"))?;
    if let Some(supplied_org_id) = org_id {
        if supplied_org_id != project.meta.org_id {
            return Err(format!(
                "Project {project_slug} belongs to org {}, not {}",
                project.meta.org_id, supplied_org_id
            ));
        }
    }

    if session.project_slug.as_deref() != Some(project_slug)
        || session.work_item_id.as_deref() != Some(work_item_id)
    {
        if let (Some(old_project_slug), Some(old_work_item_id)) = (
            session.project_slug.as_deref(),
            session.work_item_id.as_deref(),
        ) {
            if old_project_slug != project_slug || old_work_item_id != work_item_id {
                remove_linked_session_from_work_item(
                    old_project_slug,
                    old_work_item_id,
                    session_id,
                )?;
            }
        }
    }

    session_persistence::update_work_item_link(
        session_id,
        &project.meta.org_id,
        Some(&project.meta.id),
        Some(&project.meta.name),
        project_slug,
        work_item_id,
        agent_role,
    )
    .map_err(|err| err.to_string())?
    .then_some(())
    .ok_or_else(|| format!("Session not found: {session_id}"))?;

    upsert_linked_session_on_work_item(project_slug, work_item_id, &session, agent_role)?;

    session_persistence::get_session(session_id)
        .map_err(|err| err.to_string())?
        .ok_or_else(|| format!("Session not found after link: {session_id}"))
}

fn remove_linked_session_from_work_item(
    project_slug: &str,
    work_item_id: &str,
    session_id: &str,
) -> Result<LinkedSession, String> {
    let removed = project_management::projects::io::update_work_item_atomic(
        project_slug,
        work_item_id,
        |frontmatter, _body| {
            let removed = frontmatter
                .linked_sessions
                .iter()
                .position(|linked| linked.session_id == session_id)
                .map(|index| frontmatter.linked_sessions.remove(index));
            if removed.is_some() {
                frontmatter.updated_at = chrono::Utc::now().to_rfc3339();
            }
            Ok(removed)
        },
    )?;

    removed.ok_or_else(|| {
        format!(
            "Session {session_id} references Work Item {work_item_id} in project {project_slug}, but that Work Item does not link back to the session"
        )
    })
}

fn restore_linked_session_on_work_item(
    project_slug: &str,
    work_item_id: &str,
    removed_link: LinkedSession,
) -> Result<(), String> {
    project_management::projects::io::update_work_item_atomic(
        project_slug,
        work_item_id,
        |frontmatter, _body| {
            if !frontmatter
                .linked_sessions
                .iter()
                .any(|linked| linked.session_id == removed_link.session_id)
            {
                frontmatter.linked_sessions.push(removed_link);
                frontmatter.updated_at = chrono::Utc::now().to_rfc3339();
            }
            Ok(())
        },
    )
    .map(|_| ())
}

fn upsert_linked_session_on_work_item(
    project_slug: &str,
    work_item_id: &str,
    session: &session_persistence::UnifiedSessionRecord,
    agent_role: Option<&str>,
) -> Result<(), String> {
    project_management::projects::io::update_work_item_atomic(
        project_slug,
        work_item_id,
        |frontmatter, _body| {
            let linked = linked_session_from_record(session, agent_role);
            match frontmatter
                .linked_sessions
                .iter_mut()
                .find(|candidate| candidate.session_id == session.session_id)
            {
                Some(existing) => {
                    existing.session_type = linked.session_type;
                    existing.agent_role = linked.agent_role;
                    existing.status = linked.status;
                    existing.completed_at = linked.completed_at;
                    existing.total_tokens = linked.total_tokens;
                    if existing.result_preview.is_none() {
                        existing.result_preview = linked.result_preview;
                    }
                }
                None => frontmatter.linked_sessions.push(linked),
            }
            frontmatter.updated_at = chrono::Utc::now().to_rfc3339();
            Ok(())
        },
    )
    .map(|_| ())
}

fn linked_session_from_record(
    session: &session_persistence::UnifiedSessionRecord,
    agent_role: Option<&str>,
) -> LinkedSession {
    let status = linked_session_status(&session.status);
    let completed_at = matches!(
        status,
        LinkedSessionStatus::Completed
            | LinkedSessionStatus::Failed
            | LinkedSessionStatus::Cancelled
    )
    .then(|| session.updated_at.clone());
    LinkedSession {
        session_id: session.session_id.clone(),
        session_type: linked_session_type(&session.session_type),
        agent_role: parse_agent_role(agent_role.or(session.agent_role.as_deref())),
        started_at: session.created_at.clone(),
        completed_at,
        status,
        cost_usd: 0.0,
        total_tokens: session.total_tokens.max(0) as u64,
        parent_session_id: session.parent_session_id.clone(),
        sub_agent_name: None,
        sub_agent_instance: None,
        result_preview: session
            .name
            .is_empty()
            .then(|| session.user_input.clone())
            .flatten()
            .or_else(|| Some(session.name.clone())),
    }
}

fn linked_session_status(raw: &str) -> LinkedSessionStatus {
    match SessionStatus::parse(raw) {
        Some(SessionStatus::Failed) => LinkedSessionStatus::Failed,
        Some(SessionStatus::Cancelled | SessionStatus::Abandoned | SessionStatus::Timeout) => {
            LinkedSessionStatus::Cancelled
        }
        Some(
            SessionStatus::Running | SessionStatus::WaitingForUser | SessionStatus::WaitingForFunds,
        ) => LinkedSessionStatus::Running,
        _ => LinkedSessionStatus::Completed,
    }
}

fn linked_session_type(session_type: &str) -> LinkedSessionType {
    match session_type {
        session_persistence::session_type::CODING
        | session_persistence::session_type::GENERIC
        | session_persistence::session_type::DESKTOP
        | session_persistence::session_type::SUBAGENT
        | session_persistence::session_type::ORG_MEMBER => LinkedSessionType::Native,
        _ => LinkedSessionType::Native,
    }
}

fn parse_agent_role(raw: Option<&str>) -> AgentRole {
    match raw.unwrap_or_default() {
        "review" => AgentRole::Review,
        "orchestrator" => AgentRole::Orchestrator,
        "custom" => AgentRole::Custom,
        "sub_agent" => AgentRole::SubAgent,
        _ => AgentRole::Coding,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gateway::SessionKey;
    use crate::session::persistence::UnifiedSessionRecord;
    use core_types::key_source::KeySource;
    use test_helpers::test_env;

    fn seed_incomplete_session(session_id: &str) {
        let conn = database::db::get_connection().expect("test sqlite connection");
        crate::persistence::test_schema::ensure_agent_sessions_schema(&conn);
        session_persistence::init(&conn).expect("session persistence migrations");
        session_persistence::upsert_session(&UnifiedSessionRecord {
            session_id: session_id.to_string(),
            name: "partially linked session".to_string(),
            status: SessionStatus::Idle.as_str().to_string(),
            created_at: "2026-08-05T00:00:00Z".to_string(),
            updated_at: "2026-08-05T00:00:00Z".to_string(),
            session_type: session_persistence::session_type::GENERIC.to_string(),
            key_source: KeySource::OwnKey,
            project_slug: Some("missing-project".to_string()),
            work_item_id: Some("WI-404".to_string()),
            ..Default::default()
        })
        .expect("seed canonical session");
    }

    #[tokio::test]
    async fn delete_fails_closed_before_clearing_bindings_for_partial_relation() {
        let _sandbox = test_env::sandbox();
        let session_id = "sid-delete-fail-closed";
        seed_incomplete_session(session_id);

        let state = AgentAppState::new();
        let binding_key = SessionKey("telegram:delete-fail-closed".to_string());
        state
            .gateway_bindings
            .set(binding_key.clone(), session_id.to_string())
            .await;

        let err = delete_session_with_relationship_cleanup(&state, session_id)
            .await
            .expect_err("partial Work Item relation must stop deletion");
        assert!(
            !err.is_empty(),
            "the incomplete external relation must surface an error"
        );
        assert!(
            session_persistence::get_session(session_id)
                .expect("read session")
                .is_some(),
            "hard cascade must not run after relationship cleanup fails"
        );
        assert!(
            state.gateway_bindings.get(&binding_key).await.is_some(),
            "binding cleanup must not run after relationship cleanup fails"
        );
    }
}
