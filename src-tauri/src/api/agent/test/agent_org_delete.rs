//! Debug-only fixtures for Agent Org conversation deletion.
//!
//! The SQL fault is deliberately narrow: one fixed trigger and one exact root
//! session carrying the reserved E2E prefix. The E2E runner explicitly
//! disarms it immediately after the faulted production deletion attempt and
//! again during fixture cleanup.

use std::collections::HashSet;

use agent_core::coordination::agent_org_plan_approvals::AgentOrgPlanApprovalStore;
use axum::Json;
use rusqlite::{params, Connection, OptionalExtension};

const E2E_FIXTURE_PREFIX: &str = "e2e-agent-org-fixture:";
const SIDEBAR_FIXTURE_PREFIX: &str = "sdeagent-e2e-delete-";
const MAX_FIXTURE_IDS: usize = 16;
const MAX_FIXTURE_ID_BYTES: usize = 256;
const DELETE_FAULT_TABLE: &str = "e2e_agent_org_session_delete_fault";
const DELETE_FAULT_TRIGGER: &str = "e2e_agent_org_session_delete_abort";
const DELETE_FAULT_ERROR: &str = "e2e_agent_org_session_delete_fault";
type FixtureError = Box<dyn std::error::Error + Send + Sync>;
type FixtureResult<T> = Result<T, FixtureError>;

#[derive(serde::Deserialize)]
pub struct RelatedFixtureRequest {
    root_session_id: String,
    runs: Vec<RelatedRunRequest>,
    root_final_status: Option<String>,
}

#[derive(serde::Deserialize)]
struct RelatedRunRequest {
    org_run_id: String,
    worker_session_id: String,
    member_id: String,
    final_status: Option<String>,
}

#[derive(serde::Deserialize)]
pub struct SessionRequest {
    #[serde(alias = "root_session_id")]
    session_id: String,
}

#[derive(serde::Deserialize)]
pub struct SupportSnapshotRequest {
    root_session_id: String,
    run_ids: Vec<String>,
    session_ids: Vec<String>,
}

fn validate_fixture_session_id(session_id: &str) -> FixtureResult<()> {
    if !session_id.starts_with(E2E_FIXTURE_PREFIX)
        && !session_id.starts_with(SIDEBAR_FIXTURE_PREFIX)
    {
        return Err(format!(
            "session_id must start with {E2E_FIXTURE_PREFIX:?} or {SIDEBAR_FIXTURE_PREFIX:?}"
        )
        .into());
    }
    let safe = session_id
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'_' | b'-' | b'.'));
    if session_id.len() > MAX_FIXTURE_ID_BYTES || !safe {
        return Err("session_id contains unsafe characters or is too long".into());
    }
    Ok(())
}

fn validate_fixture_id_list(
    ids: &[String],
    kind: &str,
    require_fixture_prefix: bool,
) -> FixtureResult<()> {
    if ids.is_empty() || ids.len() > MAX_FIXTURE_IDS {
        return Err(format!("{kind} must contain between 1 and {MAX_FIXTURE_IDS} items").into());
    }
    let mut unique = HashSet::new();
    for id in ids {
        if require_fixture_prefix {
            validate_fixture_session_id(id)?;
        } else {
            let safe = id.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'_' | b'-' | b'.')
            });
            if id.is_empty() || id.len() > MAX_FIXTURE_ID_BYTES || !safe {
                return Err(format!("{kind} contains an unsafe ID").into());
            }
        }
        if !unique.insert(id) {
            return Err(format!("{kind} must not contain duplicate IDs").into());
        }
    }
    Ok(())
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> FixtureResult<T> + Send + 'static,
) -> FixtureResult<T> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(FixtureError::from)?
}

async fn blocking_json(
    work: impl FnOnce() -> FixtureResult<serde_json::Value> + Send + 'static,
) -> Json<serde_json::Value> {
    match blocking(work).await {
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error.to_string() })),
        Ok(value) => Json(value),
    }
}

struct RelatedFixtureRun {
    run_id: String,
    worker_session_id: String,
    member_id: String,
    status: String,
}

