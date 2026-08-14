//! Persistence commands for session data.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use crate::coordination::agent_org_runs::AgentOrgRunStore;
use crate::interaction::plan_approval::persistence::PlanApprovalStore;
use crate::persistence::db_helpers as shared;
use crate::persistence::session_snapshots;
use crate::session::persistence as session_persistence;
use crate::session::{SessionListFilter, SessionStatus};
use crate::state::control_flow::CancelReason;
use crate::state::{AgentAppState, AgentSession};
use crate::tools::file_history;
use database::db::{get_connection, with_sessions_writer};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

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

const MAX_AGENT_ORG_DELETE_SESSIONS: usize = 1_024;
const AGENT_ORG_DELETE_STOP_TIMEOUT: Duration = Duration::from_secs(10);
const AGENT_ORG_DELETE_STOP_POLL_INTERVAL: Duration = Duration::from_millis(50);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteSessionReceipt {
    pub deleted_session_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AgentOrgSessionDeleteNode {
    session_id: String,
    parent_session_id: Option<String>,
    status: SessionStatus,
    depth: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AgentOrgSessionDeletePlan {
    run_id: String,
    root_session_id: String,
    run_status: crate::coordination::agent_org_runs::AgentOrgRunStatus,
    sessions: Vec<AgentOrgSessionDeleteNode>,
}

/// Delete a session and all related data.
#[tauri::command]
pub async fn agent_delete_session(
    state: tauri::State<'_, AgentAppState>,
    session_id: String,
) -> Result<DeleteSessionReceipt, String> {
    let planned_session_id = session_id.clone();
    let plan = tokio::task::spawn_blocking(move || {
        let conn = get_connection().map_err(|err| err.to_string())?;
        load_agent_org_session_delete_plan(&conn, &planned_session_id)
    })
    .await
    .map_err(|err| format!("session deletion planning worker failed: {err}"))??;

    let Some(plan) = plan else {
        crate::memory::background::cancel_memory_jobs_for_session(&session_id);
        let deleted_session_id = session_id.clone();
        tokio::task::spawn_blocking(move || {
            session_persistence::delete_session(&deleted_session_id).map_err(|err| err.to_string())
        })
        .await
        .map_err(|err| format!("session deletion worker failed: {err}"))??;
        state.remove_session(&session_id).await;
        return Ok(DeleteSessionReceipt {
            deleted_session_ids: vec![session_id],
        });
    };

    let (plan, quiesced_runtime_session_ids) = if matches!(
        plan.run_status,
        crate::coordination::agent_org_runs::AgentOrgRunStatus::Running
            | crate::coordination::agent_org_runs::AgentOrgRunStatus::Paused
            | crate::coordination::agent_org_runs::AgentOrgRunStatus::Cancelled
    ) {
        let fenced_plan =
            tokio::task::spawn_blocking(move || establish_agent_org_delete_fence(&plan))
                .await
                .map_err(|err| format!("Agent Org deletion fence worker failed: {err}"))??;
        let quiesced_runtime_session_ids = if fenced_plan.run_status
            == crate::coordination::agent_org_runs::AgentOrgRunStatus::Cancelled
        {
            stop_agent_org_runtime_sessions(&state, &fenced_plan).await?
        } else {
            ensure_agent_org_runtime_sessions_idle(&state, &fenced_plan).await?;
            HashSet::new()
        };
        let root_session_id = fenced_plan.root_session_id.clone();
        let current_plan = tokio::task::spawn_blocking(move || {
            let conn = get_connection().map_err(|err| err.to_string())?;
            load_agent_org_session_delete_plan(&conn, &root_session_id)?.ok_or_else(|| {
                format!(
                    "Refusing to delete Agent Org root {root_session_id}: ownership disappeared while stopping"
                )
            })
        })
        .await
        .map_err(|err| format!("Agent Org post-stop planning worker failed: {err}"))??;
        if !agent_org_delete_topology_matches(&fenced_plan, &current_plan) {
            return Err(format!(
                "Refusing to delete Agent Org run {}: session hierarchy changed while stopping",
                fenced_plan.run_id
            ));
        }
        (current_plan, quiesced_runtime_session_ids)
    } else {
        ensure_agent_org_runtime_sessions_idle(&state, &plan).await?;
        (plan, HashSet::new())
    };

    validate_agent_org_delete_ready(&plan, &quiesced_runtime_session_ids)?;
    ensure_agent_org_runtime_sessions_idle(&state, &plan).await?;

    let receipt = tokio::task::spawn_blocking(move || {
        delete_agent_org_session_hierarchy(&plan, &quiesced_runtime_session_ids)
    })
    .await
    .map_err(|err| format!("Agent Org session deletion worker failed: {err}"))??;

    state.remove_sessions(&receipt.deleted_session_ids).await;
    if let Some(app_handle) = state.app_handle.as_ref() {
        for deleted_session_id in &receipt.deleted_session_ids {
            crate::bus::event_pipeline_bridge::evict_session(app_handle, deleted_session_id);
        }
    }
    Ok(receipt)
}

fn load_agent_org_session_delete_plan(
    conn: &Connection,
    root_session_id: &str,
) -> Result<Option<AgentOrgSessionDeletePlan>, String> {
    let run_rows = {
        let mut stmt = conn
            .prepare(
                "SELECT id, status
                 FROM agent_org_runs
                 WHERE root_session_id=?1
                 ORDER BY id",
            )
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map([root_session_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|err| err.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|err| err.to_string())?
    };

    let Some((run_id, run_status_raw)) = run_rows.first() else {
        return Ok(None);
    };
    if run_rows.len() != 1 {
        return Err(format!(
            "Refusing to delete Agent Org root {root_session_id}: {} runs claim the same root",
            run_rows.len()
        ));
    }
    let run_status = crate::coordination::agent_org_runs::AgentOrgRunStatus::parse(run_status_raw)
        .ok_or_else(|| {
            format!(
                "Refusing to delete Agent Org run {run_id}: unknown run status {run_status_raw:?}"
            )
        })?;

    let mut stmt = conn
        .prepare(
            "WITH RECURSIVE descendants(
                 session_id, parent_session_id, status, depth, path, cycle
             ) AS (
                 SELECT session_id,
                        parent_session_id,
                        status,
                        0,
                        '/' || hex(session_id) || '/',
                        0
                 FROM agent_sessions
                 WHERE session_id=?1
                 UNION ALL
                 SELECT child.session_id,
                        child.parent_session_id,
                        child.status,
                        parent.depth + 1,
                        parent.path || hex(child.session_id) || '/',
                        instr(parent.path, '/' || hex(child.session_id) || '/') > 0
                 FROM agent_sessions child
                 JOIN descendants parent
                   ON child.parent_session_id=parent.session_id
                 WHERE parent.cycle=0
                   AND parent.depth < ?3
             )
             SELECT descendant.session_id,
                    descendant.parent_session_id,
                    descendant.status,
                    descendant.depth,
                    descendant.cycle,
                    (
                        SELECT nested.id
                        FROM agent_org_runs nested
                        WHERE nested.id<>?2
                          AND nested.root_session_id=descendant.session_id
                        ORDER BY nested.id
                        LIMIT 1
                    ) AS nested_run_id,
                    EXISTS(
                        SELECT 1
                        FROM agent_sessions child
                        WHERE child.parent_session_id=descendant.session_id
                    ) AS has_children
             FROM descendants descendant",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(
            params![
                root_session_id,
                run_id,
                MAX_AGENT_ORG_DELETE_SESSIONS as i64
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, bool>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, bool>(6)?,
                ))
            },
        )
        .map_err(|err| err.to_string())?;

    let mut sessions = Vec::new();
    let mut visited = std::collections::HashSet::new();
    for row in rows {
        let (session_id, parent_session_id, status_raw, depth, cycle, nested_run_id, has_children) =
            row.map_err(|err| err.to_string())?;
        if cycle {
            return Err(format!(
                "Refusing to delete Agent Org run {run_id}: session ancestry contains a cycle at {session_id}"
            ));
        }
        if !visited.insert(session_id.clone()) {
            return Err(format!(
                "Refusing to delete Agent Org run {run_id}: session hierarchy visits {session_id} more than once"
            ));
        }
        if depth < 0 {
            return Err(format!(
                "Refusing to delete Agent Org run {run_id}: invalid depth for {session_id}"
            ));
        }
        let depth = usize::try_from(depth).map_err(|err| err.to_string())?;
        if depth >= MAX_AGENT_ORG_DELETE_SESSIONS && has_children {
            return Err(format!(
                "Refusing to delete Agent Org run {run_id}: session hierarchy exceeds {MAX_AGENT_ORG_DELETE_SESSIONS} nodes"
            ));
        }
        if depth > 0 {
            if let Some(nested_run_id) = nested_run_id {
                return Err(format!(
                    "Refusing to delete Agent Org run {run_id}: descendant session {session_id} is root of unsupported nested run {nested_run_id}"
                ));
            }
        }
        let status = SessionStatus::parse(&status_raw).ok_or_else(|| {
            format!(
                "Refusing to delete Agent Org run {run_id}: session {session_id} has unknown status {status_raw:?}"
            )
        })?;
        sessions.push(AgentOrgSessionDeleteNode {
            session_id,
            parent_session_id,
            status,
            depth,
        });
        if sessions.len() > MAX_AGENT_ORG_DELETE_SESSIONS {
            return Err(format!(
                "Refusing to delete Agent Org run {run_id}: session hierarchy exceeds {MAX_AGENT_ORG_DELETE_SESSIONS} nodes"
            ));
        }
    }
    if sessions.is_empty()
        || sessions
            .iter()
            .all(|node| node.session_id != root_session_id)
    {
        return Err(format!(
            "Refusing to delete Agent Org run {run_id}: root session {root_session_id} is missing"
        ));
    }
    let depths = sessions
        .iter()
        .map(|node| (node.session_id.as_str(), node.depth))
        .collect::<std::collections::HashMap<_, _>>();
    for node in &sessions {
        if node.depth == 0 {
            if node.session_id != root_session_id {
                return Err(format!(
                    "Refusing to delete Agent Org run {run_id}: unexpected depth-zero session {}",
                    node.session_id
                ));
            }
            continue;
        }
        let parent_session_id = node.parent_session_id.as_deref().ok_or_else(|| {
            format!(
                "Refusing to delete Agent Org run {run_id}: descendant session {} has no parent",
                node.session_id
            )
        })?;
        let parent_depth = depths.get(parent_session_id).ok_or_else(|| {
            format!(
                "Refusing to delete Agent Org run {run_id}: descendant session {} references missing parent {parent_session_id}",
                node.session_id
            )
        })?;
        if parent_depth.saturating_add(1) != node.depth {
            return Err(format!(
                "Refusing to delete Agent Org run {run_id}: descendant session {} has inconsistent depth",
                node.session_id
            ));
        }
    }

    sessions.sort_by(|left, right| {
        right
            .depth
            .cmp(&left.depth)
            .then_with(|| left.session_id.cmp(&right.session_id))
    });
    Ok(Some(AgentOrgSessionDeletePlan {
        run_id: run_id.clone(),
        root_session_id: root_session_id.to_string(),
        run_status,
        sessions,
    }))
}

