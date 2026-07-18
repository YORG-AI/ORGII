//! Persistence commands for session data (no Tauri state needed).

use crate::coordination::agent_org_runs::AgentOrgRunStore;
use crate::interaction::plan_approval::persistence::PlanApprovalStore;
use crate::persistence::db_helpers as shared;
use crate::persistence::session_snapshots;
use crate::session::persistence as session_persistence;
use crate::session::{SessionListFilter, SessionStatus};
use crate::state::control_flow::CancelReason;
use crate::state::AgentAppState;
use crate::tools::file_history;
use core_types::workflow::{AgentRole, LinkedSession, LinkedSessionStatus, LinkedSessionType};
use database::db::get_connection;
use rusqlite::OptionalExtension;

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

/// Delete a session and all related data.
#[tauri::command]
pub async fn agent_delete_session(session_id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || delete_session_with_agent_org_history(&session_id))
        .await
        .map_err(|err| format!("session deletion worker failed: {err}"))?
}

fn delete_session_with_agent_org_history(session_id: &str) -> Result<(), String> {
    // Only the coordinator/root session owns a Run. Deleting a worker session
    // must not erase the rest of the team execution. Capture and remove the
    // owned Run first so a subsequent session-row failure remains retryable
    // and can never silently leave permanent Inbox/Plan history behind.
    if let Some(run_id) = owned_agent_org_run_id(session_id)? {
        AgentOrgRunStore::delete_by_id(&run_id)?;
    }
    session_persistence::delete_session(session_id).map_err(|err| err.to_string())
}

fn owned_agent_org_run_id(session_id: &str) -> Result<Option<String>, String> {
    get_connection()
        .map_err(|err| err.to_string())?
        .query_row(
            "SELECT id FROM agent_org_runs WHERE root_session_id=?1 LIMIT 1",
            [session_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| err.to_string())
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
) -> Result<(), String> {
    project_management::projects::io::update_work_item_atomic(
        project_slug,
        work_item_id,
        |frontmatter, _body| {
            let original_len = frontmatter.linked_sessions.len();
            frontmatter
                .linked_sessions
                .retain(|linked| linked.session_id != session_id);
            if frontmatter.linked_sessions.len() != original_len {
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

    fn ensure_test_schemas() {
        let conn = get_connection().expect("sandbox DB");
        crate::persistence::test_schema::ensure_agent_sessions_schema(&conn);
        crate::foundation::persistence::session_snapshots::ensure_tables_with(&conn)
            .expect("agent session tables");
        crate::session::persistence::init(&conn).expect("unified session schema");
        crate::interaction::plan_approval::persistence::init_schema(&conn)
            .expect("plan approval schema");
        crate::coordination::init_agent_org_schemas(&conn).expect("Agent Org schemas");
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS events (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS code_sessions (
                session_id TEXT PRIMARY KEY,
                cli_agent_type TEXT NOT NULL,
                status TEXT NOT NULL,
                parent_session_id TEXT,
                org_member_id TEXT,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS session_turn_intents (
                session_id TEXT NOT NULL,
                turn_intent_id TEXT NOT NULL,
                client_message_id TEXT,
                org_run_id TEXT,
                source TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (session_id, turn_intent_id)
            );",
        )
        .expect("session runtime schemas");
    }

    fn seed_session(session_id: &str, parent_session_id: Option<&str>) {
        let conn = get_connection().expect("sandbox DB");
        conn.execute(
            "INSERT INTO agent_sessions (
                 session_id, name, status, user_input, created_at, updated_at,
                 session_type, parent_session_id, workspace_additional_json,
                 key_source
             ) VALUES (?1, ?2, 'idle', NULL, ?3, ?3, 'agent', ?4, '{}', 'own_key')",
            rusqlite::params![
                session_id,
                format!("session-{session_id}"),
                "2026-07-16T00:00:00Z",
                parent_session_id,
            ],
        )
        .expect("seed session");
    }

    fn seed_run(run_id: &str, root_session_id: &str) {
        let conn = get_connection().expect("sandbox DB");
        conn.execute(
            "INSERT INTO agent_org_runs (
                 id, org_id, coordinator_agent_id, root_session_id,
                 entry_mode, status, created_at, updated_at
             ) VALUES (?1, 'org-delete-test', 'coordinator-agent', ?2,
                       'standalone_session', 'running', ?3, ?3)",
            rusqlite::params![run_id, root_session_id, "2026-07-16T00:00:00Z"],
        )
        .expect("seed run");
    }

    fn row_exists(table: &str, column: &str, value: &str) -> bool {
        get_connection()
            .expect("sandbox DB")
            .query_row(
                &format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE {column}=?1)"),
                [value],
                |row| row.get(0),
            )
            .expect("inspect durable row")
    }

    #[test]
    fn deleting_worker_keeps_run_but_deleting_root_cascades_run_history() {
        let _sandbox = test_helpers::test_env::sandbox();
        ensure_test_schemas();
        seed_session("root-delete-test", None);
        seed_session("worker-delete-test", Some("root-delete-test"));
        seed_run("run-delete-test", "root-delete-test");
        get_connection()
            .expect("sandbox DB")
            .execute(
                "INSERT INTO agent_inbox (
                     recipient_agent_id, recipient_member_id, sender_agent_id,
                     org_run_id, payload_kind, payload_json, created_at
                 ) VALUES ('worker-agent', 'worker', 'system', ?1,
                           'plain', '{\"summary\":\"kept until root delete\",\"text\":\"body\"}', ?2)",
                rusqlite::params!["run-delete-test", "2026-07-16T00:00:00Z"],
            )
            .expect("seed run inbox history");

        delete_session_with_agent_org_history("worker-delete-test").expect("delete worker session");
        assert!(row_exists("agent_org_runs", "id", "run-delete-test"));
        assert!(row_exists("agent_inbox", "org_run_id", "run-delete-test"));

        delete_session_with_agent_org_history("root-delete-test")
            .expect("delete root session and owned run");
        assert!(!row_exists("agent_org_runs", "id", "run-delete-test"));
        assert!(!row_exists("agent_inbox", "org_run_id", "run-delete-test"));
        assert!(!row_exists(
            "agent_sessions",
            "session_id",
            "root-delete-test"
        ));
    }
}