fn load_related_fixture_runs(
    root_session_id: &str,
    requested: Vec<RelatedRunRequest>,
) -> FixtureResult<Vec<RelatedFixtureRun>> {
    let conn = database::db::get_connection()?;
    let mut seen_runs = HashSet::new();
    let mut seen_workers = HashSet::new();
    requested
        .into_iter()
        .map(|request| {
            let RelatedRunRequest {
                org_run_id: run_id,
                worker_session_id,
                member_id,
                final_status,
            } = request;
            if !seen_runs.insert(run_id.clone()) || !seen_workers.insert(worker_session_id.clone())
            {
                return Err("runs must not repeat a run or worker session".into());
            }
            validate_fixture_session_id(&worker_session_id)?;
            let persisted_status = conn
                .query_row(
                    "SELECT runs.status FROM agent_org_runs runs JOIN agent_org_run_sessions sessions ON sessions.org_run_id=runs.id WHERE runs.id=?1 AND runs.root_session_id=?2 AND runs.org_id LIKE ?3 AND sessions.session_id=?4 AND sessions.member_id=?5 AND sessions.role='worker'",
                    params![
                        run_id,
                        root_session_id,
                        format!("{E2E_FIXTURE_PREFIX}%"),
                        worker_session_id,
                        member_id,
                    ],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
                .ok_or("run and worker are not an exact E2E ownership fixture")?;
            let status = match final_status.as_deref() {
                None => persisted_status,
                Some("completed") => "completed".to_string(),
                Some(_) => return Err("final_status may only be completed".into()),
            };
            Ok(RelatedFixtureRun {
                run_id,
                worker_session_id,
                member_id,
                status,
            })
        })
        .collect()
}

fn seed_related_rows(
    root_session_id: &str,
    fixture_runs: &[RelatedFixtureRun],
    root_final_status: Option<&str>,
) -> FixtureResult<()> {
    database::db::with_sessions_writer(|| -> FixtureResult<()> {
        let mut conn = database::db::get_connection()?;
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let now = chrono::Utc::now().to_rfc3339();
        for (index, fixture) in fixture_runs.iter().enumerate() {
            let suffix = uuid::Uuid::new_v4();
            let task_id = format!("e2e-delete-task-{suffix}");
            let plan_path = AgentOrgPlanApprovalStore::managed_plan_path_for_session(
                &fixture.worker_session_id,
                &format!("e2e-delete-{index}.plan.md"),
            )?
            .to_string_lossy()
            .into_owned();
            let completed = fixture.status == "completed";
            let task_status = if completed { "completed" } else { "pending" };
            tx.execute(
                "INSERT INTO agent_org_tasks (id,org_run_id,subject,owner,status,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?6)",
                params![
                    task_id,
                    fixture.run_id,
                    format!("Multi-run delete fixture {index}"),
                    fixture.member_id,
                    task_status,
                    now,
                ],
            )?;
            tx.execute(
                "INSERT INTO agent_org_task_events (id,org_run_id,task_id,event_type,next_owner,next_status,actor_member_id,created_at) VALUES (?1,?2,?3,'created',?4,?5,'coordinator',?6)",
                params![
                    format!("e2e-delete-task-event-{suffix}"),
                    fixture.run_id,
                    task_id,
                    fixture.member_id,
                    task_status,
                    now,
                ],
            )?;
            tx.execute(
                "INSERT INTO agent_inbox (recipient_agent_id,recipient_member_id,sender_agent_id,org_run_id,payload_kind,payload_json,created_at,display_text) VALUES ('builtin:explore',?1,'system',?2,'plain',?3,?4,'E2E deletion fixture')",
                params![
                    fixture.member_id,
                    fixture.run_id,
                    r#"{"kind":"plain","summary":"E2E deletion fixture","text":"Delete atomically."}"#,
                    now,
                ],
            )?;
            let approval_status = if completed { "approved" } else { "pending" };
            let resolved_at = completed.then_some(now.as_str());
            tx.execute(
                "INSERT INTO agent_org_plan_approvals (approval_id,plan_revision_id,request_id,org_run_id,source_task_id,source_member_id,source_session_id,root_session_id,policy,status,plan_title,plan_path,plan_content,decision_by,feedback,created_at,resolved_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'coordinator',?9,'E2E deletion fixture',?10,'# E2E deletion fixture',?11,NULL,?12,?13)",
                params![
                    format!("e2e-delete-approval-{suffix}"),
                    format!("e2e-delete-revision-{suffix}"),
                    format!("e2e-delete-request-{suffix}"),
                    fixture.run_id, task_id, fixture.member_id, fixture.worker_session_id,
                    root_session_id, approval_status, plan_path,
                    completed.then_some("system"),
                    now, resolved_at,
                ],
            )?;
            tx.execute(
                "UPDATE agent_org_run_progress SET work_revision=?2,coordinator_presented_work_revision=?2,coordinator_observed_work_revision=?2,completion_requested=?3,completion_requested_at=?4,completion_requested_work_revision=?5,completion_summary=?6,updated_at=?7 WHERE org_run_id=?1",
                params![
                    fixture.run_id,
                    (index + 1) as i64,
                    i64::from(completed),
                    resolved_at,
                    resolved_at.map(|_| (index + 1) as i64),
                    resolved_at.map(|_| "E2E historical completion"),
                    now,
                ],
            )?;
            tx.execute(
                "UPDATE agent_org_runs SET status=?2,updated_at=?3 WHERE id=?1",
                params![fixture.run_id, fixture.status, now],
            )?;
            if completed {
                tx.execute(
                    "UPDATE agent_sessions
                     SET status='completed',updated_at=?2
                     WHERE session_id IN (
                         SELECT session_id FROM agent_org_run_sessions
                         WHERE org_run_id=?1 AND role='worker'
                     )",
                    params![fixture.run_id, now],
                )?;
            }
            for (session_id, kind, run_id) in [
                (root_session_id, "run", Some(fixture.run_id.as_str())),
                (fixture.worker_session_id.as_str(), "session", None),
            ] {
                tx.execute(
                    "INSERT INTO session_turn_intents (session_id,turn_intent_id,client_message_id,org_run_id,source,status,created_at,updated_at) VALUES (?1,?2,NULL,?3,'agent_org','completed',?4,?4)",
                    params![
                        session_id,
                        format!("e2e-delete-{kind}-intent-{suffix}"),
                        run_id,
                        now
                    ],
                )?;
            }
        }
        match root_final_status {
            None => {}
            Some("completed") => {
                tx.execute(
                    "UPDATE agent_sessions SET status='completed',updated_at=?2 WHERE session_id=?1",
                    params![root_session_id, now],
                )?;
            }
            Some(_) => return Err("root_final_status may only be completed".into()),
        }
        Ok(tx.commit()?)
    })
}

pub async fn seed_related_handler(
    Json(body): Json<RelatedFixtureRequest>,
) -> Json<serde_json::Value> {
    blocking_json(move || {
        validate_fixture_session_id(&body.root_session_id)?;
        if body.runs.is_empty() || body.runs.len() > MAX_FIXTURE_IDS {
            return Err(format!("runs must contain between 1 and {MAX_FIXTURE_IDS} items").into());
        }
        let runs = load_related_fixture_runs(&body.root_session_id, body.runs)?;
        seed_related_rows(
            &body.root_session_id,
            &runs,
            body.root_final_status.as_deref(),
        )?;
        Ok(serde_json::json!({
            "ok": true,
            "seeded_run_count": runs.len(),
        }))
    })
    .await
}

fn validate_snapshot_run_ids(
    conn: &Connection,
    root_session_id: &str,
    run_ids: &[String],
) -> FixtureResult<()> {
    for run_id in run_ids {
        let owner = conn
            .query_row(
                "SELECT root_session_id,org_id FROM agent_org_runs WHERE id=?1",
                [run_id],
                |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;
        if owner.is_some_and(|(root, org_id)| {
            root.as_deref() != Some(root_session_id) || !org_id.starts_with(E2E_FIXTURE_PREFIX)
        }) {
            return Err("run_ids contains a run outside the exact E2E fixture root".into());
        }
    }
    Ok(())
}

fn count_run_rows(
    conn: &Connection,
    table: &str,
    predicate: &str,
    run_ids: &[String],
) -> FixtureResult<i64> {
    // Count by the exact reserved fixture IDs after ownership validation. A
    // join through agent_org_runs would hide orphan support rows after delete.
    let sql = format!(
        "SELECT COUNT(*) FROM {table} row
         WHERE row.org_run_id=?1 {predicate}"
    );
    let mut stmt = conn.prepare(&sql)?;
    run_ids.iter().try_fold(0_i64, |total, run_id| {
        let count = stmt.query_row([run_id], |row| row.get::<_, i64>(0))?;
        Ok(total + count)
    })
}

fn support_snapshot(body: SupportSnapshotRequest) -> FixtureResult<serde_json::Value> {
    validate_fixture_session_id(&body.root_session_id)?;
    validate_fixture_id_list(&body.run_ids, "run_ids", false)?;
    validate_fixture_id_list(&body.session_ids, "session_ids", true)?;
    if !body
        .session_ids
        .iter()
        .any(|id| id == &body.root_session_id)
    {
        return Err("session_ids must include root_session_id".into());
    }

    let conn = database::db::get_connection()?;
    validate_snapshot_run_ids(&conn, &body.root_session_id, &body.run_ids)?;
    let count =
        |table: &str, predicate: &str| count_run_rows(&conn, table, predicate, &body.run_ids);
    let session_turn_intents =
        body.session_ids
            .iter()
            .try_fold(0_i64, |total, session_id| -> FixtureResult<i64> {
                let count = conn.query_row(
                    "SELECT COUNT(*) FROM session_turn_intents
                 WHERE session_id=?1 AND org_run_id IS NULL",
                    [session_id],
                    |row| row.get::<_, i64>(0),
                )?;
                Ok(total + count)
            })?;
    let fence_count = conn.query_row(
        "SELECT COUNT(*) FROM agent_org_conversation_delete_fences
         WHERE root_session_id=?1",
        [&body.root_session_id],
        |row| row.get::<_, i64>(0),
    )?;

    Ok(serde_json::json!({
        "ok": true,
        "fence_count": fence_count,
        "support_counts": {
            "tasks": count("agent_org_tasks", "")?,
            "task_events": count("agent_org_task_events", "")?,
            "inbox": count("agent_inbox", "")?,
            "approvals": count("agent_org_plan_approvals", "")?,
            "run_progress": count("agent_org_run_progress", "")?,
            "finality_requests": count(
                "agent_org_run_progress",
                "AND row.completion_requested=1",
            )?,
            "run_turn_intents": count("session_turn_intents", "")?,
            "session_turn_intents": session_turn_intents,
        },
    }))
}

/// Inspect only rows reachable from reserved E2E fixture IDs. The production
/// deletion command remains the sole mutation path used by the runner.
pub async fn support_snapshot_handler(
    Json(body): Json<SupportSnapshotRequest>,
) -> Json<serde_json::Value> {
    blocking_json(move || support_snapshot(body)).await
}

fn arm_delete_fault(root_session_id: &str) -> FixtureResult<()> {
    validate_fixture_session_id(root_session_id)?;
    database::db::with_sessions_writer(|| -> FixtureResult<()> {
        let mut conn = database::db::get_connection()?;
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let eligible: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM agent_org_runs WHERE root_session_id=?1 AND org_id LIKE ?2)",
            params![root_session_id, format!("{E2E_FIXTURE_PREFIX}%")],
            |row| row.get(0),
        )?;
        if !eligible {
            return Err("fault target is not an exact persisted E2E Agent Org root".into());
        }
        tx.execute_batch(&format!(
            "CREATE TABLE IF NOT EXISTS {DELETE_FAULT_TABLE} (
                 root_session_id TEXT PRIMARY KEY
             );
             DROP TRIGGER IF EXISTS {DELETE_FAULT_TRIGGER};
             DELETE FROM {DELETE_FAULT_TABLE};"
        ))?;
        tx.execute(
            &format!("INSERT INTO {DELETE_FAULT_TABLE} (root_session_id) VALUES (?1)"),
            [root_session_id],
        )?;
        tx.execute_batch(&format!(
            "CREATE TRIGGER {DELETE_FAULT_TRIGGER}
             BEFORE DELETE ON agent_sessions
             WHEN EXISTS (
                 SELECT 1 FROM {DELETE_FAULT_TABLE}
                 WHERE root_session_id=OLD.session_id
             )
             BEGIN
                 SELECT RAISE(ABORT, '{DELETE_FAULT_ERROR}');
             END;"
        ))?;
        Ok(tx.commit()?)
    })
}

fn disarm_delete_fault() -> FixtureResult<()> {
    database::db::with_sessions_writer(|| -> FixtureResult<()> {
        let conn = database::db::get_connection()?;
        Ok(conn.execute_batch(&format!(
            "DROP TRIGGER IF EXISTS {DELETE_FAULT_TRIGGER};
             DROP TABLE IF EXISTS {DELETE_FAULT_TABLE};"
        ))?)
    })
}

pub async fn arm_fault_handler(Json(body): Json<SessionRequest>) -> Json<serde_json::Value> {
    blocking_json(move || {
        arm_delete_fault(&body.session_id)?;
        Ok(serde_json::json!({ "ok": true }))
    })
    .await
}

/// Idempotent runner cleanup for an interrupted fault scenario.
pub async fn disarm_fault_handler() -> Json<serde_json::Value> {
    blocking_json(|| {
        disarm_delete_fault()?;
        Ok(serde_json::json!({ "ok": true }))
    })
    .await
}