fn agent_org_delete_topology_matches(
    expected: &AgentOrgSessionDeletePlan,
    current: &AgentOrgSessionDeletePlan,
) -> bool {
    expected.run_id == current.run_id
        && expected.root_session_id == current.root_session_id
        && expected.sessions.len() == current.sessions.len()
        && expected
            .sessions
            .iter()
            .zip(&current.sessions)
            .all(|(left, right)| {
                left.session_id == right.session_id
                    && left.parent_session_id == right.parent_session_id
                    && left.depth == right.depth
            })
}

fn establish_agent_org_delete_fence(
    expected_plan: &AgentOrgSessionDeletePlan,
) -> Result<AgentOrgSessionDeletePlan, String> {
    let (current_plan, changed) = with_sessions_writer(|| {
        let mut conn = get_connection().map_err(|err| err.to_string())?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|err| err.to_string())?;
        let mut current_plan =
            load_agent_org_session_delete_plan(&tx, &expected_plan.root_session_id)?.ok_or_else(
                || {
                    format!(
                "Refusing to delete Agent Org run {}: root ownership changed before stopping",
                expected_plan.run_id
            )
                },
            )?;
        if !agent_org_delete_topology_matches(expected_plan, &current_plan) {
            return Err(format!(
                "Refusing to delete Agent Org run {}: session hierarchy changed before stopping",
                expected_plan.run_id
            ));
        }

        let changed = match current_plan.run_status {
            crate::coordination::agent_org_runs::AgentOrgRunStatus::Running
            | crate::coordination::agent_org_runs::AgentOrgRunStatus::Paused => {
                let changed =
                    AgentOrgRunStore::cancel_for_delete_with_connection(&tx, &current_plan.run_id)?;
                if !changed {
                    return Err(format!(
                        "Refusing to delete Agent Org run {}: run status changed before cancellation",
                        current_plan.run_id
                    ));
                }
                current_plan.run_status =
                    crate::coordination::agent_org_runs::AgentOrgRunStatus::Cancelled;
                true
            }
            crate::coordination::agent_org_runs::AgentOrgRunStatus::Cancelled => false,
            status if status.is_terminal() => false,
            status => {
                return Err(format!(
                    "Refusing to delete Agent Org run {}: unsupported run status {}",
                    current_plan.run_id,
                    status.as_str()
                ));
            }
        };
        tx.commit().map_err(|err| err.to_string())?;
        Ok::<_, String>((current_plan, changed))
    })?;
    if changed {
        crate::coordination::agent_org_run_events::notify_agent_org_run_changed(
            &current_plan.run_id,
        );
    }
    Ok(current_plan)
}

fn validate_agent_org_delete_ready(
    plan: &AgentOrgSessionDeletePlan,
    quiesced_runtime_session_ids: &HashSet<String>,
) -> Result<(), String> {
    if !plan.run_status.is_terminal() {
        return Err(format!(
            "Refusing to delete Agent Org run {}: run status is {}",
            plan.run_id,
            plan.run_status.as_str()
        ));
    }

    for node in &plan.sessions {
        let allowed = node.status == SessionStatus::Idle
            || node.status.is_terminal()
            || (plan.run_status
                == crate::coordination::agent_org_runs::AgentOrgRunStatus::Cancelled
                && (matches!(node.status, SessionStatus::Pending | SessionStatus::Paused)
                    || (node.status.is_in_flight()
                        && quiesced_runtime_session_ids.contains(&node.session_id))));
        if !allowed {
            return Err(format!(
                "Refusing to delete Agent Org run {}: session {} status is {}",
                plan.run_id,
                node.session_id,
                node.status.as_str()
            ));
        }
    }
    Ok(())
}

async fn agent_org_runtime_sessions(
    state: &AgentAppState,
    plan: &AgentOrgSessionDeletePlan,
) -> Vec<(String, Arc<AgentSession>)> {
    let sessions = state.sessions.lock().await;
    plan.sessions
        .iter()
        .filter_map(|node| {
            sessions
                .get(&node.session_id)
                .cloned()
                .map(|session| (node.session_id.clone(), session))
        })
        .collect()
}

async fn agent_org_runtime_blockers(
    runtime_sessions: &[(String, Arc<AgentSession>)],
) -> Vec<String> {
    let mut blockers = Vec::new();
    for (session_id, session) in runtime_sessions {
        let scheduler_processing = session.scheduler.is_processing();
        let pending_count = session.scheduler.pending_count();
        let active_turn = session.active_turn.lock().await.is_some();
        if active_turn || scheduler_processing || pending_count > 0 {
            blockers.push(format!(
                "{session_id}(active_turn={active_turn},scheduler_processing={scheduler_processing},pending={pending_count})"
            ));
        }
    }
    blockers
}

async fn stop_agent_org_runtime_sessions(
    state: &AgentAppState,
    plan: &AgentOrgSessionDeletePlan,
) -> Result<HashSet<String>, String> {
    stop_agent_org_runtime_sessions_with_timeout(state, plan, AGENT_ORG_DELETE_STOP_TIMEOUT).await
}

async fn stop_agent_org_runtime_sessions_with_timeout(
    state: &AgentAppState,
    plan: &AgentOrgSessionDeletePlan,
    timeout: Duration,
) -> Result<HashSet<String>, String> {
    let runtime_sessions = agent_org_runtime_sessions(state, plan).await;
    let runtime_session_ids = runtime_sessions
        .iter()
        .map(|(session_id, _)| session_id.clone())
        .collect::<HashSet<_>>();

    for (_, session) in &runtime_sessions {
        session
            .cancel_active_turn(CancelReason::AgentOrgDelete)
            .await;
    }

    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let blockers = agent_org_runtime_blockers(&runtime_sessions).await;
        if blockers.is_empty() {
            return Ok(runtime_session_ids);
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(format!(
                "Timed out stopping Agent Org run {} before deletion: {}",
                plan.run_id,
                blockers.join(", ")
            ));
        }
        tokio::time::sleep(AGENT_ORG_DELETE_STOP_POLL_INTERVAL).await;
    }
}

async fn ensure_agent_org_runtime_sessions_idle(
    state: &AgentAppState,
    plan: &AgentOrgSessionDeletePlan,
) -> Result<(), String> {
    let runtime_sessions = agent_org_runtime_sessions(state, plan).await;
    let blockers = agent_org_runtime_blockers(&runtime_sessions).await;
    if blockers.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "Refusing to delete Agent Org run {}: active Rust runtime sessions: {}",
            plan.run_id,
            blockers.join(", ")
        ))
    }
}

fn delete_agent_org_session_hierarchy(
    expected_plan: &AgentOrgSessionDeletePlan,
    quiesced_runtime_session_ids: &HashSet<String>,
) -> Result<DeleteSessionReceipt, String> {
    for node in &expected_plan.sessions {
        session_persistence::prepare_session_delete(&node.session_id)
            .map_err(|err| format!("prepare session {} for deletion: {err}", node.session_id))?;
    }

    let outcome = with_sessions_writer(|| {
        let mut conn = get_connection().map_err(|err| err.to_string())?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|err| err.to_string())?;
        let current_plan = load_agent_org_session_delete_plan(&tx, &expected_plan.root_session_id)?
            .ok_or_else(|| {
                format!(
                    "Refusing to delete Agent Org run {}: root ownership changed before deletion",
                    expected_plan.run_id
                )
            })?;
        if current_plan != *expected_plan {
            return Err(format!(
                "Refusing to delete Agent Org run {}: session hierarchy or status changed before deletion",
                expected_plan.run_id
            ));
        }
        validate_agent_org_delete_ready(&current_plan, quiesced_runtime_session_ids)?;

        for node in &expected_plan.sessions {
            session_persistence::delete_session_with_connection(&tx, &node.session_id)
                .map_err(|err| format!("delete session {}: {err}", node.session_id))?;
        }
        let outcome = AgentOrgRunStore::delete_by_id_with_connection(&tx, &expected_plan.run_id)?;
        if !outcome.deleted() {
            return Err(format!(
                "Refusing to commit Agent Org run {} deletion: run row disappeared during deletion",
                expected_plan.run_id
            ));
        }
        ensure_agent_org_hierarchy_absent(&tx, expected_plan)?;
        tx.commit().map_err(|err| err.to_string())?;
        Ok::<_, String>(outcome)
    })?;

    for node in &expected_plan.sessions {
        session_persistence::finish_session_delete(&node.session_id);
    }
    AgentOrgRunStore::finish_delete(&expected_plan.run_id, outcome);

    Ok(DeleteSessionReceipt {
        deleted_session_ids: expected_plan
            .sessions
            .iter()
            .map(|node| node.session_id.clone())
            .collect(),
    })
}

fn ensure_agent_org_hierarchy_absent(
    conn: &Connection,
    plan: &AgentOrgSessionDeletePlan,
) -> Result<(), String> {
    for node in &plan.sessions {
        let residual: Option<String> = conn
            .query_row(
                "SELECT session_id
                 FROM agent_sessions
                 WHERE session_id=?1 OR parent_session_id=?1
                 ORDER BY session_id
                 LIMIT 1",
                [&node.session_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|err| err.to_string())?;
        if let Some(session_id) = residual {
            return Err(format!(
                "Refusing to commit Agent Org run {} deletion: residual session hierarchy row {session_id} references deleted session {}",
                plan.run_id, node.session_id
            ));
        }
    }
    let run_exists = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM agent_org_runs WHERE id=?1)",
            [&plan.run_id],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|err| err.to_string())?;
    if run_exists {
        return Err(format!(
            "Refusing to commit Agent Org run {} deletion: run row still exists",
            plan.run_id
        ));
    }
    Ok(())
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

/// `Track this` (orgtrack/v1 §7.2, Build→Project) and
/// `Convert to Project` (Plan→Project): switch the session onto the
/// Project product mode, derive the runtime exec mode the same way the
/// composer picker does (project → build), invalidate Plan mode's
/// snapshot/restore state, and create-or-replay the root WorkItem from
/// the already-recorded first user input. Earlier turns stay untouched
/// as provenance. Returns `{ productMode, agentExecMode, workItemId }`.
#[tauri::command]
pub async fn agent_track_session_as_project(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::state::AgentAppState>,
    session_id: String,
) -> Result<serde_json::Value, String> {
    let sid = session_id.clone();
    let (work_item_id, exec_mode) = tokio::task::spawn_blocking(move || {
        let record = session_persistence::get_session(&sid)
            .map_err(|err| err.to_string())?
            .ok_or_else(|| format!("Session not found: {sid}"))?;

        // Same derivation the ModePill applies: Project pins the exec
        // mode to Build (a read-only Plan session would otherwise keep
        // its deny layer while claiming to do project work).
        let exec_mode = crate::session::AgentExecMode::Build;
        session_persistence::update_mode_axes(&sid, "project", exec_mode.as_str())
            .map_err(|err| format!("track session: set Project mode axes: {err}"))?;

        // Root creation at conversion time, from the recorded first
        // user input. An empty session converts mode-only; the
        // first-submission bootstrap covers the root later.
        let content = record.user_input.clone().unwrap_or_default();
        let work_item_id = if record.work_item_id.is_some() {
            record.work_item_id
        } else if content.trim().is_empty() {
            None
        } else {
            super::message::project_bootstrap::bootstrap_root_work_item(&sid, &content)?
        };
        Ok::<_, String>((work_item_id, exec_mode))
    })
    .await
    .map_err(|err| err.to_string())??;

    // Convert to Project invalidates the Plan snapshot/restore state so
    // a pending approval can't bounce later turns back to the old mode.
    if let Some(session) = state.get_session(&session_id).await {
        let had_slot = session.plan_slot_cache.get(&session_id).is_some();
        let _ = session.pre_plan_mode_cache.take(&session_id);
        session.plan_slot_cache.clear(&session_id);
        if had_slot {
            crate::bus::broadcast_event(
                "agent:exit_plan_mode",
                serde_json::json!({
                    "sessionId": &session_id,
                    "source": "convert_to_project",
                    "nextMode": exec_mode.as_str(),
                }),
            );
        }
    }

    {
        use tauri::Emitter;
        let ts = chrono::Utc::now().to_rfc3339();
        let _ = app.emit(
            project_management::projects::events::DATA_CHANGED_EVENT,
            &ts,
        );
    }

    Ok(serde_json::json!({
        "productMode": "project",
        "agentExecMode": exec_mode.as_str(),
        "workItemId": work_item_id,
    }))
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

    session_persistence::linked_work_item::upsert_linked_session_on_work_item(
        project_slug,
        work_item_id,
        &session,
        agent_role,
    )?;

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
        project_management::lineage::schema::init_lineage_tables(&conn).expect("lineage schema");
        crate::memory::learnings::init_learnings_table(&conn).expect("learnings schema");
        database::init_shell_replay_tables(&conn).expect("shell replay schema");
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

    fn seed_session_with_status(session_id: &str, parent_session_id: Option<&str>, status: &str) {
        let conn = get_connection().expect("sandbox DB");
        conn.execute(
            "INSERT INTO agent_sessions (
                 session_id, name, status, user_input, created_at, updated_at,
                 session_type, parent_session_id, workspace_additional_json,
                 key_source
             ) VALUES (?1, ?2, ?3, NULL, ?4, ?4, 'agent', ?5, '{}', 'own_key')",
            rusqlite::params![
                session_id,
                format!("session-{session_id}"),
                status,
                "2026-07-16T00:00:00Z",
                parent_session_id,
            ],
        )
        .expect("seed session");
    }

    fn seed_session(session_id: &str, parent_session_id: Option<&str>) {
        seed_session_with_status(session_id, parent_session_id, "idle");
    }

    fn seed_run_with_status(run_id: &str, root_session_id: &str, status: &str) {
        let conn = get_connection().expect("sandbox DB");
        conn.execute(
            "INSERT INTO agent_org_runs (
                 id, org_id, coordinator_agent_id, root_session_id,
                 entry_mode, status, created_at, updated_at
             ) VALUES (?1, 'org-delete-test', 'coordinator-agent', ?2,
                       'standalone_session', ?3, ?4, ?4)",
            rusqlite::params![run_id, root_session_id, status, "2026-07-16T00:00:00Z"],
        )
        .expect("seed run");
    }

    fn seed_run(run_id: &str, root_session_id: &str) {
        seed_run_with_status(run_id, root_session_id, "completed");
    }

    fn seed_session_owned_rows(session_id: &str) {
        let conn = get_connection().expect("sandbox DB");
        conn.execute(
            "INSERT INTO agent_messages (
                 id, session_id, role, content, sequence, created_at
             ) VALUES (?1, ?2, 'user', 'delete me', 0, ?3)",
            rusqlite::params![
                format!("message-{session_id}"),
                session_id,
                "2026-07-16T00:00:00Z"
            ],
        )
        .expect("seed message");
        conn.execute(
            "INSERT INTO agent_todos (session_id, content) VALUES (?1, 'delete me')",
            [session_id],
        )
        .expect("seed todo");
        conn.execute(
            "INSERT INTO events (id, session_id) VALUES (?1, ?2)",
            rusqlite::params![format!("event-{session_id}"), session_id],
        )
        .expect("seed event");
        conn.execute(
            "INSERT INTO session_token_usage (
                 session_id, session_type, total_tokens, created_at
             ) VALUES (?1, 'agent', 1, ?2)",
            rusqlite::params![session_id, "2026-07-16T00:00:00Z"],
        )
        .expect("seed usage");
    }

    fn seed_run_owned_rows(run_id: &str) {
        let conn = get_connection().expect("sandbox DB");
        conn.execute(
            "INSERT INTO agent_inbox (
                 recipient_agent_id, recipient_member_id, sender_agent_id,
                 org_run_id, payload_kind, payload_json, created_at
             ) VALUES ('worker-agent', 'worker', 'system', ?1,
                       'plain', '{\"summary\":\"run history\",\"text\":\"body\"}', ?2)",
            rusqlite::params![run_id, "2026-07-16T00:00:00Z"],
        )
        .expect("seed run inbox history");
        conn.execute(
            "INSERT INTO agent_org_tasks (
                 id, org_run_id, subject, status, created_at, updated_at
             ) VALUES (?1, ?2, 'delete me', 'completed', ?3, ?3)",
            rusqlite::params![format!("task-{run_id}"), run_id, "2026-07-16T00:00:00Z"],
        )
        .expect("seed run task history");
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
    fn session_hierarchy_delete_removes_all_rust_descendants_and_run_history() {
        let _sandbox = test_helpers::test_env::sandbox();
        ensure_test_schemas();
        let root = "hierarchy-delete-root";
        let worker = "hierarchy-delete-worker";
        let grandchild = "hierarchy-delete-grandchild";
        let unrelated = "hierarchy-delete-unrelated";
        let unrelated_root = "hierarchy-delete-other-root";
        seed_session(root, None);
        seed_session_with_status(worker, Some(root), "completed");
        seed_session_with_status(grandchild, Some(worker), "failed");
        seed_session(unrelated, None);
        seed_session(unrelated_root, None);
        seed_run("hierarchy-delete-run", root);
        seed_run("hierarchy-delete-other-run", unrelated_root);
        for session_id in [root, worker, grandchild, unrelated] {
            seed_session_owned_rows(session_id);
        }
        seed_run_owned_rows("hierarchy-delete-run");
        seed_run_owned_rows("hierarchy-delete-other-run");

        let conn = get_connection().expect("sandbox DB");
        let plan = load_agent_org_session_delete_plan(&conn, root)
            .expect("plan hierarchy")
            .expect("root owns Agent Org run");
        drop(conn);
        let receipt = delete_agent_org_session_hierarchy(&plan, &HashSet::new())
            .expect("delete completed hierarchy");

        assert_eq!(
            receipt.deleted_session_ids,
            vec![grandchild.to_string(), worker.to_string(), root.to_string()]
        );
        for session_id in [root, worker, grandchild] {
            for table in [
                "agent_sessions",
                "agent_messages",
                "agent_todos",
                "events",
                "session_token_usage",
            ] {
                assert!(
                    !row_exists(table, "session_id", session_id),
                    "{table} still contains {session_id}"
                );
            }
        }
        assert!(!row_exists("agent_org_runs", "id", "hierarchy-delete-run"));
        assert!(!row_exists(
            "agent_inbox",
            "org_run_id",
            "hierarchy-delete-run"
        ));
        assert!(!row_exists(
            "agent_org_tasks",
            "org_run_id",
            "hierarchy-delete-run"
        ));
        assert!(row_exists("agent_sessions", "session_id", unrelated));
        assert!(row_exists("agent_messages", "session_id", unrelated));
        assert!(row_exists(
            "agent_org_runs",
            "id",
            "hierarchy-delete-other-run"
        ));
        assert!(row_exists(
            "agent_inbox",
            "org_run_id",
            "hierarchy-delete-other-run"
        ));
    }

    #[test]
    fn session_hierarchy_delete_worker_keeps_root_and_run() {
        let _sandbox = test_helpers::test_env::sandbox();
        ensure_test_schemas();
        let root = "hierarchy-worker-root";
        let worker = "hierarchy-worker-direct-delete";
        seed_session(root, None);
        seed_session(worker, Some(root));
        seed_run("hierarchy-worker-run", root);
        seed_run_owned_rows("hierarchy-worker-run");

        let conn = get_connection().expect("sandbox DB");
        assert!(
            load_agent_org_session_delete_plan(&conn, worker)
                .expect("plan worker")
                .is_none(),
            "a worker must not be promoted to hierarchy root deletion"
        );
        drop(conn);
        session_persistence::delete_session(worker).expect("canonical single-session deletion");

        assert!(!row_exists("agent_sessions", "session_id", worker));
        assert!(row_exists("agent_sessions", "session_id", root));
        assert!(row_exists("agent_org_runs", "id", "hierarchy-worker-run"));
        assert!(row_exists(
            "agent_inbox",
            "org_run_id",
            "hierarchy-worker-run"
        ));
    }

    #[test]
    fn session_hierarchy_delete_fences_active_run_and_requires_quiesced_sessions() {
        let _sandbox = test_helpers::test_env::sandbox();
        ensure_test_schemas();
        let root = "hierarchy-active-root";
        let worker = "hierarchy-active-worker";
        seed_session(root, None);
        seed_session_with_status(worker, Some(root), "running");
        seed_run_with_status("hierarchy-active-run", root, "running");

        let conn = get_connection().expect("sandbox DB");
        let plan = load_agent_org_session_delete_plan(&conn, root)
            .expect("load running hierarchy")
            .expect("root owns run");
        drop(conn);
        let fenced = establish_agent_org_delete_fence(&plan).expect("cancel run for deletion");
        assert_eq!(
            fenced.run_status,
            crate::coordination::agent_org_runs::AgentOrgRunStatus::Cancelled
        );
        assert_eq!(
            get_connection()
                .expect("sandbox DB")
                .query_row(
                    "SELECT status FROM agent_org_runs WHERE id='hierarchy-active-run'",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .expect("load fenced status"),
            "cancelled"
        );

        let error = validate_agent_org_delete_ready(&fenced, &HashSet::new())
            .expect_err("unobserved running worker must fail closed");
        assert!(error.contains(worker));
        assert!(error.contains("running"));

        let quiesced = HashSet::from([worker.to_string()]);
        validate_agent_org_delete_ready(&fenced, &quiesced)
            .expect("a stopped live runtime may retain a stale running row");
        assert!(row_exists("agent_sessions", "session_id", root));
        assert!(row_exists("agent_sessions", "session_id", worker));
        assert!(row_exists("agent_org_runs", "id", "hierarchy-active-run"));
    }

    #[test]
    fn session_hierarchy_delete_blocks_resource_preflight_failures_before_database_changes() {
        let _sandbox = test_helpers::test_env::sandbox();
        ensure_test_schemas();
        let root = "hierarchy-replay-root";
        let worker = "hierarchy-replay-worker";
        seed_session(root, None);
        seed_session(worker, Some(root));
        seed_run("hierarchy-replay-run", root);
        let conn = get_connection().expect("sandbox DB");
        let plan = load_agent_org_session_delete_plan(&conn, root)
            .expect("plan hierarchy")
            .expect("root owns run");
        drop(conn);

        let replay_root = std::env::temp_dir().join(format!(
            "orgii-hierarchy-delete-replay-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&replay_root).expect("create replay root");
        let writer = crate::tools::impls::coding::exec::shell_replay::ShellReplayWriter::create(
            &replay_root,
            crate::tools::impls::coding::exec::shell_replay::ShellReplayTarget::new(
                worker,
                "active-call",
            ),
            "still running",
            &replay_root,
            None,
        )
        .expect("create active replay");

        let error = delete_agent_org_session_hierarchy(&plan, &HashSet::new())
            .expect_err("active replay must block hierarchy deletion");
        assert!(error.contains(worker));
        assert!(error.contains("shell replay calls are active"));
        assert!(row_exists("agent_sessions", "session_id", root));
        assert!(row_exists("agent_sessions", "session_id", worker));
        assert!(row_exists("agent_org_runs", "id", "hierarchy-replay-run"));

        writer
            .finalize(core_types::session_event::ShellReplayStatus::Complete, None)
            .expect("finalize replay");

        let worktree_path = replay_root.join("owned-worktree");
        let missing_repo_path = replay_root.join("missing-repository");
        std::fs::create_dir_all(&worktree_path).expect("create worktree fixture");
        get_connection()
            .expect("sandbox DB")
            .execute(
                "UPDATE agent_sessions
                 SET workspace_path=?1, worktree_path=?2, base_branch='develop'
                 WHERE session_id=?3",
                rusqlite::params![
                    missing_repo_path.to_string_lossy(),
                    worktree_path.to_string_lossy(),
                    worker,
                ],
            )
            .expect("seed invalid worktree metadata");
        let error = delete_agent_org_session_hierarchy(&plan, &HashSet::new())
            .expect_err("worktree validation failure must block hierarchy deletion");
        assert!(error.contains(worker));
        assert!(error.contains("repository path no longer exists"));
        assert!(row_exists("agent_sessions", "session_id", root));
        assert!(row_exists("agent_sessions", "session_id", worker));
        assert!(row_exists("agent_org_runs", "id", "hierarchy-replay-run"));

        std::fs::remove_dir_all(replay_root).expect("remove replay fixture");
    }

    #[test]
    fn session_hierarchy_delete_rejects_nested_agent_org_without_mutation() {
        let _sandbox = test_helpers::test_env::sandbox();
        ensure_test_schemas();
        let outer_root = "hierarchy-nested-outer-root";
        let inner_root = "hierarchy-nested-inner-root";
        let inner_worker = "hierarchy-nested-inner-worker";
        seed_session(outer_root, None);
        seed_session(inner_root, Some(outer_root));
        seed_session(inner_worker, Some(inner_root));
        seed_run("hierarchy-nested-outer-run", outer_root);
        seed_run("hierarchy-nested-inner-run", inner_root);

        let conn = get_connection().expect("sandbox DB");
        let error = load_agent_org_session_delete_plan(&conn, outer_root)
            .expect_err("nested Agent Org must fail closed");
        assert!(error.contains(inner_root));
        assert!(error.contains("hierarchy-nested-inner-run"));
        for session_id in [outer_root, inner_root, inner_worker] {
            assert!(row_exists("agent_sessions", "session_id", session_id));
        }
        assert!(row_exists(
            "agent_org_runs",
            "id",
            "hierarchy-nested-outer-run"
        ));
        assert!(row_exists(
            "agent_org_runs",
            "id",
            "hierarchy-nested-inner-run"
        ));
    }

    #[test]
    fn session_hierarchy_delete_rejects_cycle_and_size_limit() {
        let _sandbox = test_helpers::test_env::sandbox();
        ensure_test_schemas();
        let cycle_root = "hierarchy-cycle-root";
        let cycle_worker = "hierarchy-cycle-worker";
        seed_session(cycle_root, Some(cycle_worker));
        seed_session(cycle_worker, Some(cycle_root));
        seed_run("hierarchy-cycle-run", cycle_root);

        let conn = get_connection().expect("sandbox DB");
        let error = load_agent_org_session_delete_plan(&conn, cycle_root)
            .expect_err("cycle must fail closed");
        assert!(error.contains("cycle"));
        assert!(row_exists("agent_sessions", "session_id", cycle_root));
        assert!(row_exists("agent_sessions", "session_id", cycle_worker));
        drop(conn);

        let limit_root = "hierarchy-limit-root";
        seed_session(limit_root, None);
        seed_run("hierarchy-limit-run", limit_root);
        let mut conn = get_connection().expect("sandbox DB");
        let tx = conn.transaction().expect("seed oversized hierarchy");
        for index in 0..MAX_AGENT_ORG_DELETE_SESSIONS {
            let session_id = format!("hierarchy-limit-worker-{index:04}");
            tx.execute(
                "INSERT INTO agent_sessions (
                     session_id, name, status, created_at, updated_at,
                     session_type, parent_session_id, workspace_additional_json,
                     key_source
                 ) VALUES (?1, ?1, 'idle', ?2, ?2, 'agent', ?3, '{}', 'own_key')",
                rusqlite::params![session_id, "2026-07-16T00:00:00Z", limit_root],
            )
            .expect("seed worker");
        }
        tx.commit().expect("commit oversized hierarchy");
        let error = load_agent_org_session_delete_plan(&conn, limit_root)
            .expect_err("oversized hierarchy must fail closed");
        assert!(error.contains("exceeds"));
        assert!(row_exists("agent_sessions", "session_id", limit_root));
        assert!(row_exists("agent_org_runs", "id", "hierarchy-limit-run"));
    }

    #[test]
    fn session_hierarchy_delete_rechecks_concurrent_structure_changes() {
        let _sandbox = test_helpers::test_env::sandbox();
        ensure_test_schemas();
        let root = "hierarchy-recheck-root";
        let worker = "hierarchy-recheck-worker";
        seed_session(root, None);
        seed_session(worker, Some(root));
        seed_run("hierarchy-recheck-run", root);

        let conn = get_connection().expect("sandbox DB");
        let plan = load_agent_org_session_delete_plan(&conn, root)
            .expect("initial plan")
            .expect("root owns run");
        drop(conn);
        seed_session("hierarchy-recheck-late-worker", Some(root));

        let error = delete_agent_org_session_hierarchy(&plan, &HashSet::new())
            .expect_err("changed hierarchy must fail closed");
        assert!(error.contains("changed before deletion"));
        for session_id in [root, worker, "hierarchy-recheck-late-worker"] {
            assert!(row_exists("agent_sessions", "session_id", session_id));
        }
        assert!(row_exists("agent_org_runs", "id", "hierarchy-recheck-run"));
    }

    #[test]
    fn session_hierarchy_delete_rolls_back_on_midway_database_failure() {
        let _sandbox = test_helpers::test_env::sandbox();
        ensure_test_schemas();
        let root = "hierarchy-rollback-root";
        let worker = "hierarchy-rollback-worker";
        seed_session(root, None);
        seed_session(worker, Some(root));
        seed_session_owned_rows(root);
        seed_session_owned_rows(worker);
        seed_run("hierarchy-rollback-run", root);
        seed_run_owned_rows("hierarchy-rollback-run");

        let conn = get_connection().expect("sandbox DB");
        let plan = load_agent_org_session_delete_plan(&conn, root)
            .expect("plan hierarchy")
            .expect("root owns run");
        conn.execute_batch(
            "CREATE TRIGGER hierarchy_delete_abort_root
             BEFORE DELETE ON agent_sessions
             WHEN OLD.session_id='hierarchy-rollback-root'
             BEGIN
                 SELECT RAISE(ABORT, 'injected hierarchy delete failure');
             END;",
        )
        .expect("install failure trigger");
        drop(conn);

        let error = delete_agent_org_session_hierarchy(&plan, &HashSet::new())
            .expect_err("trigger must abort transaction");
        assert!(error.contains("injected hierarchy delete failure"));
        for session_id in [root, worker] {
            for table in [
                "agent_sessions",
                "agent_messages",
                "agent_todos",
                "events",
                "session_token_usage",
            ] {
                assert!(
                    row_exists(table, "session_id", session_id),
                    "{table} lost {session_id} despite rollback"
                );
            }
        }
        assert!(row_exists("agent_org_runs", "id", "hierarchy-rollback-run"));
        assert!(row_exists(
            "agent_inbox",
            "org_run_id",
            "hierarchy-rollback-run"
        ));
        assert!(row_exists(
            "agent_org_tasks",
            "org_run_id",
            "hierarchy-rollback-run"
        ));
    }

    #[test]
    fn session_hierarchy_delete_rolls_back_transaction_time_structure_changes() {
        let _sandbox = test_helpers::test_env::sandbox();
        ensure_test_schemas();
        let root = "hierarchy-trigger-change-root";
        let worker = "hierarchy-trigger-change-worker";
        let injected = "hierarchy-trigger-change-injected";
        seed_session(root, None);
        seed_session(worker, Some(root));
        seed_run("hierarchy-trigger-change-run", root);

        let conn = get_connection().expect("sandbox DB");
        let plan = load_agent_org_session_delete_plan(&conn, root)
            .expect("plan hierarchy")
            .expect("root owns run");
        conn.execute_batch(
            "CREATE TRIGGER hierarchy_delete_insert_child
             AFTER DELETE ON agent_sessions
             WHEN OLD.session_id='hierarchy-trigger-change-root'
             BEGIN
                 INSERT INTO agent_sessions (
                     session_id, name, status, created_at, updated_at,
                     session_type, parent_session_id, workspace_additional_json,
                     key_source
                 ) VALUES (
                     'hierarchy-trigger-change-injected',
                     'injected',
                     'idle',
                     '2026-07-16T00:00:00Z',
                     '2026-07-16T00:00:00Z',
                     'agent',
                     'hierarchy-trigger-change-root',
                     '{}',
                     'own_key'
                 );
             END;",
        )
        .expect("install mutation trigger");
        drop(conn);

        let error = delete_agent_org_session_hierarchy(&plan, &HashSet::new())
            .expect_err("transaction-time hierarchy mutation must abort");
        assert!(error.contains("residual session hierarchy row"));
        assert!(row_exists("agent_sessions", "session_id", root));
        assert!(row_exists("agent_sessions", "session_id", worker));
        assert!(!row_exists("agent_sessions", "session_id", injected));
        assert!(row_exists(
            "agent_org_runs",
            "id",
            "hierarchy-trigger-change-run"
        ));
    }

    #[tokio::test]
    async fn session_hierarchy_delete_stops_active_runtime_and_discards_pending_work() {
        let _sandbox = test_helpers::test_env::sandbox();
        ensure_test_schemas();
        let root = "hierarchy-runtime-root";
        let state = AgentAppState::new();
        let root_runtime = std::sync::Arc::new(crate::state::AgentSession::new(
            root.to_string(),
            crate::definitions::AgentDefinition::default(),
        ));
        let turn_started = std::sync::Arc::new(tokio::sync::Notify::new());
        let turn_started_for_job = std::sync::Arc::clone(&turn_started);
        let runtime_for_job = std::sync::Arc::clone(&root_runtime);
        root_runtime
            .scheduler
            .enqueue(crate::session::ScheduledMessage {
                kind: crate::session::ScheduledKind::Turn,
                message_id: "hierarchy-runtime-processing".to_string(),
                generation: 0,
                client_message_id: None,
                turn_intent_id: "hierarchy-runtime-processing-intent".to_string(),
                org_run_id: Some("hierarchy-runtime-run".to_string()),
                content: String::new(),
                execute: Box::new(move || {
                    let runtime = std::sync::Arc::clone(&runtime_for_job);
                    let started = std::sync::Arc::clone(&turn_started_for_job);
                    Box::pin(async move {
                        runtime.begin_turn("still running".to_string()).await;
                        started.notify_one();
                        while !runtime
                            .cancel_flag
                            .load(std::sync::atomic::Ordering::SeqCst)
                        {
                            tokio::task::yield_now().await;
                        }
                        runtime
                            .end_turn(
                                crate::session::DialogTurnState::Cancelled,
                                crate::session::TurnStats::default(),
                            )
                            .await;
                        Err("cancelled for hierarchy deletion".to_string())
                    })
                }),
            })
            .await
            .expect("enqueue processing work");
        tokio::time::timeout(std::time::Duration::from_secs(1), turn_started.notified())
            .await
            .expect("turn starts processing");
        let pending_executed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let pending_executed_for_job = std::sync::Arc::clone(&pending_executed);
        root_runtime
            .scheduler
            .enqueue(crate::session::ScheduledMessage {
                kind: crate::session::ScheduledKind::Turn,
                message_id: "hierarchy-runtime-pending".to_string(),
                generation: 0,
                client_message_id: None,
                turn_intent_id: "hierarchy-runtime-pending-intent".to_string(),
                org_run_id: Some("hierarchy-runtime-run".to_string()),
                content: String::new(),
                execute: Box::new(move || {
                    let executed = std::sync::Arc::clone(&pending_executed_for_job);
                    Box::pin(async move {
                        executed.store(true, std::sync::atomic::Ordering::SeqCst);
                        Ok(String::new())
                    })
                }),
            })
            .await
            .expect("enqueue pending work");
        state
            .sessions
            .lock()
            .await
            .insert(root.to_string(), std::sync::Arc::clone(&root_runtime));
        let plan = AgentOrgSessionDeletePlan {
            run_id: "hierarchy-runtime-run".to_string(),
            root_session_id: root.to_string(),
            run_status: crate::coordination::agent_org_runs::AgentOrgRunStatus::Cancelled,
            sessions: vec![AgentOrgSessionDeleteNode {
                session_id: root.to_string(),
                parent_session_id: None,
                status: SessionStatus::Running,
                depth: 0,
            }],
        };

        let quiesced = stop_agent_org_runtime_sessions_with_timeout(
            &state,
            &plan,
            std::time::Duration::from_secs(1),
        )
        .await
        .expect("active Rust runtime stops");
        assert_eq!(quiesced, HashSet::from([root.to_string()]));
        assert_eq!(root_runtime.scheduler.pending_count(), 0);
        assert!(!root_runtime.scheduler.is_processing());
        assert!(root_runtime.active_turn.lock().await.is_none());
        assert!(!pending_executed.load(std::sync::atomic::Ordering::SeqCst));
        validate_agent_org_delete_ready(&plan, &quiesced)
            .expect("quiesced active status is safe behind cancelled fence");
    }

    #[tokio::test]
    async fn session_hierarchy_delete_times_out_without_removing_runtime() {
        let _sandbox = test_helpers::test_env::sandbox();
        ensure_test_schemas();
        let root = "hierarchy-runtime-timeout-root";
        let state = AgentAppState::new();
        let runtime = std::sync::Arc::new(crate::state::AgentSession::new(
            root.to_string(),
            crate::definitions::AgentDefinition::default(),
        ));
        let release = std::sync::Arc::new(tokio::sync::Notify::new());
        let release_for_job = std::sync::Arc::clone(&release);
        runtime
            .scheduler
            .enqueue(crate::session::ScheduledMessage {
                kind: crate::session::ScheduledKind::Maintenance,
                message_id: "hierarchy-runtime-timeout".to_string(),
                generation: 0,
                client_message_id: None,
                turn_intent_id: "hierarchy-runtime-timeout-intent".to_string(),
                org_run_id: Some("hierarchy-runtime-timeout-run".to_string()),
                content: String::new(),
                execute: Box::new(move || {
                    let release = std::sync::Arc::clone(&release_for_job);
                    Box::pin(async move {
                        release.notified().await;
                        Ok(String::new())
                    })
                }),
            })
            .await
            .expect("enqueue non-cooperative maintenance");
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while !runtime.scheduler.is_processing() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("maintenance starts");
        state
            .sessions
            .lock()
            .await
            .insert(root.to_string(), std::sync::Arc::clone(&runtime));
        let plan = AgentOrgSessionDeletePlan {
            run_id: "hierarchy-runtime-timeout-run".to_string(),
            root_session_id: root.to_string(),
            run_status: crate::coordination::agent_org_runs::AgentOrgRunStatus::Cancelled,
            sessions: vec![AgentOrgSessionDeleteNode {
                session_id: root.to_string(),
                parent_session_id: None,
                status: SessionStatus::Running,
                depth: 0,
            }],
        };

        let error = stop_agent_org_runtime_sessions_with_timeout(
            &state,
            &plan,
            std::time::Duration::from_millis(50),
        )
        .await
        .expect_err("non-cooperative work must time out");
        assert!(error.contains("Timed out stopping"));
        assert!(error.contains(root));
        assert!(state.get_session(root).await.is_some());
        release.notify_one();
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while runtime.scheduler.is_processing() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("maintenance finishes after the timeout assertion");
    }
}
